import UIKit

/// Q5–Q11 (docs/design/HOST-CONTROL-PAGE.md, sections 10.5–10.7): confirm a scanned code, pair
/// over a connection pinned to its fingerprint, and every outcome. One full-screen modal, so
/// Cancel returns to whatever was underneath (the live dock or the hub). Nothing touches the
/// network until Pair (or "Pair again with the new code") is tapped.
final class QRPairingViewController: ScreenViewController, FocusProviding {
    enum Screen: Equatable { case confirm, used, closed, cantReach, securityChanged }
    enum Phase: Equatable { case idle, pairing, locked(until: Date), paired }

    let link: PairingLink
    private(set) var plan: QRPairingRules.Plan
    private unowned let coordinator: ConnectionCoordinator
    private let session: QRPairingSession
    private(set) var screen: Screen
    private(set) var phase: Phase = .idle
    private(set) var otherDevice = false
    private var again = false
    private var found: QRPairingSession.Found?
    private var lastFailure: ProbeFailure?
    private var authInFlight = false
    private var retryAttempt = 0
    private var pollTimer: Timer?
    private var retryTimer: Timer?
    private var countdown: Timer?
    private var pairedAt: Date?
    private var dimmer: IdleDimmer?

    private let closeButton = IconButton(symbol: Theme.Icon.close, label: "Cancel")
    let titleLabel = Theme.label(font: Theme.title)
    private let bodyLabel = Theme.label(font: Theme.body, color: Theme.text2)
    private let scroll = UIScrollView()
    private let columns = UIStackView()
    private let left = UIStackView()
    private let right = UIStackView()
    private var leftWidth: NSLayoutConstraint?
    private var rightMaxWidth: NSLayoutConstraint?
    private var scrollTopToClose: NSLayoutConstraint?
    private var scrollTopToSafe: NSLayoutConstraint?
    private var buttonRow: UIStackView?
    private(set) var primaryButton: ThemedButton?
    private(set) var secondaryButton: ThemedButton?
    private let actionArea = UIView()
    private let lockedLabel = Theme.label(font: Theme.font(13), color: Theme.dangerText)
    private let statusLabel = Theme.label(font: Theme.body, color: Theme.text2)
    private let statusSpinner = makeSpinner()
    private let checksStack = UIStackView()

    var initialFocus: UIView? { titleLabel }

    init(link: PairingLink, plan: QRPairingRules.Plan, coordinator: ConnectionCoordinator) {
        self.link = link
        self.plan = plan
        self.coordinator = coordinator
        self.session = QRPairingSession(link: link, coordinator: coordinator)
        switch plan {
        case .securityChanged: screen = .securityChanged
        case .confirm(let again): screen = .confirm; self.again = again
        case .openPaired: screen = .confirm
        }
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    deinit {
        pollTimer?.invalidate()
        retryTimer?.invalidate()
        countdown?.invalidate()
        session.cancel()
    }

    // MARK: Derived

    private var saved: Computer? { coordinator.store.computer(link.hostId) }
    /// The computer's name: this phone's nickname when already paired, else the name in the code.
    var name: String { saved?.displayName ?? link.displayName }
    private var platform: String {
        let reported = Computer.normalizedPlatform(found?.info.platform)
        if !reported.isEmpty { return reported }
        if let saved, !saved.platform.isEmpty { return saved.platform }
        // Only picks instruction wording: a discovery answer for this host ID, if any.
        return coordinator.verified[link.hostId]?.platform ?? ""
    }
    private var hostUi: Bool { found?.info.hostUi ?? saved?.hostUi ?? false }

    // MARK: Layout

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "qr-pairing"
        titleLabel.accessibilityTraits = .header
        titleLabel.accessibilityIdentifier = "qr-title"
        closeButton.accessibilityIdentifier = "qr-close"
        closeButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        scroll.alwaysBounceVertical = false
        scroll.showsVerticalScrollIndicator = false
        view.addSubview(scroll)
        view.addSubview(closeButton)
        let safe = view.safeAreaLayoutGuide
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scrollTopToClose = scroll.topAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 4)
        scrollTopToSafe = scroll.topAnchor.constraint(equalTo: safe.topAnchor)
        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            closeButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12),
            scroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: safe.bottomAnchor)
        ])
        columns.spacing = 40
        columns.alignment = .center
        left.axis = .vertical
        left.alignment = .leading
        right.axis = .vertical
        right.alignment = .fill
        columns.addArrangedSubview(left)
        columns.addArrangedSubview(right)
        scroll.addSubview(columns)
        columns.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            columns.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            columns.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            columns.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
            columns.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -14),
            columns.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            columns.heightAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.heightAnchor, constant: -30)
        ])
        rightMaxWidth = right.widthAnchor.constraint(lessThanOrEqualToConstant: 440)
        rightMaxWidth?.isActive = true
        checksStack.axis = .vertical
        checksStack.spacing = 8
        lockedLabel.accessibilityIdentifier = "qr-locked"
        statusLabel.text = "Waiting for pairing to open"
        build()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIAccessibility.post(notification: .screenChanged, argument: titleLabel)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Dismissed (not merely covered by an alert): stop every probe, poll and request.
        if presentingViewController == nil { stopEverything() }
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: { _ in self.updateLayout() })
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { updateLayout() }
    }

    override var preferredFocusEnvironments: [UIFocusEnvironment] {
        if screen == .securityChanged, let secondaryButton { return [secondaryButton] }
        return super.preferredFocusEnvironments
    }

    override func accessibilityPerformEscape() -> Bool {
        guard phase != .paired else { return false }
        cancelTapped()
        return true
    }

    private func updateLayout() {
        let single = traitCollection.prefersSingleColumn
        columns.axis = single ? .vertical : .horizontal
        columns.alignment = single ? .fill : .center
        leftWidth?.isActive = false
        if !single {
            leftWidth = left.widthAnchor.constraint(equalToConstant: view.bounds.width >= 900 ? 330 : 300)
            leftWidth?.priority = UILayoutPriority(999)
            leftWidth?.isActive = true
        }
        buttonRow?.axis = single ? .vertical : .horizontal
        buttonRow?.alignment = single ? .leading : .center
    }

    /// Q5, Q8 and Q9 keep the close control; Q7, Q10 and Q11 have their own way out (section 10.7).
    private var showsClose: Bool {
        switch screen {
        case .confirm: return phase != .paired
        case .used, .closed: return true
        case .cantReach, .securityChanged: return false
        }
    }

    private func updateClose() {
        closeButton.isHidden = !showsClose
        closeButton.accessibilityLabel = screen == .confirm ? "Cancel pairing" : "Close"
        scrollTopToClose?.isActive = showsClose
        scrollTopToSafe?.isActive = !showsClose
    }

    // MARK: Screens

    /// Q5 → Q8–Q11 and back: the existing 200 ms screen crossfade.
    private func show(_ next: Screen) {
        guard next != screen else { return }
        stopTimers()
        if next != .confirm {
            phase = .idle
            countdown?.invalidate()
        }
        screen = next
        Motion.crossfade(view, duration: 0.2) { self.build() }
        UIAccessibility.post(notification: .screenChanged, argument: titleLabel)
    }

    private func reset() {
        left.arrangedSubviews.forEach { $0.removeFromSuperview() }
        right.arrangedSubviews.forEach { $0.removeFromSuperview() }
        primaryButton = nil
        secondaryButton = nil
        buttonRow = nil
        dimmer?.stop()
        dimmer = nil
        statusSpinner.stopAnimating()
        accessibilityViewIsModal = false
        right.alignment = .fill
        columns.alpha = 1
        rightMaxWidth?.constant = 10_000
    }

    private func build() {
        reset()
        switch screen {
        case .confirm: buildConfirm()
        case .used: buildUsed()
        case .closed: buildClosed()
        case .cantReach: buildCantReach()
        case .securityChanged: buildSecurityChanged()
        }
        updateClose()
        updateLayout()
        // Close → title → body → status → right column → left buttons (as on S8 / S10).
        var order: [Any] = []
        if showsClose { order.append(closeButton) }
        order += [titleLabel, bodyLabel]
        if statusLabel.isDescendant(of: left) { order.append(statusLabel) }
        order.append(right)
        for button in [primaryButton, secondaryButton].compactMap({ $0 }) where button.isDescendant(of: left) {
            order.append(button)
        }
        view.accessibilityElements = order
    }

    private func addHeader(symbol: String, tone: GlyphTile.Tone, title: String, body: NSAttributedString) {
        let glyph = GlyphTile(symbol: symbol, tone: tone, size: 56)
        left.addArrangedSubview(glyph)
        left.setCustomSpacing(18, after: glyph)
        titleLabel.text = title
        bodyLabel.attributedText = body
        left.addArrangedSubview(titleLabel)
        left.setCustomSpacing(8, after: titleLabel)
        left.addArrangedSubview(bodyLabel)
    }

    private func button(_ title: String, _ kind: ThemedButton.Kind, image: String? = nil, id: String,
                        action: Selector, primary: Bool) -> ThemedButton {
        let button = ThemedButton(title, kind: kind, image: image)
        button.accessibilityIdentifier = id
        button.addTarget(self, action: action, for: .touchUpInside)
        if primary { primaryButton = button } else { secondaryButton = button }
        return button
    }

    private func addLeftButtons(_ buttons: [ThemedButton]) {
        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow, for: .vertical)
        spacer.heightAnchor.constraint(greaterThanOrEqualToConstant: 24).isActive = true
        left.addArrangedSubview(spacer)
        let row = UIStackView(arrangedSubviews: buttons)
        row.spacing = 12
        row.alignment = .center
        buttons.forEach { $0.setContentCompressionResistancePriority(.required, for: .horizontal) }
        buttonRow = row
        left.addArrangedSubview(row)
    }

    // Q5 / Q6 / Q7

    private func buildConfirm() {
        let title = again ? "Pair \(name) again?" : "Pair with \(name)?"
        addHeader(symbol: Theme.Icon.monitor, tone: .accent, title: title,
                  body: Theme.paragraph("This phone will open its dock and can launch apps on it."))
        let card = DetailsCard(rows: [("Address", link.address, false), ("Security code", link.securityCode, true)])
        let shield = UIImageView(image: Theme.symbol(Theme.Icon.shield, size: 14))
        shield.tintColor = Theme.text3
        shield.setContentHuggingPriority(.required, for: .horizontal)
        shield.isAccessibilityElement = false
        let caveat = Theme.label(font: Theme.font(13), color: Theme.text3)
        caveat.attributedText = Theme.paragraph("Only pair if you just scanned this code on your own computer's screen.",
                                                font: Theme.font(13), color: Theme.text3, lineHeight: 1.4)
        let caveatRow = UIStackView(arrangedSubviews: [shield, caveat])
        caveatRow.spacing = 10
        caveatRow.alignment = .firstBaseline
        right.addArrangedSubview(card)
        right.setCustomSpacing(16, after: card)
        right.addArrangedSubview(caveatRow)
        right.setCustomSpacing(20, after: caveatRow)
        right.addArrangedSubview(actionArea)
        right.setCustomSpacing(10, after: actionArea)
        right.addArrangedSubview(lockedLabel)
        rightMaxWidth?.constant = 440
        fillActionArea()
    }

    /// Pair → Pairing… → Paired: the button content crossfades (150 ms).
    private func fillActionArea() {
        actionArea.subviews.forEach { $0.removeFromSuperview() }
        let content: UIView
        if phase == .paired {
            let check = UIImageView(image: Theme.symbol(Theme.Icon.check, size: 17, weight: .semibold))
            check.tintColor = Theme.accent
            check.setContentHuggingPriority(.required, for: .horizontal)
            let label = Theme.label("Paired. Opening the dock…", font: Theme.body)
            label.accessibilityIdentifier = "qr-paired"
            let row = UIStackView(arrangedSubviews: [check, label])
            row.spacing = 12
            row.alignment = .center
            row.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
            content = row
            primaryButton = nil
            secondaryButton = nil
        } else {
            let pair = button("Pair", .primary, id: "qr-pair", action: #selector(pairTapped), primary: true)
            pair.busyTitle = "Pairing…"
            pair.widthAnchor.constraint(greaterThanOrEqualToConstant: 150).isActive = true
            let cancel = button("Cancel", .secondary, id: "qr-cancel", action: #selector(cancelTapped), primary: false)
            let row = UIStackView(arrangedSubviews: [pair, cancel])
            row.spacing = 12
            row.alignment = .center
            content = row
            pair.isBusy = phase == .pairing
            if case .locked = phase { pair.isEnabled = false }
        }
        actionArea.addSubview(content)
        content.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: actionArea.leadingAnchor),
            content.trailingAnchor.constraint(lessThanOrEqualTo: actionArea.trailingAnchor),
            content.topAnchor.constraint(equalTo: actionArea.topAnchor),
            content.bottomAnchor.constraint(equalTo: actionArea.bottomAnchor)
        ])
        if case .locked(let until) = phase {
            lockedLabel.isHidden = false
            tickLock(until)
        } else {
            lockedLabel.isHidden = true
            lockedLabel.text = nil
        }
    }

    private func setPhase(_ next: Phase) {
        phase = next
        countdown?.invalidate()
        guard screen == .confirm, isViewLoaded else { return }
        Motion.crossfade(actionArea, duration: 0.15) { self.fillActionArea() }
        updateClose()
        if case .locked(let until) = next {
            countdown = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tickLock(until) }
            if let text = lockedLabel.text { UIAccessibility.post(notification: .announcement, argument: text) }
        }
        if next == .paired { UIAccessibility.post(notification: .announcement, argument: "Paired. Opening the dock…") }
    }

    private func tickLock(_ until: Date) {
        let remaining = Int(ceil(until.timeIntervalSinceNow))
        guard remaining > 0 else {
            countdown?.invalidate()
            if case .locked = phase { setPhase(.idle) }
            return
        }
        lockedLabel.text = String(format: "Too many tries from this phone. Try again in %d:%02d.", remaining / 60, remaining % 60)
    }

    // Q8

    private func buildUsed() {
        addHeader(symbol: Theme.Icon.qrCode, tone: .neutral, title: "This code was already used",
                  body: Theme.paragraph("Each code pairs one phone, and \(name) shows a new one now."))
        let card = InstructionCard(symbol: Theme.Icon.monitor, tone: .accent,
                                   text: Theme.rich("The new code and PIN are in WinDock on the computer, under **Pair a new phone**.",
                                                    font: Theme.font(14), lineHeight: 1.4))
        let scan = button("Scan again", .primary, image: Theme.Icon.camera, id: "qr-scan-again", action: #selector(scanAgainTapped), primary: true)
        let pin = button("Enter the PIN instead", .secondary, id: "qr-pin-instead", action: #selector(pinInsteadTapped), primary: false)
        right.addArrangedSubview(card)
        right.setCustomSpacing(16, after: card)
        right.addArrangedSubview(scan)
        right.setCustomSpacing(12, after: scan)
        right.addArrangedSubview(pin)
        rightMaxWidth?.constant = 340
    }

    // Q9

    private var closedInstruction: String {
        if hostUi {
            switch platform {
            case "windows": return "Click the WinDock icon in the taskbar tray and choose Pair a new phone. That opens pairing for 10 minutes, and this screen continues by itself."
            case "macos": return "Click the WinDock icon in the Mac's menu bar and choose Pair a new phone. That opens pairing for 10 minutes, and this screen continues by itself."
            default: break
            }
        }
        switch platform {
        case "windows": return "Choose **Show connection info** from the WinDock tray icon. That opens pairing for 10 minutes, and this screen continues by itself."
        case "macos": return "Run `npm run info` on the Mac. That opens pairing for 10 minutes, and this screen continues by itself."
        default: return "Run `npm run info` on \(name). That opens pairing for 10 minutes, and this screen continues by itself."
        }
    }

    private func buildClosed() {
        addHeader(symbol: Theme.Icon.clock, tone: .neutral, title: "Pairing is closed on \(name)", body: Theme.rich(closedInstruction))
        left.setCustomSpacing(18, after: bodyLabel)
        statusSpinner.startAnimating()
        let status = UIStackView(arrangedSubviews: [statusSpinner, statusLabel])
        status.spacing = 8
        status.alignment = .center
        left.addArrangedSubview(status)
        let card = InstructionCard(symbol: Theme.Icon.info, tone: .accent,
                                   text: Theme.rich("The code you scanned still works once pairing opens again, so there's nothing to type.",
                                                    font: Theme.font(14), lineHeight: 1.4))
        right.addArrangedSubview(card)
        rightMaxWidth?.constant = 320
        dimmer = IdleDimmer(content: columns, host: view)
        startPolling()
        // As on S6: the spinner stops after 60 s; polling continues.
        retryTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in self?.statusSpinner.stopAnimating() }
    }

    // Q10

    private func buildCantReach() {
        addHeader(symbol: Theme.Icon.wifi, tone: .neutral, title: "Can't reach \(name)",
                  body: Theme.paragraph("The code says it's at \(link.address), but nothing answered there or on this network. WinDock keeps trying."))
        addLeftButtons([button("Try again", .primary, id: "qr-try-again", action: #selector(tryAgainTapped), primary: true),
                        button("Cancel", .secondary, id: "qr-cancel", action: #selector(cancelTapped), primary: false)])
        checksStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        right.addArrangedSubview(checksStack)
        fillChecks()
        dimmer = IdleDimmer(content: columns, host: view)
        scheduleRetry()
    }

    private func fillChecks() {
        checksStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let list = ConnectionRules.checks(phone: NetworkStatus.localIPv4(), hostIp: link.host, platform: platform,
                                          lastFailure: lastFailure, discoverySawAny: coordinator.discoverySawAny)
        var cards: [(String, NSAttributedString)] = []
        if otherDevice {
            cards.append(("A different device answered at \(link.address)",
                          rich("\(name) may have a new address. Scan the code again; it always shows the current one.")))
        }
        for check in list.checks {
            switch check {
            case let .differentNetwork(phoneIp, _):
                cards.append(("This phone is on a different network", rich("This phone is at `\(phoneIp)`. Join the same Wi-Fi as the computer.")))
            case .notRunning:
                cards.append(("WinDock is running on \(name)", rich(platform == "macos" ? "Its icon should be in the Mac's menu bar."
                                                                    : "Its icon should be in the taskbar tray, by the clock.")))
            case .isolation:
                cards.append(("The network lets devices see each other", rich("Guest, hotel and office Wi-Fi often keep devices apart.")))
            case .macFirewall:
                cards.append(("macOS allows incoming connections",
                              rich("If macOS asked about node, choose Allow. You can change it in System Settings → Network → Firewall.")))
            }
        }
        let likely = otherDevice ? 0 : list.likely
        for (index, card) in cards.prefix(3).enumerated() {
            checksStack.addArrangedSubview(CheckCard(number: index + 1, title: card.0, body: card.1, likely: likely == index))
        }
    }

    private func rich(_ text: String) -> NSAttributedString { Theme.rich(text, font: Theme.font(13), lineHeight: 1.4) }

    // Q11

    private func buildSecurityChanged() {
        guard case let .securityChanged(savedFingerprint, scanned) = plan else { return }
        addHeader(symbol: Theme.Icon.shield, tone: .danger, title: "\(name) has a new security code",
                  body: Theme.paragraph("The code you scanned doesn't match the one saved when this phone paired. That's expected if WinDock was reinstalled or reset. If you scanned it on \(name)'s own screen, it's safe to pair again.",
                                        font: Theme.font(14)))
        addLeftButtons([button("Pair again with the new code", .danger, id: "qr-pair-again", action: #selector(pairAgainTapped), primary: true),
                        button("Not now", .secondary, id: "qr-not-now", action: #selector(cancelTapped), primary: false)])
        let thenCard = CodeCard(key: "When you paired", code: CertificatePin.securityCode(savedFingerprint) ?? "—", current: false)
        let nowCard = CodeCard(key: "In the scanned code", code: CertificatePin.securityCode(scanned) ?? "—", current: true)
        right.addArrangedSubview(thenCard)
        right.setCustomSpacing(8, after: thenCard)
        right.addArrangedSubview(nowCard)
        accessibilityViewIsModal = true
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    // MARK: Pairing (section 10.6)

    @objc private func pairTapped() {
        guard phase == .idle else { return }
        setPhase(.pairing)
        if case .openPaired = plan {
            session.locate(discoveryWait: 8) { [weak self] located in
                guard let self else { return }
                if case .found(let found) = located {
                    self.coordinator.openPairedFromLink(self.link.hostId, at: found.endpoint)
                } else {
                    self.coordinator.openPairedFromLink(self.link.hostId, at: nil)
                }
            }
            return
        }
        session.locate(discoveryWait: 8) { [weak self] in self?.located($0) }
    }

    @objc private func pairAgainTapped() {
        // The pin is replaced only once the scanned code has paired (`ConnectionCoordinator.paired`).
        plan = .confirm(again: true)
        again = true
        phase = .pairing
        show(.confirm)
        session.locate(discoveryWait: 8) { [weak self] in self?.located($0) }
    }

    private func located(_ result: QRPairingSession.Located) {
        switch result {
        case .found(let found):
            self.found = found
            if found.info.pairingOpen == false {
                show(.closed)
            } else {
                authenticate()
            }
        case .notFound(let other, let failure):
            otherDevice = other
            lastFailure = failure
            if screen == .cantReach { fillChecks(); scheduleRetry() } else { show(.cantReach) }
        }
    }

    private func authenticate() {
        guard let found, !authInFlight else { return }
        authInFlight = true
        session.authenticate(at: found.endpoint, deviceName: coordinator.deviceName) { [weak self] outcome in
            guard let self else { return }
            self.authInFlight = false
            self.handle(outcome)
        }
    }

    private func handle(_ outcome: AuthOutcome) {
        switch outcome {
        case .paired(let cookies):
            paired(cookies)
        case .wrongPin, .invalid:
            phase = .idle
            show(.used)
        case .closed:
            phase = .idle
            if screen == .closed { startPolling() } else { show(.closed) }
        case .locked(let retryInMs):
            let until = Date().addingTimeInterval(Double(retryInMs) / 1000)
            if screen == .confirm {
                setPhase(.locked(until: until))
            } else {
                phase = .locked(until: until)
                show(.confirm)
                setPhase(.locked(until: until))
            }
        case .failed:
            lastFailure = .other
            phase = .idle
            if screen == .cantReach { fillChecks(); scheduleRetry() } else { show(.cantReach) }
        }
    }

    /// Q7: ✓ "Paired. Opening the dock…" (success haptic, at least 400 ms), then the dock.
    private func paired(_ cookies: [HTTPCookie]) {
        guard let found else { return }
        if screen != .confirm {
            phase = .paired
            show(.confirm)
        }
        setPhase(.paired)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        pairedAt = Date()
        let context = coordinator.pairingContext(for: link, found: found)
        coordinator.paired(context, cookies: cookies) { [weak self] in self?.dockReady() }
    }

    private func dockReady() {
        let hold = max(0, 0.4 - Date().timeIntervalSince(pairedAt ?? Date()))
        DispatchQueue.main.asyncAfter(deadline: .now() + hold) { [weak self] in
            self?.coordinator.root?.dismissModals(animated: true)
        }
    }

    // Q9: poll every 2 s; when open, retry once with the scanned PIN.
    private func startPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func poll() {
        guard screen == .closed, !authInFlight, let found else { return }
        session.pollPairingOpen(at: found.endpoint) { [weak self] open in
            guard let self, self.screen == .closed, open == true, !self.authInFlight else { return }
            self.pollTimer?.invalidate()
            self.authenticate()
        }
    }

    // Q10: retries continue while visible (3, 5, 10, then 15 s).
    private func scheduleRetry() {
        retryTimer?.invalidate()
        let delay = ConnectionRules.retryDelay(attempt: retryAttempt)
        retryAttempt += 1
        retryTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in self?.retry() }
    }

    private func retry() {
        guard screen == .cantReach else { return }
        retryTimer?.invalidate()
        session.cancel()
        session.locate(discoveryWait: 0) { [weak self] in self?.located($0) }
    }

    @objc private func tryAgainTapped() {
        retryAttempt = 0
        retry()
    }

    // MARK: Leaving

    private func stopTimers() {
        pollTimer?.invalidate()
        pollTimer = nil
        retryTimer?.invalidate()
        retryTimer = nil
    }

    private func stopEverything() {
        stopTimers()
        countdown?.invalidate()
        session.cancel()
    }

    @objc private func cancelTapped() {
        guard phase != .paired else { return }
        stopEverything()
        coordinator.pairingLinkClosed()
    }

    @objc private func scanAgainTapped() {
        stopEverything()
        coordinator.scanAgain()
    }

    @objc private func pinInsteadTapped() {
        guard let found else { scanAgainTapped(); return }
        stopEverything()
        coordinator.enterPinInstead(coordinator.pairingContext(for: link, found: found))
    }
}

/// Q5's card: "Address" and "Security code" rows (values in mono 15), split by a hairline.
final class DetailsCard: UIView {
    init(rows: [(key: String, value: String, isCode: Bool)]) {
        super.init(frame: .zero)
        backgroundColor = Theme.row
        layer.cornerRadius = 16
        layer.cornerCurve = .continuous
        let stack = UIStackView()
        stack.axis = .vertical
        addSubview(stack)
        stack.pinEdges(to: self)
        for (index, row) in rows.enumerated() {
            if index > 0 {
                let line = UIView()
                line.backgroundColor = Theme.line
                line.translatesAutoresizingMaskIntoConstraints = false
                let holder = UIView()
                holder.addSubview(line)
                NSLayoutConstraint.activate([
                    line.heightAnchor.constraint(equalToConstant: 1),
                    line.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 16),
                    line.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
                    line.topAnchor.constraint(equalTo: holder.topAnchor),
                    line.bottomAnchor.constraint(equalTo: holder.bottomAnchor)
                ])
                stack.addArrangedSubview(holder)
            }
            let key = Theme.label(row.key, font: Theme.body, color: Theme.text2)
            key.setContentHuggingPriority(.required, for: .horizontal)
            key.widthAnchor.constraint(equalToConstant: 112).isActive = true
            let value = UILabel()
            value.adjustsFontForContentSizeCategory = true
            value.numberOfLines = 1
            value.adjustsFontSizeToFitWidth = true
            value.minimumScaleFactor = 0.7
            if row.isCode {
                value.attributedText = securityCodeText(row.value, size: 15, color: Theme.text)
            } else {
                value.font = Theme.font(15, mono: true)
                value.textColor = Theme.text
                value.text = row.value
            }
            let line = UIStackView(arrangedSubviews: [key, value])
            line.spacing = 12
            line.alignment = .firstBaseline
            line.isLayoutMarginsRelativeArrangement = true
            line.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 15, leading: 16, bottom: 15, trailing: 16)
            line.isAccessibilityElement = true
            line.accessibilityLabel = row.key
            line.accessibilityAttributedValue = row.isCode ? spokenCode(row.value) : NSAttributedString(string: row.value)
            line.accessibilityIdentifier = row.isCode ? "qr-security-code" : "qr-address"
            stack.addArrangedSubview(line)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
