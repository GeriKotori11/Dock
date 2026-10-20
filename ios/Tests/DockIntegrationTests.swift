import XCTest
import Network
import UIKit
import WebKit
@testable import WinDock

/// Hosted simulator tests against the real Node host (ios/scripts/smoke-host.mjs) with a fake
/// provider. They drive the native screens (security code, PIN) the way a person would.
@MainActor
final class DockIntegrationTests: XCTestCase {
    private var root: RootViewController!
    private var coordinator: ConnectionCoordinator!
    private var discovery: FakeDiscovery!
    private var defaults: UserDefaults!
    private let address = "127.0.0.1:18622"
    private let endpoint = "http://127.0.0.1:18622"
    private let secureEndpoint = "https://127.0.0.1:18622"
    private let pin = "864200"

    private struct HostHealth { let hostId: String; let fingerprint: String; let code: String }

    /// The host's own view of its certificate (a hint only; the app must use the handshake).
    private func hostHealth() async throws -> HostHealth {
        let (body, _) = try await URLSession.shared.data(from: URL(string: endpoint + "/health")!)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let tls = try XCTUnwrap(object["tls"] as? [String: Any], "Fixture host must serve TLS")
        return HostHealth(hostId: try XCTUnwrap(object["hostId"] as? String),
                          fingerprint: try XCTUnwrap(tls["fingerprint"] as? String),
                          code: try XCTUnwrap(tls["code"] as? String))
    }

    override func setUp() async throws {
        defaults = UserDefaults(suiteName: "WinDockSimulatorTests")!
        defaults.removePersistentDomain(forName: "WinDockSimulatorTests")
        defaults.set(true, forKey: ComputerStore.primedKey)
        let store = WKWebsiteDataStore.default()
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        install(autoStart: false)
    }

    override func tearDown() async throws {
        root.dismissModals(animated: false)
        coordinator.showHub(overDock: false)
        try await Task.sleep(nanoseconds: 300_000_000)
        defaults.removePersistentDomain(forName: "WinDockSimulatorTests")
    }

    private func install(autoStart: Bool, discovery: FakeDiscovery = FakeDiscovery()) {
        root?.dismissModals(animated: false)
        // Release the previous root's web view: an off-screen WebKit process can stall the data store.
        coordinator?.showHub(overDock: false)
        self.discovery = discovery
        coordinator = ConnectionCoordinator(store: ComputerStore(defaults: defaults), pins: PinStore(defaults: defaults), discovery: discovery)
        root = RootViewController(coordinator: coordinator, autoStart: autoStart)
        let window = appWindow()
        window.rootViewController = root
        window.makeKeyAndVisible()
        root.loadViewIfNeeded()
    }

    private func appWindow() -> UIWindow {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
        return (scene.delegate as! SceneDelegate).window!
    }

    private func waitUntil(_ description: String, seconds: Double = 20, _ condition: () async throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if try await condition() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Timed out: \(description)")
        throw NSError(domain: "WinDockTests", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
    }

    private var web: WKWebView? { root.dock?.webView }

    private func js(_ script: String) async throws -> Any? {
        try await XCTUnwrap(web).evaluateJavaScript(script)
    }

    /// Generous: a loaded simulator can take over 10 s just to launch WebKit's processes.
    private func waitForJS(_ expression: String, seconds: Double = 45) async throws {
        try await waitUntil(expression, seconds: seconds) { [self] in
            guard web != nil else { return false }
            return (try? await js("Boolean(\(expression))")) as? Bool == true
        }
    }

    private var pairing: PairingViewController? { root.topModal as? PairingViewController }
    private var addScreen: AddAddressViewController? { root.topModal as? AddAddressViewController }

    private func screenshot(_ name: String) async throws {
        try await Task.sleep(nanoseconds: 400_000_000)
        let image: UIImage
        if let web, root.isShowingDock, root.presentedViewController == nil {
            let config = WKSnapshotConfiguration()
            config.afterScreenUpdates = true
            image = try await web.takeSnapshot(configuration: config)
        } else {
            let window = appWindow()
            image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    // MARK: Native pairing helpers

    private func openAddress(_ text: String) async throws -> AddAddressViewController {
        if addScreen == nil {
            coordinator.presentAddByAddress()
            try await waitUntil("Add by address") { [self] in addScreen?.isBeingPresented == false }
        }
        let screen = try XCTUnwrap(addScreen)
        screen.field.text = text
        screen.connectButton.sendActions(for: .touchUpInside)
        return screen
    }

    /// Types like the number pad: every key goes through the field's delegate.
    private func type(_ digits: String, into pairing: PairingViewController) {
        for digit in digits {
            let field = pairing.pinField
            let length = field.text?.count ?? 0
            if pairing.textField(field, shouldChangeCharactersIn: NSRange(location: length, length: 0), replacementString: String(digit)) {
                field.text = (field.text ?? "") + String(digit)
                field.sendActions(for: .editingChanged)
            }
        }
    }

    private func confirmCode(expecting health: HostHealth) async throws -> PairingViewController {
        try await waitUntil("Security code step") { [self] in pairing?.phase == .code && pairing?.isBeingPresented == false }
        let pairing = try XCTUnwrap(self.pairing)
        XCTAssertEqual(pairing.context.presented, health.fingerprint, "Step 1 shows the handshake certificate's code")
        XCTAssertEqual(pairing.context.presented.flatMap(CertificatePin.securityCode), health.code)
        XCTAssertEqual(pairing.context.endpoint.absoluteString, secureEndpoint)
        pairing.matchButton.sendActions(for: .touchUpInside)
        try await waitUntil("PIN step") { pairing.phase == .pin }
        return pairing
    }

    private func waitForDock() async throws {
        try await waitForJS("document.getElementById('app') && !document.getElementById('app').hidden && document.querySelectorAll('.tile').length === 5")
        try await waitForJS("document.getElementById('conn').textContent === 'Connected'")
        try await waitUntil("Native screens gone") { [self] in root.isShowingDock && root.presentedViewController == nil }
    }

    private func pairFixture() async throws -> HostHealth {
        let health = try await hostHealth()
        _ = try await openAddress(address)
        let pairing = try await confirmCode(expecting: health)
        type(pin, into: pairing)
        try await waitForDock()
        return health
    }

    // MARK: Tests

    func testNativePairingLoadsTheDockAndSurvivesRelaunch() async throws {
        let health = try await hostHealth()
        coordinator.showHub(overDock: false)
        try await screenshot("01-computers")
        let add = try await openAddress(address)
        _ = add
        let pairing = try await confirmCode(expecting: health)
        XCTAssertTrue(root.view.bounds.width > root.view.bounds.height, "Landscape presentation")
        try await screenshot("02-pin")
        type("000000", into: pairing)
        try await waitUntil("Wrong PIN") { pairing.pinState == .wrong }
        XCTAssertTrue(pairing.pinErrorText?.contains("didn't work") == true)
        XCTAssertNil(root.dock, "Nothing loads before pairing")
        try await screenshot("03-pin-wrong")
        // The next keypress clears the wrong digits and starts over.
        type(pin, into: pairing)
        try await waitUntil("Paired") { pairing.pinState == .paired || self.root.isShowingDock }
        try await waitForDock()
        XCTAssertEqual(web?.url?.scheme, "https")
        XCTAssertEqual(root.dock?.trustedFingerprint, health.fingerprint)
        XCTAssertEqual(PinStore(defaults: defaults).pin(for: health.hostId), health.fingerprint)
        let saved = try XCTUnwrap(ComputerStore(defaults: defaults).computer(health.hostId))
        XCTAssertEqual(saved.endpoint.absoluteString, secureEndpoint)
        XCTAssertNotNil(saved.lastConnectedAt)
        // The HttpOnly session cookie went into the WebView store for the exact host.
        let cookie = await withCheckedContinuation { continuation in
            SessionCookies.session(for: "127.0.0.1", in: WKWebsiteDataStore.default().httpCookieStore) { continuation.resume(returning: $0) }
        }
        XCTAssertEqual(cookie?.isHTTPOnly, true)
        XCTAssertEqual(cookie?.isSecure, true)
        try await waitForJS("Array.from(document.querySelectorAll('.tile img')).filter(i => i.complete && i.naturalWidth > 0).length === 5")
        _ = try await js("document.querySelector('.tile[data-key=\"ios-1\"]').click(); true")
        try await waitForJS("document.querySelector('.tile[data-key=\"ios-1\"]').classList.contains('is-running')")
        _ = try await js("document.querySelector('.tile[data-key=\"ios-1\"]').click(); true")
        try await screenshot("04-dock")
        _ = try await js("document.getElementById('drawer-open').click(); true")
        try await waitForJS("document.getElementById('drawer').open")
        try await screenshot("05-drawer")
        _ = try await js("document.getElementById('drawer-close').click(); true")
        // The shared web UI says it draws the drawer switch row, so the legacy "…" never shows.
        try await waitUntil("Bridge ready", seconds: 6) { [self] in root.dock?.bridgeCapable == true }
        try await Task.sleep(nanoseconds: 3_200_000_000)
        XCTAssertEqual(root.dock?.isFallbackVisible, false)
        // A new native root, same stored computer and cookie: straight back into the dock.
        install(autoStart: true)
        try await waitForDock()
        XCTAssertEqual(web?.url?.scheme, "https")
        XCTAssertNil(pairing.presentingViewController, "A paired computer never asks again")
    }

    func testBridgeSwitchSheetAndRevokedSessionUseNativeScreens() async throws {
        let health = try await pairFixture()
        try await waitUntil("Bridge ready") { [self] in root.dock?.bridgeCapable == true }
        // Unknown messages are ignored.
        _ = try await js("window.webkit.messageHandlers.windock.postMessage({type: 'nonsense'}); true")
        // The drawer's connection row opens the native sheet over the live dock.
        _ = try await js("document.getElementById('drawer-open').click(); true")
        try await waitForJS("document.getElementById('drawer').open && document.getElementById('drawer-switch')")
        _ = try await js("document.getElementById('drawer-switch').click(); true")
        try await waitUntil("Switch sheet") { [self] in root.presentedViewController is SwitchSheetViewController }
        XCTAssertNotNil(root.dock?.webView, "The dock stays live under the sheet")
        try await screenshot("06-switch-sheet")
        root.dismissModals(animated: false)
        _ = try await js("document.getElementById('drawer-close')?.click(); true")
        // The computer stops accepting this phone's session: the page hands off to native step 2.
        _ = try await js("fetch('/api/session', {method: 'DELETE'}); true")
        try await waitUntil("Revoked PIN step") { [self] in pairing?.phase == .pin }
        let pairing = try XCTUnwrap(self.pairing)
        XCTAssertTrue(pairing.context.revoked)
        XCTAssertEqual(pairing.context.presented, health.fingerprint)
        try await screenshot("06b-revoked")
        type(pin, into: pairing)
        try await waitForDock()
    }

    func testChangedCertificateShowsFullScreenMismatchAndLoadsNothing() async throws {
        let health = try await hostHealth()
        let pins = PinStore(defaults: defaults)
        let stale = String(repeating: "0", count: 64)
        XCTAssertTrue(pins.setPin(stale, for: health.hostId))
        let computer = Computer(hostId: health.hostId, hostName: "Studio", nickname: "Studio PC", platform: "windows",
                                endpoint: URL(string: secureEndpoint)!, lastConnectedAt: Date(), addedAt: Date(), localId: nil)
        coordinator.store.upsert(computer)
        coordinator.open(computer, switching: false)
        try await waitUntil("S10") { [self] in
            if case .securityChanged = (root.currentScreen as? ProblemViewController)?.problem { return true }
            return false
        }
        let screen = try XCTUnwrap(root.currentScreen as? ProblemViewController)
        XCTAssertEqual(screen.problem, .securityChanged(hostId: health.hostId, name: "Studio PC", then: "0000-0000-0000", now: health.code))
        XCTAssertNil(root.dock, "Nothing loads for a changed certificate")
        XCTAssertNil(root.presentedViewController, "A full screen, not an alert")
        try await screenshot("07-security-changed")
        // "Not now" goes to the hub, where the row says so.
        screen.secondaryButton?.sendActions(for: .touchUpInside)
        try await waitUntil("Hub") { [self] in root.currentScreen is ComputersViewController }
        XCTAssertEqual(coordinator.status(for: computer), .securityChanged)
        // Tapping the row reopens S10; "Forget and pair again" pairs against the new code.
        coordinator.select(computer)
        try await waitUntil("S10 again") { [self] in root.currentScreen is ProblemViewController }
        (root.currentScreen as? ProblemViewController)?.primaryButton?.sendActions(for: .touchUpInside)
        let pairing = try await confirmCode(expecting: health)
        XCTAssertNil(pins.pin(for: health.hostId), "The old pin is gone before the new one is confirmed")
        XCTAssertEqual(pairing.context.existing?.nickname, "Studio PC", "The nickname is kept")
        type(pin, into: pairing)
        try await waitForDock()
        XCTAssertEqual(pins.pin(for: health.hostId), health.fingerprint)
        XCTAssertEqual(coordinator.store.computer(health.hostId)?.nickname, "Studio PC")
    }

    func testDifferentCodesPinNothing() async throws {
        let health = try await hostHealth()
        _ = try await openAddress(address)
        try await waitUntil("Security code step") { [self] in pairing?.phase == .code }
        try await screenshot("08-security-code")
        let pairing = try XCTUnwrap(self.pairing)
        pairing.noMatchButton.sendActions(for: .touchUpInside)
        XCTAssertEqual(pairing.phase, .noMatch)
        XCTAssertNil(PinStore(defaults: defaults).pin(for: health.hostId))
        XCTAssertNil(coordinator.store.computer(health.hostId))
        XCTAssertNil(root.dock)
        coordinator.pairingRejected()
        try await waitUntil("Back to computers") { [self] in root.presentedViewController == nil && root.currentScreen is ComputersViewController }
    }

    func testInvalidUnreachableRedirectedAndNonWinDockHostsRecover() async throws {
        coordinator.showHub(overDock: false)
        let screen = try await openAddress("not an address")
        XCTAssertTrue(screen.isShowingError)
        XCTAssertTrue(screen.captionLabel.text?.contains("Enter a local address") == true)
        _ = try await openAddress("8.8.8.8")
        XCTAssertTrue(screen.captionLabel.text?.contains("only connects to computers on your local network") == true)
        for candidate in ["127.0.0.1:1", "127.0.0.1:18623", "127.0.0.1:18624", "127.0.0.1:18625"] {
            _ = try await openAddress(candidate)
            try await waitUntil("Failure for \(candidate)", seconds: 15) { !screen.connectButton.isBusy && screen.isShowingError }
            XCTAssertTrue(screen.captionLabel.text?.contains("No WinDock answered at") == true, candidate)
            XCTAssertNil(root.dock)
            XCTAssertTrue(coordinator.store.isEmpty)
        }
        try await screenshot("09-address-error")
        _ = try await openAddress(address)
        try await waitUntil("Pairing") { [self] in pairing?.phase == .code }
    }

    func testWebViewBlocksForeignNavigationAndSubresources() async throws {
        _ = try await pairFixture()
        _ = try await js("""
            const foreign = 'http://127.0.0.1:18626';
            const image = new Image(); image.src = foreign + '/image.png'; document.body.append(image);
            const script = document.createElement('script'); script.src = foreign + '/script.js'; document.head.append(script);
            fetch(foreign + '/data').catch(() => {});
            location.href = foreign + '/navigation'; true
            """)
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertEqual(web?.url?.scheme, "https")
        XCTAssertEqual(web?.url?.host, "127.0.0.1")
        XCTAssertEqual(web?.url?.port, 18622)
        let (body, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18626/hits")!)
        let hits = try JSONDecoder().decode([String].self, from: body)
        XCTAssertEqual(hits, [], "No foreign navigation, script, image or fetch should reach the other origin")
    }

    func testMovedComputerIsFoundByIdentityWithoutAPin() async throws {
        let health = try await pairFixture()
        // The computer "moves": its saved address stops answering; discovery finds it elsewhere.
        coordinator.store.update(health.hostId) { $0.endpoint = URL(string: "https://127.0.0.1:18699")! }
        let found = FakeDiscovery()
        found.services = [(DiscoveredService(key: "studio._windock._tcp.local.", serviceName: "Studio",
                                             txt: BonjourTXT(["id": health.hostId, "api": "1", "tls": "1", "os": "windows"]),
                                             endpoint: .service(name: "Studio", type: "_windock._tcp", domain: "local.", interface: nil)),
                           URL(string: endpoint)!)]
        install(autoStart: true, discovery: found)
        var sawMoved = false
        try await waitUntil("Found at a new address", seconds: 15) { [self] in
            if case .moved = (root.currentScreen as? ConnectingViewController)?.status { sawMoved = true }
            return sawMoved
        }
        try await screenshot("10-found-new-address")
        try await waitForDock()
        XCTAssertTrue(sawMoved)
        XCTAssertNil(pairing, "No PIN and no confirmation")
        XCTAssertEqual(coordinator.store.computer(health.hostId)?.endpoint.absoluteString, secureEndpoint)
    }

    func testUnreachableComputerShowsCantReachAndKeepsTrying() async throws {
        let computer = Computer(hostId: UUID().uuidString.lowercased(), hostName: "Studio", nickname: nil, platform: "windows",
                                endpoint: URL(string: "https://127.0.0.1:18698")!, lastConnectedAt: Date(), addedAt: Date(), localId: nil)
        PinStore(defaults: defaults).setPin(String(repeating: "1", count: 64), for: computer.hostId)
        coordinator.store.upsert(computer)
        coordinator.open(computer, switching: false)
        try await waitUntil("Connecting after 400 ms", seconds: 3) { [self] in root.currentScreen is ConnectingViewController }
        try await screenshot("11-connecting")
        try await waitUntil("Can't reach after 8 s", seconds: 12) { [self] in
            if case .cantReach = (root.currentScreen as? ProblemViewController)?.problem { return true }
            return false
        }
        try await screenshot("12-cant-reach")
        (root.currentScreen as? ProblemViewController)?.secondaryButton?.sendActions(for: .touchUpInside)
        try await waitUntil("Other computers") { [self] in root.currentScreen is ComputersViewController }
        try await screenshot("13-hub")
    }

    func testForgetRemovesRecordPinAndCookies() async throws {
        let health = try await pairFixture()
        let computer = try XCTUnwrap(coordinator.store.computer(health.hostId))
        let removedOnHost = await withCheckedContinuation { continuation in
            coordinator.forget(computer) { continuation.resume(returning: $0) }
        }
        XCTAssertTrue(removedOnHost, "DELETE /api/session removed this phone on the computer")
        XCTAssertNil(coordinator.store.computer(health.hostId))
        XCTAssertNil(PinStore(defaults: defaults).pin(for: health.hostId))
        let cookie = await withCheckedContinuation { continuation in
            SessionCookies.session(for: "127.0.0.1", in: WKWebsiteDataStore.default().httpCookieStore) { continuation.resume(returning: $0) }
        }
        XCTAssertNil(cookie)
        try await waitUntil("Hub becomes the root") { [self] in root.currentScreen is ComputersViewController && root.dock == nil }
        XCTAssertTrue((root.currentScreen as? ComputersViewController)?.firstLaunch == true, "Last computer gone: first-launch rail")
    }
}

/// Discovery that reports fixed services (the simulator's real Bonjour is not used in tests).
final class FakeDiscovery: DiscoverySource {
    var onResults: (([DiscoveredService]) -> Void)?
    var onState: ((DiscoveryState) -> Void)?
    var services: [(DiscoveredService, URL)] = []

    func start() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self else { return }
            self.onState?(.browsing)
            self.onResults?(self.services.map(\.0))
        }
    }

    func stop() {}

    func resolve(_ service: DiscoveredService, completion: @escaping (URL?) -> Void) {
        let url = services.first { $0.0.key == service.key }?.1
        DispatchQueue.main.async { completion(url) }
    }
}
