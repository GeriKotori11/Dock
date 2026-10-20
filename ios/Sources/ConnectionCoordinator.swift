import UIKit
import WebKit

/// Live status of a paired computer in the hub and the switch sheet.
enum RowStatus: Equatable {
    case checking
    case online(address: String)
    case notFound(address: String)
    case securityChanged
    case needsPin
}

/// A computer discovery found and `/health` verified (a hint until it matches a pin).
struct VerifiedHost: Equatable {
    let hostId: String
    let hostName: String
    let platform: String
    let endpoint: URL
    let presented: String?
    let serviceKey: String
    var goneSince: Date?

    var displayName: String { Computer.displayName(nickname: nil, hostName: hostName) }
    var address: String { endpoint.host ?? "" }

    var probeResult: ProbeResult {
        ProbeResult(info: HealthInfo(hostId: hostId, hostName: hostName, tlsFingerprint: presented, platform: platform),
                    presentedFingerprint: presented, failure: nil, endpoint: endpoint)
    }
}

/// What the pairing screens need about the computer being paired.
struct PairingContext {
    var hostId: String?
    var hostName: String
    var platform: String
    var endpoint: URL
    /// The certificate the handshake presented (the one to pin); nil over plain http.
    var presented: String?
    var pairingOpen: Bool
    /// Step 1 is already done (session revoked, or "Needs a new PIN").
    var revoked: Bool
    var existing: Computer?

    var displayName: String {
        existing?.displayName ?? Computer.displayName(nickname: nil, hostName: hostName)
    }
    var hasSecurityStep: Bool { presented != nil && !revoked }
}

/// The state machine of spec section 3: launch, connecting, dock, hub, problems, pairing.
final class ConnectionCoordinator {
    let store: ComputerStore
    let pins: PinStore
    let discovery: DiscoverySource
    let network: NetworkStatus
    let cookieStore: WKHTTPCookieStore
    weak var root: RootViewController?
    /// The current attempt's probes (cancelled with it), and independent pools for the rest.
    private let probes = ProbePool()
    private let discoveryProbes = ProbePool()
    private let statusProbes = ProbePool()
    private let actionProbes = ProbePool()

    // Discovery
    private var services: [String: DiscoveredService] = [:]
    private var serviceHosts: [String: String] = [:]
    private var resolving: Set<String> = []
    private(set) var verified: [String: VerifiedHost] = [:]
    private(set) var discoveryState: DiscoveryState = .idle
    private(set) var discoveryStartedAt: Date?
    private var discoveryRunning = false

    // Status
    private(set) var statuses: [String: RowStatus] = [:]
    private var changedCertificates: [String: String] = [:]
    var needsPin: Set<String> = []
    /// Called whenever statuses or discovered computers change (hub and sheet refresh).
    var onChange: (() -> Void)?
    static let didChange = Notification.Name("WinDockCoordinatorDidChange")

    private func changed() {
        onChange?()
        NotificationCenter.default.post(name: Self.didChange, object: self)
    }

    // The current connection attempt and the live dock.
    private final class Attempt {
        let id = UUID()
        var computer: Computer
        let switching: Bool
        let startedAt = Date()
        var lastFailure: ProbeFailure?
        var answered = false
        var failing = false
        var retryCount = 0
        var movedAt: Date?
        init(_ computer: Computer, switching: Bool) { self.computer = computer; self.switching = switching }
    }

    private var attempt: Attempt?
    private(set) var current: Computer?
    private(set) var dock: DockViewController?
    private var connecting: ConnectingViewController?
    private var problem: ProblemViewController?
    private var lastProblem: ProblemViewController.Problem?

    /// Device name sent with the PIN.
    var deviceName = PairingAPI.deviceName(isPad: UIDevice.current.userInterfaceIdiom == .pad)
    /// Test hosts and older code paths may turn discovery off.
    var discoveryEnabled = true

    init(store: ComputerStore, pins: PinStore, discovery: DiscoverySource = BonjourDiscovery(),
         network: NetworkStatus = NetworkStatus(), cookieStore: WKHTTPCookieStore = WKWebsiteDataStore.default().httpCookieStore) {
        self.store = store
        self.pins = pins
        self.discovery = discovery
        self.network = network
        self.cookieStore = cookieStore
        discovery.onResults = { [weak self] in self?.discoveryResults($0) }
        discovery.onState = { [weak self] in self?.discoveryStateChanged($0) }
        network.onChange = { [weak self] usable in self?.networkChanged(usable) }
    }

    // MARK: Launch

    func start() {
        switch store.migrationPlan(pins: pins) {
        case .immediate(let computer):
            store.completeMigration(with: computer)
            proceedAfterLaunch()
        case .probe(let endpoint):
            migrate(endpoint)
        case .none:
            proceedAfterLaunch()
        }
    }

    private func migrate(_ endpoint: URL) {
        let deadline = DispatchWorkItem { [weak self] in self?.root?.showConnectingPlaceholder() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: deadline)
        actionProbes.probeSecureFirst(endpoint, timeout: 5, allowPlain: true) { [weak self] result in
            deadline.cancel()
            guard let self else { return }
            if let computer = self.migratedComputer(result) {
                self.store.completeMigration(with: computer)
            }
            // Unreachable: keep the remembered address and try again on the next launch.
            self.proceedAfterLaunch()
        }
    }

    private func migratedComputer(_ result: ProbeResult) -> Computer? {
        guard let info = result.info, let endpoint = result.endpoint else { return nil }
        let now = Date()
        let platform = Computer.normalizedPlatform(info.platform)
        if let hostId = info.hostId?.lowercased(), PinStore.isValidHostId(hostId) {
            // A certificate other than the pinned one is kept too: opening it shows S10.
            return Computer(hostId: hostId, hostName: info.hostName, nickname: nil, platform: platform,
                            endpoint: endpoint, lastConnectedAt: now, addedAt: now, localId: nil)
        }
        guard endpoint.scheme == "http", info.tlsFingerprint == nil else { return nil }
        return Computer(hostId: UUID().uuidString.lowercased(), hostName: info.hostName, nickname: nil, platform: platform,
                        endpoint: endpoint, lastConnectedAt: now, addedAt: now, localId: true)
    }

    private func proceedAfterLaunch() {
        if let last = store.last {
            startDiscovery()
            open(last, switching: false)
        } else {
            if store.localNetworkPrimed { startDiscovery() }
            showHub(overDock: false)
        }
    }

    // MARK: Discovery

    func startDiscovery() {
        guard discoveryEnabled, !discoveryRunning else { return }
        discoveryRunning = true
        discoveryStartedAt = Date()
        discovery.start()
        changed()
    }

    func restartDiscovery() {
        guard discoveryEnabled else { return }
        discovery.stop()
        discoveryRunning = false
        startDiscovery()
    }

    /// Called from the priming screen's Continue: this is what triggers the system prompt.
    func primeLocalNetwork() {
        store.localNetworkPrimed = true
        startDiscovery()
    }

    var isSearching: Bool { discoveryRunning && discoveryState != .denied }

    private func discoveryStateChanged(_ state: DiscoveryState) {
        discoveryState = state
        if state == .denied { localNetworkDenied() }
        if state == .browsing, lastProblem == .localNetworkOff { resumeAfterLocalNetwork() }
        changed()
    }

    private func discoveryResults(_ results: [DiscoveredService]) {
        let keys = Set(results.map(\.key))
        for service in results {
            let previous = services[service.key]
            services[service.key] = service
            if let hostId = serviceHosts[service.key], previous?.txt == service.txt, verified[hostId] != nil {
                verified[hostId]?.goneSince = nil
                continue
            }
            verify(service)
        }
        for (key, _) in services where !keys.contains(key) {
            services[key] = nil
            if let hostId = serviceHosts[key] {
                verified[hostId]?.goneSince = Date()
                DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
                    guard let self, let host = self.verified[hostId], let gone = host.goneSince,
                          Date().timeIntervalSince(gone) >= 9.9 else { return }
                    self.verified[hostId] = nil
                    self.serviceHosts[key] = nil
                    self.changed()
                }
            }
        }
        changed()
    }

    /// Resolves and probes one service; only a WinDock `/health` answer makes it a row.
    private func verify(_ service: DiscoveredService) {
        guard !resolving.contains(service.key) else { return }
        resolving.insert(service.key)
        discovery.resolve(service) { [weak self] base in
            guard let self else { return }
            guard let base else { self.resolving.remove(service.key); return }
            self.discoveryProbes.probeSecureFirst(base, timeout: 4, allowPlain: service.txt.tls != true) { [weak self] result in
                guard let self else { return }
                self.resolving.remove(service.key)
                guard self.services[service.key] != nil, let info = result.info, let endpoint = result.endpoint,
                      let hostId = info.hostId?.lowercased(), PinStore.isValidHostId(hostId) else { return }
                let host = VerifiedHost(hostId: hostId, hostName: info.hostName, platform: Computer.normalizedPlatform(info.platform),
                                        endpoint: endpoint, presented: result.presentedFingerprint, serviceKey: service.key, goneSince: nil)
                self.serviceHosts[service.key] = hostId
                self.verified[hostId] = host
                self.hostVerified(host, result: result)
                self.changed()
            }
        }
    }

    private func hostVerified(_ host: VerifiedHost, result: ProbeResult) {
        guard let saved = store.computer(host.hostId) else { return }
        switch ConnectionRules.evaluate(saved, pinned: pins.pin(for: host.hostId), result: result) {
        case .accept:
            statuses[host.hostId] = needsPin.contains(host.hostId) ? .needsPin : .online(address: host.address)
        case .mismatch(let presented):
            changedCertificates[host.hostId] = presented
            statuses[host.hostId] = .securityChanged
        default: break
        }
        if let attempt, !attempt.answered, attempt.computer.hostId == host.hostId {
            identityAnswer(attempt, result: result)
        }
    }

    /// Discovered computers that are not paired, in name order.
    var discovered: [VerifiedHost] {
        verified.values.filter { store.computer($0.hostId) == nil }.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    var discoverySawAny: Bool { !verified.isEmpty || !services.isEmpty }

    // MARK: Statuses

    func status(for computer: Computer) -> RowStatus {
        if needsPin.contains(computer.hostId) { return .needsPin }
        return statuses[computer.hostId] ?? .checking
    }

    func changedFingerprint(_ hostId: String) -> String? { changedCertificates[hostId] }

    /// Probes every paired computer's saved endpoint (hub and sheet open).
    func refreshStatuses() {
        for computer in store.computers {
            if needsPin.contains(computer.hostId) { continue }
            if current?.hostId == computer.hostId, dock?.isReady == true {
                statuses[computer.hostId] = .online(address: computer.address); continue
            }
            if statuses[computer.hostId] != .securityChanged { statuses[computer.hostId] = .checking }
            statusProbes.probeSecureFirst(computer.endpoint, timeout: 2.5, allowPlain: allowsPlain(computer)) { [weak self] result in
                guard let self, let saved = self.store.computer(computer.hostId), !self.needsPin.contains(saved.hostId) else { return }
                let pinned = self.pins.pin(for: saved.hostId)
                switch ConnectionRules.evaluate(saved, pinned: pinned, result: result) {
                case .accept:
                    self.changedCertificates[saved.hostId] = nil
                    self.statuses[saved.hostId] = .online(address: saved.address)
                case .mismatch(let presented):
                    self.changedCertificates[saved.hostId] = presented
                    self.statuses[saved.hostId] = .securityChanged
                default:
                    if self.changedCertificates[saved.hostId] != nil {
                        self.statuses[saved.hostId] = .securityChanged
                    } else if let host = self.verified[saved.hostId], host.goneSince == nil,
                              case .accept = ConnectionRules.evaluate(saved, pinned: pinned, result: host.probeResult) {
                        self.statuses[saved.hostId] = .online(address: host.address)
                    } else {
                        self.statuses[saved.hostId] = .notFound(address: saved.address)
                    }
                }
                self.changed()
            }
        }
        changed()
    }

    private func allowsPlain(_ computer: Computer) -> Bool {
        computer.endpoint.scheme == "http" && pins.pin(for: computer.hostId) == nil
    }

    // MARK: Opening a computer

    /// Launch (`switching` false: nothing for 400 ms) or a switch / tap (S1 at once).
    func open(_ computer: Computer, switching: Bool) {
        cancelAttempt()
        let attempt = Attempt(computer, switching: switching)
        self.attempt = attempt
        startDiscovery()
        let id = attempt.id
        let connecting = ConnectingViewController(name: computer.displayName)
        connecting.onChooseAnother = { [weak self] in self?.chooseAnother() }
        self.connecting = connecting
        if switching || dock != nil || root?.hasScreen == true {
            root?.dismissModals(animated: false)
            root?.show(connecting, fade: dock != nil ? 0.16 : 0.2)
            // The old dock goes once S1 covers it (the new attempt may replace it sooner).
            if let old = dock {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.17) { [weak self, weak old] in
                    guard let self, let old, self.dock === old, !(old.isReady && self.attempt == nil) else { return }
                    self.tearDownDock()
                }
            }
        } else {
            root?.showBlank()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                guard let self, self.attempt?.id == id, self.dock?.isReady != true else { return }
                self.root?.show(connecting, fade: 0.18)
            }
        }
        directProbe(attempt)
        // The identity track: anything discovery already verified for this host ID.
        if let host = verified[computer.hostId] { identityAnswer(attempt, result: host.probeResult) }
        for (key, service) in services where service.txt.id == computer.hostId || service.txt.id == nil {
            if serviceHosts[key] == nil || serviceHosts[key] == computer.hostId { verify(service) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self, let attempt = self.attempt, attempt.id == id, !attempt.answered else { return }
            self.enterUnreachable(attempt)
        }
    }

    private func directProbe(_ attempt: Attempt) {
        let id = attempt.id
        let computer = attempt.computer
        probes.probeSecureFirst(computer.endpoint, timeout: 2.5, allowPlain: allowsPlain(computer)) { [weak self] result in
            guard let self, let attempt = self.attempt, attempt.id == id, !attempt.answered else { return }
            self.directAnswer(attempt, result: result)
        }
    }

    private func directAnswer(_ attempt: Attempt, result: ProbeResult) {
        let computer = attempt.computer
        switch ConnectionRules.evaluate(computer, pinned: pins.pin(for: computer.hostId), result: result) {
        case .accept(let fingerprint):
            refreshIdentity(attempt, result: result)
            connect(attempt, endpoint: result.endpoint ?? computer.endpoint, fingerprint: fingerprint)
        case .mismatch(let presented):
            attempt.answered = true
            showSecurityChanged(computer, presented: presented)
        case .needsPairing(let presented):
            attempt.answered = true
            beginPairing(context(for: computer, result: result, presented: presented, revoked: false))
        case .otherComputer:
            attempt.lastFailure = .other
            directFailed(attempt)
        case .noAnswer(let failure):
            attempt.lastFailure = failure
            directFailed(attempt)
        }
    }

    private func directFailed(_ attempt: Attempt) {
        if attempt.failing {
            scheduleRetry(attempt)
        } else if discoveryRunning {
            connecting?.setStatus(.looking(attempt.computer.displayName))
        }
    }

    private func identityAnswer(_ attempt: Attempt, result: ProbeResult) {
        let computer = attempt.computer
        guard let endpoint = result.endpoint else { return }
        switch ConnectionRules.evaluate(computer, pinned: pins.pin(for: computer.hostId), result: result) {
        case .accept(let fingerprint):
            refreshIdentity(attempt, result: result)
            if ConnectionRules.moved(computer, to: endpoint) {
                relocate(attempt, to: endpoint, fingerprint: fingerprint)
            } else {
                connect(attempt, endpoint: endpoint, fingerprint: fingerprint)
            }
        case .mismatch(let presented):
            attempt.answered = true
            showSecurityChanged(computer, presented: presented)
        default:
            break
        }
    }

    /// Host name and platform are refreshed on every verified contact.
    private func refreshIdentity(_ attempt: Attempt, result: ProbeResult) {
        guard let info = result.info, !attempt.computer.isLegacy else { return }
        let platform = Computer.normalizedPlatform(info.platform)
        store.update(attempt.computer.hostId) { computer in
            if !info.hostName.isEmpty { computer.hostName = info.hostName }
            if !platform.isEmpty { computer.platform = platform }
        }
        if let updated = store.computer(attempt.computer.hostId) {
            attempt.computer = updated
            connecting?.setName(updated.displayName)
        }
    }

    /// Found by identity and pinned certificate at a new address: no PIN, one status line.
    private func relocate(_ attempt: Attempt, to endpoint: URL, fingerprint: String?) {
        attempt.answered = true
        let id = attempt.id
        let oldHost = attempt.computer.endpoint.host ?? ""
        let newHost = endpoint.host ?? ""
        SessionCookies.copySession(from: oldHost, to: newHost, in: cookieStore) { [weak self] _ in
            guard let self, let attempt = self.attempt, attempt.id == id else { return }
            self.store.update(attempt.computer.hostId) { $0.endpoint = endpoint }
            attempt.computer.endpoint = endpoint
            attempt.movedAt = Date()
            if let connecting = self.connecting, self.root?.currentScreen !== connecting {
                self.root?.show(connecting, fade: 0.18)
            }
            self.connecting?.setStatus(.moved(newHost))
            self.connect(attempt, endpoint: endpoint, fingerprint: fingerprint)
        }
    }

    private func connect(_ attempt: Attempt, endpoint: URL, fingerprint: String?) {
        attempt.answered = true
        let id = attempt.id
        let computer = attempt.computer
        tearDownDock()
        let dock = DockViewController(endpoint: endpoint, trustedFingerprint: fingerprint, computerName: computer.displayName)
        self.dock = dock
        current = computer
        wire(dock)
        dock.onReady = { [weak self] in
            guard let self, let attempt = self.attempt, attempt.id == id else { return }
            self.connected(attempt, endpoint: endpoint)
        }
        root?.installDock(dock)
        dock.start()
    }

    private func wire(_ dock: DockViewController) {
        dock.onFailure = { [weak self, weak dock] failure in
            guard let self, let dock, dock === self.dock else { return }
            self.dockFailed(failure)
        }
        dock.onBridge = { [weak self, weak dock] message in
            guard let self, let dock, dock === self.dock else { return }
            self.bridge(message)
        }
        dock.onLegacyReconnect = { [weak self] in
            guard let self, let current = self.current else { return }
            self.open(current, switching: true)
        }
        dock.onLegacySwitch = { [weak self] in self?.presentSwitchSheet() }
    }

    private func connected(_ attempt: Attempt, endpoint: URL) {
        let hostId = attempt.computer.hostId
        store.update(hostId) {
            $0.lastConnectedAt = Date()
            $0.endpoint = endpoint
        }
        current = store.computer(hostId) ?? attempt.computer
        statuses[hostId] = .online(address: endpoint.host ?? "")
        needsPin.remove(hostId)
        self.attempt = nil
        lastProblem = nil
        problem = nil
        var hold: TimeInterval = 0
        if let moved = attempt.movedAt { hold = max(0, 0.6 - Date().timeIntervalSince(moved)) }
        let connecting = self.connecting
        self.connecting = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + hold) { [weak self] in
            guard let self, self.attempt == nil, self.dock?.isReady == true else { return }
            self.root?.revealDock()
            _ = connecting
        }
        changed()
    }

    private func cancelAttempt() {
        attempt = nil
        probes.cancelAll()
    }

    private func chooseAnother() {
        cancelAttempt()
        tearDownDock()
        showHub(overDock: false)
    }

    private func tearDownDock() {
        guard let dock else { return }
        dock.tearDown()
        root?.removeDock(dock)
        self.dock = nil
    }

    // MARK: Problems

    private func enterUnreachable(_ attempt: Attempt) {
        attempt.failing = true
        attempt.retryCount = 0
        showProblem(problemForFailure(attempt))
        scheduleRetry(attempt)
    }

    private func problemForFailure(_ attempt: Attempt) -> ProblemViewController.Problem {
        let computer = attempt.computer
        if discoveryState == .denied { return .localNetworkOff }
        if !network.hasLocalLink { return .noWifi(name: computer.displayName) }
        let checks = ConnectionRules.checks(phone: NetworkStatus.localIPv4(), hostIp: computer.endpoint.host,
                                            platform: computer.platform, lastFailure: attempt.lastFailure,
                                            discoverySawAny: discoverySawAny)
        return .cantReach(name: computer.displayName, platform: computer.platform, checks: checks)
    }

    private func scheduleRetry(_ attempt: Attempt) {
        let id = attempt.id
        let delay = ConnectionRules.retryDelay(attempt: attempt.retryCount)
        attempt.retryCount += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let attempt = self.attempt, attempt.id == id, !attempt.answered else { return }
            self.retryNow(attempt, resetBackoff: false)
        }
    }

    private func retryNow(_ attempt: Attempt, resetBackoff: Bool) {
        if resetBackoff { attempt.retryCount = 0 }
        let id = attempt.id
        let computer = attempt.computer
        probes.probeSecureFirst(computer.endpoint, timeout: 2.5, allowPlain: allowsPlain(computer)) { [weak self] result in
            guard let self, let attempt = self.attempt, attempt.id == id, !attempt.answered else { return }
            switch ConnectionRules.evaluate(computer, pinned: self.pins.pin(for: computer.hostId), result: result) {
            case .noAnswer(let failure):
                attempt.lastFailure = failure
                self.updateFailureScreen(attempt)
                if !resetBackoff { self.scheduleRetry(attempt) }
            case .otherComputer:
                attempt.lastFailure = .other
                if !resetBackoff { self.scheduleRetry(attempt) }
            default:
                self.directAnswer(attempt, result: result)
            }
        }
        for (key, service) in services where service.txt.id == computer.hostId {
            if serviceHosts[key] == nil || serviceHosts[key] == computer.hostId { verify(service) }
        }
    }

    private func updateFailureScreen(_ attempt: Attempt) {
        let next = problemForFailure(attempt)
        guard next != lastProblem else { return }
        if case .cantReach = next, case .cantReach = lastProblem {
            problem?.update(next)
            lastProblem = next
            return
        }
        showProblem(next)
    }

    func showProblem(_ problem: ProblemViewController.Problem) {
        let screen = ProblemViewController(problem: problem)
        screen.onPrimary = { [weak self] in self?.problemPrimary() }
        screen.onSecondary = { [weak self] in self?.problemSecondary() }
        self.problem = screen
        lastProblem = problem
        connecting = nil
        root?.dismissModals(animated: false)
        root?.show(screen, fade: 0.2)
    }

    private func problemPrimary() {
        guard let problem = lastProblem else { return }
        switch problem {
        case .cantReach, .noWifi:
            if let attempt { retryNow(attempt, resetBackoff: true) }
        case .dockFailed, .dockTimeout:
            if let current { open(current, switching: true) }
        case .localNetworkOff:
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        case .securityChanged(let hostId, _, _, _):
            forgetPin(andRepair: hostId)
        }
    }

    private func problemSecondary() {
        guard let problem = lastProblem else { return }
        switch problem {
        case .securityChanged:
            cancelAttempt()
            showHub(overDock: false)
        default:
            chooseAnother()
        }
    }

    private func dockFailed(_ failure: DockViewController.Failure) {
        guard let computer = attempt?.computer ?? current else { return }
        let wasReady = dock?.isReady == true
        switch failure {
        case .terminated:
            // iOS reclaimed the page. Reconnect now when visible, else on return to the foreground.
            if UIApplication.shared.applicationState != .background { open(computer, switching: true) }
        case .network where wasReady:
            open(computer, switching: true)
        case .network:
            let attempt = self.attempt ?? Attempt(computer, switching: true)
            self.attempt = attempt
            attempt.answered = false
            attempt.lastFailure = .other
            tearDownDock()
            enterUnreachable(attempt)
        case .timeout:
            cancelAttempt()
            tearDownDock()
            current = computer
            showProblem(.dockTimeout(name: computer.displayName))
        case .prepare, .status:
            cancelAttempt()
            tearDownDock()
            current = computer
            showProblem(.dockFailed(name: computer.displayName))
        }
    }

    func showSecurityChanged(_ computer: Computer, presented: String) {
        cancelAttempt()
        tearDownDock()
        changedCertificates[computer.hostId] = presented
        statuses[computer.hostId] = .securityChanged
        let old = pins.pin(for: computer.hostId).flatMap(CertificatePin.securityCode) ?? "—"
        let now = CertificatePin.securityCode(presented) ?? "—"
        showProblem(.securityChanged(hostId: computer.hostId, name: computer.displayName, then: old, now: now))
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    /// "Forget and pair again": the pin and session go for this host ID only; the nickname stays.
    private func forgetPin(andRepair hostId: String) {
        guard let computer = store.computer(hostId), let presented = changedCertificates[hostId] else { showHub(overDock: false); return }
        pins.removePin(for: hostId)
        statuses[hostId] = .checking
        SessionCookies.removeAll(for: computer.endpoint.host ?? "", in: cookieStore) { [weak self] in
            guard let self else { return }
            self.changedCertificates[hostId] = nil
            // Pair against the certificate that is presented now; comparing codes is the real check.
            self.showHub(overDock: false)
            self.actionProbes.probeSecureFirst(computer.endpoint, timeout: 4, allowPlain: false) { [weak self] result in
                guard let self else { return }
                let current = result.presentedFingerprint ?? presented
                var context = self.context(for: computer, result: result, presented: current, revoked: false)
                if result.info == nil { context.pairingOpen = true }
                self.beginPairing(context)
            }
        }
    }

    private func localNetworkDenied() {
        guard lastProblem != .localNetworkOff else { return }
        // Only on connection screens (S1, S8, hub, pairing); never over a working dock.
        guard dock?.isReady != true else { return }
        showProblem(.localNetworkOff)
    }

    /// Back from Settings: browse again; S11 leaves by itself if Local Network is now allowed.
    func sceneDidBecomeActive() {
        if lastProblem == .localNetworkOff { restartDiscovery() }
    }

    private func resumeAfterLocalNetwork() {
        lastProblem = nil
        if let attempt { open(attempt.computer, switching: true) } else { showHub(overDock: false) }
    }

    private func networkChanged(_ usable: Bool) {
        guard let attempt, attempt.failing, !attempt.answered else { return }
        if usable { retryNow(attempt, resetBackoff: true) }
        updateFailureScreen(attempt)
    }

    // MARK: Foreground

    /// Reconnect without a tap when the dock was showing and its page or connection is gone.
    func sceneWillEnterForeground() {
        if let attempt, attempt.failing { retryNow(attempt, resetBackoff: true); return }
        guard let current, let dock else { return }
        if dock.contentProcessTerminated || dock.webView == nil {
            open(current, switching: true); return
        }
        actionProbes.probeSecureFirst(dock.endpoint, timeout: 2.5, allowPlain: dock.trustedFingerprint == nil && dock.endpoint.scheme == "http") { [weak self] result in
            guard let self, let current = self.current, self.dock === dock, self.attempt == nil else { return }
            if case .accept = ConnectionRules.evaluate(current, pinned: self.pins.pin(for: current.hostId), result: result) { return }
            self.open(current, switching: true)
        }
    }

    // MARK: Bridge

    private func bridge(_ message: BridgeMessage) {
        switch message {
        case .switchComputer: presentSwitchSheet()
        case .ready: break
        case .unauthorized: sessionRevoked()
        }
    }

    /// The host revoked this phone: step 2 only, "{name} no longer recognizes this phone".
    private func sessionRevoked() {
        guard let current, let dock, root?.topModal is PairingViewController == false else { return }
        let context = PairingContext(hostId: current.hostId, hostName: current.hostName, platform: current.platform,
                                     endpoint: dock.endpoint, presented: dock.trustedFingerprint, pairingOpen: true,
                                     revoked: true, existing: current)
        actionProbes.probeSecureFirst(dock.endpoint, timeout: 4, allowPlain: dock.trustedFingerprint == nil) { [weak self] result in
            guard let self else { return }
            var context = context
            if result.presentedFingerprint == context.presented, let open = result.info?.pairingOpen { context.pairingOpen = open }
            self.beginPairing(context)
        }
    }

    // MARK: Hub and switch sheet

    func showHub(overDock: Bool) {
        if overDock {
            let hub = ComputersViewController(coordinator: self, overDock: true)
            root?.presentModal(hub, style: .fade)
        } else {
            cancelAttempt()
            tearDownDock()
            current = nil
            problem = nil
            lastProblem = nil
            connecting = nil
            root?.dismissModals(animated: false)
            root?.show(ComputersViewController(coordinator: self, overDock: false), fade: 0.2)
        }
        if store.localNetworkPrimed || !store.isEmpty { startDiscovery() }
        refreshStatuses()
    }

    func presentSwitchSheet() {
        guard let root, root.topModal == nil else { return }
        refreshStatuses()
        root.presentSheet(SwitchSheetViewController(coordinator: self))
    }

    /// A paired row was tapped in the hub or the switch sheet.
    func select(_ computer: Computer) {
        if case .securityChanged = status(for: computer), let presented = changedCertificates[computer.hostId] {
            root?.dismissModals(animated: false)
            showSecurityChanged(computer, presented: presented)
            return
        }
        if needsPin.contains(computer.hostId) {
            repairPin(computer)
            return
        }
        if current?.hostId == computer.hostId, dock?.isReady == true {
            root?.dismissModals(animated: true)
            return
        }
        open(computer, switching: true)
    }

    /// "Needs a new PIN": step 2 with the existing pin.
    private func repairPin(_ computer: Computer) {
        actionProbes.probeSecureFirst(computer.endpoint, timeout: 4, allowPlain: allowsPlain(computer)) { [weak self] result in
            guard let self else { return }
            let pinned = self.pins.pin(for: computer.hostId)
            switch ConnectionRules.evaluate(computer, pinned: pinned, result: result) {
            case .accept(let fingerprint):
                var context = self.context(for: computer, result: result, presented: fingerprint, revoked: true)
                context.endpoint = result.endpoint ?? computer.endpoint
                self.beginPairing(context)
            case .mismatch(let presented):
                self.showSecurityChanged(computer, presented: presented)
            default:
                self.open(computer, switching: true)
            }
        }
    }

    /// A discovered (unpaired) row: fetch `/health` again and read the presented certificate.
    func pairDiscovered(_ host: VerifiedHost, completion: @escaping (Bool) -> Void) {
        actionProbes.probeSecureFirst(host.endpoint, timeout: 4, allowPlain: host.presented == nil) { [weak self] result in
            guard let self else { return }
            guard result.info != nil else { completion(false); return }
            completion(true)
            self.arrived(result)
        }
    }

    /// A WinDock answered (discovered row or typed address): open, warn or pair.
    func arrived(_ result: ProbeResult) {
        guard let endpoint = result.endpoint, let info = result.info else { return }
        switch ConnectionRules.arrival(store: store, pins: pins, result: result) {
        case .openPaired(let hostId, let endpoint, _):
            store.update(hostId) { $0.endpoint = endpoint }
            if let computer = store.computer(hostId) { root?.dismissModals(animated: false); open(computer, switching: true) }
        case .mismatch(let hostId, let presented):
            if let computer = store.computer(hostId) { showSecurityChanged(computer, presented: presented) }
        case .repair(let hostId):
            if let computer = store.computer(hostId) {
                beginPairing(context(for: computer, result: result, presented: result.presentedFingerprint, revoked: false))
            }
        case .pairNew, .none:
            let hostId = info.hostId?.lowercased()
            beginPairing(PairingContext(hostId: hostId.flatMap { PinStore.isValidHostId($0) ? $0 : nil }, hostName: info.hostName,
                                        platform: Computer.normalizedPlatform(info.platform), endpoint: endpoint,
                                        presented: endpoint.scheme == "https" ? result.presentedFingerprint : nil,
                                        pairingOpen: info.pairingOpen ?? true, revoked: false, existing: nil))
        }
    }

    func presentAddByAddress() {
        let add = AddAddressViewController(coordinator: self)
        root?.presentModal(add, style: .fadeScale)
    }

    /// S7: probe https first, plain http only for a very old host without TLS.
    func checkAddress(_ endpoint: URL, completion: @escaping (ProbeResult) -> Void) {
        startDiscovery()
        actionProbes.probeSecureFirst(endpoint, timeout: 4, allowPlain: true, completion: completion)
    }

    // MARK: Pairing

    private func context(for computer: Computer, result: ProbeResult, presented: String?, revoked: Bool) -> PairingContext {
        PairingContext(hostId: computer.isLegacy ? nil : computer.hostId, hostName: result.info?.hostName ?? computer.hostName,
                       platform: Computer.normalizedPlatform(result.info?.platform).isEmpty ? computer.platform : Computer.normalizedPlatform(result.info?.platform),
                       endpoint: result.endpoint ?? computer.endpoint, presented: presented,
                       pairingOpen: result.info?.pairingOpen ?? true, revoked: revoked, existing: computer)
    }

    func beginPairing(_ context: PairingContext) {
        guard let root else { return }
        let pairing = PairingViewController(context: context, coordinator: self)
        if root.topModal is PairingViewController { root.dismissModals(animated: false) }
        root.presentModal(pairing, style: .fadeScale)
    }

    /// Polls `/health.pairingOpen` over the same pinned identity (nil: no trusted answer).
    func pollPairing(_ context: PairingContext, completion: @escaping (Bool?) -> Void) {
        actionProbes.probeSecureFirst(context.endpoint, timeout: 2.5, allowPlain: context.presented == nil) { result in
            guard let info = result.info, result.presentedFingerprint == context.presented,
                  context.hostId == nil || info.hostId?.lowercased() == context.hostId else { completion(nil); return }
            completion(info.pairingOpen ?? true)
        }
    }

    func submitPIN(_ pin: String, context: PairingContext, completion: @escaping (AuthOutcome) -> Void) {
        let client = PinnedClient(endpoint: context.endpoint, fingerprint: context.presented)
        PairingAPI.authenticate(client: client, pin: pin, deviceName: deviceName) { outcome in
            _ = client
            completion(outcome)
        }
    }

    /// 200 from `/api/auth`: cookie into the WebView store, then pin + record, then the dock loads
    /// behind the pairing screen, which fades out once the dock is ready.
    func paired(_ context: PairingContext, cookies: [HTTPCookie], onDockReady: @escaping () -> Void) {
        SessionCookies.set(cookies, in: cookieStore) { [weak self] in
            guard let self else { return }
            let now = Date()
            let hostId = context.hostId ?? context.existing?.hostId ?? UUID().uuidString.lowercased()
            if let presented = context.presented { self.pins.setPin(presented, for: hostId) }
            var computer = context.existing ?? Computer(hostId: hostId, hostName: context.hostName, nickname: nil,
                                                        platform: context.platform, endpoint: context.endpoint,
                                                        lastConnectedAt: now, addedAt: now, localId: context.hostId == nil ? true : nil)
            computer.hostName = context.hostName.isEmpty ? computer.hostName : context.hostName
            if !context.platform.isEmpty { computer.platform = context.platform }
            computer.endpoint = context.endpoint
            computer.lastConnectedAt = now
            self.store.upsert(computer)
            self.needsPin.remove(hostId)
            self.changedCertificates[hostId] = nil
            self.statuses[hostId] = .online(address: context.endpoint.host ?? "")
            self.loadDockBehindModal(computer, fingerprint: context.presented, onReady: onDockReady)
        }
    }

    private func loadDockBehindModal(_ computer: Computer, fingerprint: String?, onReady: @escaping () -> Void) {
        cancelAttempt()
        let attempt = Attempt(computer, switching: true)
        attempt.answered = true
        self.attempt = attempt
        let id = attempt.id
        tearDownDock()
        let dock = DockViewController(endpoint: computer.endpoint, trustedFingerprint: fingerprint, computerName: computer.displayName)
        self.dock = dock
        current = computer
        wire(dock)
        dock.onReady = { [weak self] in
            guard let self, let attempt = self.attempt, attempt.id == id else { return }
            self.connected(attempt, endpoint: computer.endpoint)
            self.root?.clearScreen()
            onReady()
        }
        root?.installDock(dock)
        dock.start()
    }

    /// Pairing was closed without finishing.
    func pairingCancelled(_ context: PairingContext) {
        if context.revoked, let hostId = context.hostId ?? context.existing?.hostId {
            needsPin.insert(hostId)
            statuses[hostId] = .needsPin
            if dock != nil {
                root?.dismissModals(animated: true)
                showHub(overDock: false)
                return
            }
        }
        root?.dismissModals(animated: true)
        if root?.hasScreen != true && dock == nil { showHub(overDock: false) }
        changed()
    }

    func pairingRejected() {
        root?.dismissModals(animated: true)
        if dock == nil, !(root?.currentScreen is ComputersViewController) { showHub(overDock: false) }
    }

    // MARK: Rename and forget

    func rename(_ computer: Computer, to nickname: String?) {
        store.update(computer.hostId) { $0.nickname = Computer.sanitizeNickname(nickname) }
        if current?.hostId == computer.hostId { current = store.computer(computer.hostId) }
        changed()
    }

    /// Removes this phone from the computer when it answers (`DELETE /api/session`), then the record,
    /// pin and that origin's cookies. `completion(true)` when the computer confirmed the removal.
    func forget(_ computer: Computer, completion: @escaping (Bool) -> Void) {
        let host = computer.endpoint.host ?? ""
        let fingerprint = pins.pin(for: computer.hostId)
        SessionCookies.session(for: host, in: cookieStore) { [weak self] cookie in
            guard let self else { return }
            guard let cookie, computer.endpoint.scheme == "http" || fingerprint != nil else {
                self.forgetLocally(computer) { completion(false) }
                return
            }
            let client = PinnedClient(endpoint: computer.endpoint, fingerprint: computer.endpoint.scheme == "https" ? fingerprint : nil)
            client.send(method: "DELETE", path: "api/session", cookie: cookie, timeout: 4) { [weak self] result in
                _ = client
                var removed = false
                if case .success(let response) = result { removed = (200...299).contains(response.status) || response.status == 401 }
                guard let self else { completion(removed); return }
                self.forgetLocally(computer) { completion(removed) }
            }
        }
    }

    private func forgetLocally(_ computer: Computer, completion: @escaping () -> Void) {
        let hostId = computer.hostId
        store.remove(hostId)
        pins.removePin(for: hostId)
        statuses[hostId] = nil
        changedCertificates[hostId] = nil
        needsPin.remove(hostId)
        let wasCurrent = current?.hostId == hostId
        SessionCookies.removeAll(for: computer.endpoint.host ?? "", in: cookieStore) { [weak self] in
            guard let self else { return }
            if wasCurrent {
                self.root?.dismissModals(animated: false)
                self.showHub(overDock: false)
            }
            self.changed()
            completion()
        }
    }
}
