import UIKit

/// Pairing (S5 step 1: security code; S6 step 2: PIN, with wrong / locked / closed / paired states).
/// Mockups 10, 12, 14. Presented full screen with the fade / scale transition.
final class PairingViewController: ScreenViewController, UITextFieldDelegate, FocusProviding {
    enum Phase: Equatable { case code, noMatch, closed, pin }
    enum PinState: Equatable { case entering, sending, wrong, locked(until: Date), paired, failed }

    private(set) var context: PairingContext
    private unowned let coordinator: ConnectionCoordinator
    private(set) var phase: Phase = .code
    private(set) var pinState: PinState = .entering
    private var hadWrongPin = false
    private var pollTimer: Timer?
    private var countdown: Timer?
    private var spinnerTimer: Timer?
    private var dimmer: IdleDimmer?
    private var pairedAt: Date?

    // Two-column layout (step 1, closed, no match)
    private let twoColumn = UIView()
    private let leftColumn = UIStackView()
    private let rightColumn = UIStackView()
    private let columns = UIStackView()
    private let twoColumnScroll = UIScrollView()
    private let stepper = StepperView()
    private var leftWidth: NSLayoutConstraint?
    let matchButton = ThemedButton("Codes match", kind: .primary)
    let noMatchButton = ThemedButton("They don't match", kind: .secondary)
    /// Section 10.1: the computer shows the QR code right next to the security code.
    let scanInsteadButton = ThemedButton("Scan the QR code instead", kind: .ghost)
    private let closedStatus = Theme.label("Waiting for pairing to open", font: Theme.body, color: Theme.text2)
    private let closedSpinner = makeSpinner()
    private let closedBody = Theme.label(font: Theme.body, color: Theme.text2)
    let headingLabel = Theme.label(font: Theme.title)

    // Compact layout (PIN entry with the keyboard up)
    private let compact = UIView()
    private let topTitle = Theme.label(font: Theme.headline, lines: 2, alignment: .center)
    private let stepCaption = Theme.label(font: Theme.font(13), color: Theme.text3)
    let pinField = UITextField()
    private let pinBoxes = PinBoxesView()
    private let pinCaption = Theme.label(font: Theme.font(13), color: Theme.text3, alignment: .center)
    private let pinCaptionIcon = UIImageView()
    private let pinSpinner = makeSpinner(color: Theme.text3)
    private let closeButton = IconButton(symbol: Theme.Icon.close, label: "Cancel pairing")
    private let compactClose = IconButton(symbol: Theme.Icon.close, label: "Cancel pairing")

    var initialFocus: UIView? { phase == .pin ? pinBoxes : headingLabel }
    var pinErrorText: String? { pinState == .wrong || pinState == .failed || isLocked ? pinCaption.text : nil }
    private var isLocked: Bool { if case .locked = pinState { return true } else { return false } }

    init(context: PairingContext, coordinator: ConnectionCoordinator) {
        self.context = context
        self.coordinator = coordinator
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "pairing"
        buildTwoColumn()
        buildCompact()
        if context.hasSecurityStep {
            showCode()
        } else if context.pairingOpen {
            enterPin(animated: false)
        } else {
            showClosed(animated: false)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if phase == .pin, pinField.isEnabled { pinField.becomeFirstResponder() }
        UIAccessibility.post(notification: .screenChanged, argument: initialFocus)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopPolling()
        countdown?.invalidate()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: { _ in self.updateColumns() })
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { updateColumns() }
    }

    override func accessibilityPerformEscape() -> Bool {
        closeTapped()
        return true
    }

    // MARK: Layout

    private var name: String { context.displayName }

    private func buildTwoColumn() {
        view.addSubview(twoColumn)
        twoColumn.pinEdges(to: view)
        closeButton.accessibilityIdentifier = "pair-close"
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        twoColumn.addSubview(twoColumnScroll)
        twoColumn.addSubview(closeButton)
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            closeButton.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            closeButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 12)
        ])
        twoColumnScroll.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            twoColumnScroll.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            twoColumnScroll.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            twoColumnScroll.topAnchor.constraint(equalTo: closeButton.bottomAnchor, constant: 4),
            twoColumnScroll.bottomAnchor.constraint(equalTo: safe.bottomAnchor)
        ])
        columns.spacing = 40
        columns.alignment = .center
        leftColumn.axis = .vertical
        leftColumn.alignment = .leading
        rightColumn.axis = .vertical
        rightColumn.alignment = .leading
        columns.addArrangedSubview(leftColumn)
        columns.addArrangedSubview(rightColumn)
        twoColumnScroll.addSubview(columns)
        columns.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            columns.leadingAnchor.constraint(equalTo: twoColumnScroll.contentLayoutGuide.leadingAnchor),
            columns.trailingAnchor.constraint(equalTo: twoColumnScroll.contentLayoutGuide.trailingAnchor),
            columns.topAnchor.constraint(equalTo: twoColumnScroll.contentLayoutGuide.topAnchor),
            columns.bottomAnchor.constraint(equalTo: twoColumnScroll.contentLayoutGuide.bottomAnchor, constant: -40),
            columns.widthAnchor.constraint(equalTo: twoColumnScroll.frameLayoutGuide.widthAnchor),
            columns.heightAnchor.constraint(greaterThanOrEqualTo: twoColumnScroll.frameLayoutGuide.heightAnchor, constant: -40)
        ])
        // Identity row + stepper.
        let identity = IdentityRow(name: name, platform: context.platform, address: context.endpoint.host ?? "")
        leftColumn.addArrangedSubview(identity)
        leftColumn.setCustomSpacing(20, after: identity)
        stepper.configure(step1: context.hasSecurityStep || context.presented != nil ? .current : nil, step2: .upcoming)
        leftColumn.addArrangedSubview(stepper)
        headingLabel.accessibilityTraits = .header
        matchButton.accessibilityIdentifier = "codes-match"
        noMatchButton.accessibilityIdentifier = "codes-differ"
        matchButton.addTarget(self, action: #selector(codesMatch), for: .touchUpInside)
        noMatchButton.addTarget(self, action: #selector(codesDiffer), for: .touchUpInside)
        scanInsteadButton.accessibilityIdentifier = "scan-instead"
        scanInsteadButton.addTarget(self, action: #selector(scanInstead), for: .touchUpInside)
        updateColumns()
    }

    private func updateColumns() {
        let single = traitCollection.prefersSingleColumn
        columns.axis = single ? .vertical : .horizontal
        columns.alignment = single ? .fill : .center
        leftWidth?.isActive = false
        if !single {
            leftWidth = leftColumn.widthAnchor.constraint(equalToConstant: view.bounds.width >= 900 ? 270 : 250)
            leftWidth?.isActive = true
        }
    }

    private func buildCompact() {
        view.addSubview(compact)
        compact.pinEdges(to: view)
        compact.isHidden = true
        let safe = view.safeAreaLayoutGuide
        compactClose.accessibilityIdentifier = "pin-close"
        compactClose.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        topTitle.accessibilityTraits = .header
        stepCaption.setContentHuggingPriority(.required, for: .horizontal)
        for subview in [compactClose, topTitle, stepCaption, pinBoxes, pinField] as [UIView] {
            subview.translatesAutoresizingMaskIntoConstraints = false
            compact.addSubview(subview)
        }
        let captionRow = UIStackView(arrangedSubviews: [pinSpinner, pinCaptionIcon, pinCaption])
        captionRow.spacing = 6
        captionRow.alignment = .center
        captionRow.translatesAutoresizingMaskIntoConstraints = false
        compact.addSubview(captionRow)
        pinCaptionIcon.isHidden = true
        pinCaptionIcon.isAccessibilityElement = false
        pinCaption.accessibilityIdentifier = "pin-caption"
        NSLayoutConstraint.activate([
            compactClose.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            compactClose.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8),
            topTitle.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
            topTitle.centerYAnchor.constraint(equalTo: compactClose.centerYAnchor),
            topTitle.leadingAnchor.constraint(greaterThanOrEqualTo: compactClose.trailingAnchor, constant: 12),
            topTitle.trailingAnchor.constraint(lessThanOrEqualTo: stepCaption.leadingAnchor, constant: -12),
            stepCaption.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -4),
            stepCaption.centerYAnchor.constraint(equalTo: compactClose.centerYAnchor),
            pinBoxes.topAnchor.constraint(equalTo: compactClose.bottomAnchor, constant: 8),
            pinBoxes.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
            captionRow.topAnchor.constraint(equalTo: pinBoxes.bottomAnchor, constant: 12),
            captionRow.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
            captionRow.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 16),
            captionRow.trailingAnchor.constraint(lessThanOrEqualTo: safe.trailingAnchor, constant: -16),
            captionRow.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor, constant: -8),
            pinField.widthAnchor.constraint(equalToConstant: 1), pinField.heightAnchor.constraint(equalToConstant: 1),
            pinField.leadingAnchor.constraint(equalTo: pinBoxes.leadingAnchor), pinField.topAnchor.constraint(equalTo: pinBoxes.topAnchor)
        ])
        // One text field drawn as six boxes.
        pinField.keyboardType = .numberPad
        pinField.textContentType = .oneTimeCode
        pinField.autocorrectionType = .no
        pinField.keyboardAppearance = .dark
        pinField.tintColor = .clear
        pinField.textColor = .clear
        pinField.alpha = 0.02
        pinField.delegate = self
        pinField.accessibilityIdentifier = "pin-field"
        pinField.isAccessibilityElement = false
        pinField.addTarget(self, action: #selector(pinChanged), for: .editingChanged)
        pinBoxes.onTap = { [weak self] in self?.pinField.becomeFirstResponder() }
        pinBoxes.onActivate = { [weak self] in
            guard let self else { return false }
            if self.pinField.text?.count == 6 { self.submit(); return true }
            self.pinField.becomeFirstResponder()
            return true
        }
    }

    // MARK: Phases

    private func resetRight() {
        rightColumn.arrangedSubviews.forEach { $0.removeFromSuperview() }
    }

    private func showCode() {
        phase = .code
        resetRight()
        guard let presented = context.presented, let code = CertificatePin.securityCode(presented) else { return }
        headingLabel.text = "Does this match your computer?"
        headingLabel.font = Theme.label
        headingLabel.textColor = Theme.text2
        let codeLabel = UILabel()
        codeLabel.adjustsFontForContentSizeCategory = true
        codeLabel.attributedText = securityCodeText(code, size: view.bounds.width >= 900 ? 38 : 34, color: Theme.text)
        codeLabel.adjustsFontSizeToFitWidth = true
        codeLabel.minimumScaleFactor = 0.6
        codeLabel.isAccessibilityElement = true
        codeLabel.accessibilityLabel = "Security code"
        codeLabel.accessibilityAttributedValue = spokenCode(code)
        codeLabel.accessibilityIdentifier = "security-code"
        let card = InstructionCard(symbol: Theme.Icon.monitor, text: Theme.rich(codeInstruction, font: Theme.font(14), lineHeight: 1.4))
        let buttons = UIStackView(arrangedSubviews: [matchButton, noMatchButton])
        buttons.spacing = 12
        for view in [headingLabel, codeLabel, card, buttons, scanInsteadButton] as [UIView] { rightColumn.addArrangedSubview(view) }
        rightColumn.setCustomSpacing(8, after: headingLabel)
        rightColumn.setCustomSpacing(18, after: codeLabel)
        rightColumn.setCustomSpacing(20, after: card)
        rightColumn.setCustomSpacing(8, after: buttons)
        card.widthAnchor.constraint(equalTo: rightColumn.widthAnchor).isActive = true
        stepper.configure(step1: .current, step2: .upcoming)
    }

    private var codeInstruction: String {
        if context.hostUi {
            switch context.platform {
            case "windows": return "On \(name), click the WinDock icon in the taskbar tray, by the clock, and choose Pair a new phone."
            case "macos": return "On the Mac, click the WinDock icon in the menu bar and choose Pair a new phone."
            default: break
            }
        }
        switch context.platform {
        case "windows": return "On \(name), click the WinDock icon in the taskbar tray, by the clock, and choose **Show connection info**."
        case "macos": return "On the Mac, open Terminal in the WinDock folder and run `npm run info`."
        default: return "Open WinDock's connection info on \(name)."
        }
    }

    private var closedInstruction: String {
        if context.hostUi {
            switch context.platform {
            case "windows": return "Click the WinDock icon in the taskbar tray and choose Pair a new phone. That opens pairing for 10 minutes, and this screen continues by itself."
            case "macos": return "Click the WinDock icon in the Mac's menu bar and choose Pair a new phone. That opens pairing for 10 minutes, and this screen continues by itself."
            default: break
            }
        }
        switch context.platform {
        case "windows": return "Choose **Show connection info** from the WinDock tray icon. That opens pairing for 10 minutes, and this screen continues by itself."
        case "macos": return "Run `npm run info` on the Mac. That opens pairing for 10 minutes, and this screen continues by itself."
        default: return "Run `npm run info` on \(name). That opens pairing for 10 minutes, and this screen continues by itself."
        }
    }

    @objc private func codesMatch() {
        // The fingerprint is pinned for this pairing; it is stored with the computer on success.
        Motion.crossfade(stepper) { self.stepper.configure(step1: .done, step2: .current) }
        if context.pairingOpen { enterPin(animated: true) } else { showClosed(animated: true) }
    }

    @objc private func codesDiffer() {
        phase = .noMatch
        let glyph = GlyphTile(symbol: Theme.Icon.shield, tone: .danger, size: 56)
        headingLabel.text = "Don't pair with this computer"
        headingLabel.font = Theme.title
        headingLabel.textColor = Theme.text
        let body = Theme.label(font: Theme.body, color: Theme.text2)
        body.attributedText = Theme.paragraph("If the codes are different, another device on this network may be answering for \(name). Check that you picked the right computer, then try again.")
        let back = ThemedButton("Back to computers", kind: .primary)
        back.accessibilityIdentifier = "pair-back"
        back.addTarget(self, action: #selector(backToComputers), for: .touchUpInside)
        slideRight {
            self.resetRight()
            for view in [glyph, self.headingLabel, body, back] as [UIView] { self.rightColumn.addArrangedSubview(view) }
            self.rightColumn.setCustomSpacing(18, after: glyph)
            self.rightColumn.setCustomSpacing(8, after: self.headingLabel)
            self.rightColumn.setCustomSpacing(22, after: body)
        }
        UIAccessibility.post(notification: .screenChanged, argument: headingLabel)
    }

    @objc private func backToComputers() { coordinator.pairingRejected() }

    @objc private func scanInstead() { coordinator.presentScanner() }

    private func showClosed(animated: Bool) {
        phase = .closed
        view.endEditing(true)
        compact.isHidden = true
        twoColumn.isHidden = false
        twoColumn.alpha = 1
        stepper.configure(step1: context.presented != nil ? .done : nil, step2: .current)
        let glyph = GlyphTile(symbol: Theme.Icon.clock, tone: .neutral, size: 56)
        headingLabel.text = "Pairing is closed on \(name)"
        headingLabel.font = Theme.title
        headingLabel.textColor = Theme.text
        let prefix = hadWrongPin ? "Too many wrong PINs, so \(name) closed pairing. " : ""
        closedBody.attributedText = Theme.rich(prefix + closedInstruction)
        closedStatus.text = "Waiting for pairing to open"
        closedSpinner.startAnimating()
        let status = UIStackView(arrangedSubviews: [closedSpinner, closedStatus])
        status.spacing = 8
        status.alignment = .center
        let change = {
            self.resetRight()
            for view in [glyph, self.headingLabel, self.closedBody, status] as [UIView] { self.rightColumn.addArrangedSubview(view) }
            self.rightColumn.setCustomSpacing(18, after: glyph)
            self.rightColumn.setCustomSpacing(8, after: self.headingLabel)
            self.rightColumn.setCustomSpacing(18, after: self.closedBody)
        }
        if animated { slideRight(change) } else { change() }
        startPolling()
        dimmer = dimmer ?? IdleDimmer(content: twoColumn, host: view)
        dimmer?.restart()
        spinnerTimer?.invalidate()
        spinnerTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in self?.closedSpinner.stopAnimating() }
        UIAccessibility.post(notification: .screenChanged, argument: headingLabel)
    }

    /// Step 1 → step 2 and back: outgoing −16 + fade (140 ms), incoming 16 → 0 + fade (220 ms at 60 ms).
    private func slideRight(_ change: @escaping () -> Void) {
        guard !Motion.reduced else {
            Motion.crossfade(rightColumn, change)
            return
        }
        Motion.easeOut(0.14, {
            self.rightColumn.alpha = 0
            self.rightColumn.transform = CGAffineTransform(translationX: -16, y: 0)
        }) { _ in
            change()
            self.rightColumn.transform = CGAffineTransform(translationX: 16, y: 0)
            Motion.easeOut(0.22, {
                self.rightColumn.alpha = 1
                self.rightColumn.transform = .identity
            })
        }
    }

    private func enterPin(animated: Bool) {
        phase = .pin
        stopPolling()
        dimmer?.stop()
        topTitle.text = context.revoked ? "\(name) no longer recognizes this phone" : "Enter the PIN from \(name)"
        stepCaption.text = context.presented == nil && !context.revoked ? "1 of 1" : "2 of 2"
        setPinState(.entering)
        let show = {
            self.compact.isHidden = false
            self.compact.alpha = 1
            self.compact.transform = .identity
            self.twoColumn.isHidden = true
        }
        if animated && compact.isHidden {
            compact.alpha = 0
            compact.isHidden = false
            if !Motion.reduced { compact.transform = CGAffineTransform(translationX: 16, y: 0) }
            Motion.easeOut(Motion.reduced ? 0.15 : 0.14, {
                self.twoColumn.alpha = 0
                if !Motion.reduced { self.twoColumn.transform = CGAffineTransform(translationX: -16, y: 0) }
            }) { _ in
                self.twoColumn.isHidden = true
                self.twoColumn.alpha = 1
                self.twoColumn.transform = .identity
            }
            Motion.easeOut(Motion.reduced ? 0.15 : 0.22, delay: Motion.reduced ? 0 : 0.06, {
                self.compact.alpha = 1
                self.compact.transform = .identity
            })
        } else {
            show()
        }
        pinField.isEnabled = true
        pinField.becomeFirstResponder()
        UIAccessibility.post(notification: .screenChanged, argument: pinBoxes)
    }

    // MARK: Closed window polling (every 3 s while visible)

    private func startPolling() {
        stopPolling()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func poll() {
        guard phase == .closed, view.window != nil else { return }
        coordinator.pollPairing(context) { [weak self] open in
            guard let self, self.phase == .closed, open == true else { return }
            self.context.pairingOpen = true
            self.enterPin(animated: true)
        }
    }

    // MARK: PIN entry

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        guard pinState != .sending, pinState != .paired, !isLocked else { return false }
        let digits = string.filter(\.isASCII).filter(\.isNumber)
        if pinState == .wrong || pinState == .failed {
            // The next keypress clears the wrong digits and starts over.
            textField.text = String(digits.prefix(6))
            setPinState(.entering)
            pinChanged()
            return false
        }
        let current = (textField.text ?? "") as NSString
        let next = current.replacingCharacters(in: range, with: digits)
        guard next.count <= 6 else {
            textField.text = String(next.prefix(6))
            pinChanged()
            return false
        }
        return digits.count == string.count
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField.text?.count == 6 { submit() }
        return false
    }

    @objc private func pinChanged() {
        let text = String((pinField.text ?? "").filter(\.isNumber).prefix(6))
        if pinField.text != text { pinField.text = text }
        pinBoxes.update(digits: text, focused: pinState == .entering, error: pinState == .wrong)
        if text.count == 6, pinState == .entering { submit() }
    }

    private func submit() {
        guard let pin = pinField.text, pin.count == 6, pinState == .entering else { return }
        setPinState(.sending)
        coordinator.submitPIN(pin, context: context) { [weak self] outcome in
            self?.handle(outcome)
        }
    }

    private func handle(_ outcome: AuthOutcome) {
        switch outcome {
        case .paired(let cookies):
            setPinState(.paired)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            pairedAt = Date()
            coordinator.paired(context, cookies: cookies) { [weak self] in self?.dockReady() }
        case .wrongPin, .invalid:
            hadWrongPin = true
            setPinState(.wrong)
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            pinBoxes.shake()
        case .locked(let retryInMs):
            setPinState(.locked(until: Date().addingTimeInterval(Double(retryInMs) / 1000)))
        case .closed:
            pinField.text = ""
            context.pairingOpen = false
            showClosed(animated: true)
        case .failed:
            setPinState(.failed)
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    /// The "Paired" caption is held until the dock is ready, at least 400 ms.
    private func dockReady() {
        let hold = max(0, 0.4 - Date().timeIntervalSince(pairedAt ?? Date()))
        DispatchQueue.main.asyncAfter(deadline: .now() + hold) { [weak self] in
            self?.view.endEditing(true)
            self?.coordinator.root?.dismissModals(animated: true)
        }
    }

    private func setPinState(_ state: PinState) {
        pinState = state
        countdown?.invalidate()
        pinSpinner.stopAnimating()
        pinCaptionIcon.isHidden = true
        pinBoxes.alpha = state == .sending ? 0.6 : 1
        pinCaption.textColor = Theme.text3
        switch state {
        case .entering:
            pinCaption.text = "It's on the same screen as the security code."
            pinField.isEnabled = true
        case .sending:
            pinSpinner.startAnimating()
            pinCaption.text = nil
        case .wrong:
            showError("That PIN didn't work. Check the 6 digits on \(name) and try again.")
        case .failed:
            showError("Couldn't reach \(name). Check that WinDock is still running on it, then try again.")
        case .locked(let until):
            pinField.text = ""
            pinField.isEnabled = true
            tickLock(until)
            countdown = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tickLock(until) }
        case .paired:
            Motion.crossfade(pinCaption) {
                self.pinCaption.text = "Paired"
                self.pinCaption.textColor = Theme.accent
                self.pinCaptionIcon.image = Theme.symbol(Theme.Icon.check, size: 13, weight: .semibold)
                self.pinCaptionIcon.tintColor = Theme.accent
                self.pinCaptionIcon.isHidden = false
            }
            UIAccessibility.post(notification: .announcement, argument: "Paired")
        }
        pinBoxes.update(digits: pinField.text ?? "", focused: state == .entering,
                        error: state == .wrong, disabled: isLocked)
        pinBoxes.accessibilityValue = pinBoxes.spokenValue(pinField.text ?? "")
    }

    private func showError(_ message: String) {
        pinCaption.text = message
        pinCaption.textColor = Theme.dangerText
        pinCaptionIcon.image = Theme.symbol(Theme.Icon.warning, size: 13, weight: .regular)
        pinCaptionIcon.tintColor = Theme.dangerText
        pinCaptionIcon.isHidden = false
        UIAccessibility.post(notification: .announcement, argument: message)
    }

    private func tickLock(_ until: Date) {
        let remaining = Int(ceil(until.timeIntervalSinceNow))
        guard remaining > 0 else {
            countdown?.invalidate()
            setPinState(.entering)
            pinField.becomeFirstResponder()
            return
        }
        pinCaption.text = String(format: "Too many tries from this phone. Try again in %d:%02d.", remaining / 60, remaining % 60)
        pinCaption.textColor = Theme.dangerText
        pinBoxes.update(digits: "", focused: false, error: false, disabled: true)
    }

    @objc private func closeTapped() {
        guard pinState != .paired else { return }
        view.endEditing(true)
        stopPolling()
        coordinator.pairingCancelled(context)
    }
}

/// Glyph + name + "Windows · 192.168.1.52".
final class IdentityRow: UIStackView {
    init(name: String, platform: String, address: String) {
        super.init(frame: .zero)
        let glyph = GlyphTile(symbol: Theme.Icon.monitor)
        let title = Theme.label(name, font: Theme.font(19, .semibold), lines: 2)
        let subtitle = Theme.label(font: Theme.subhead, color: Theme.text2, lines: 1)
        let text = NSMutableAttributedString()
        if let word = Computer.platformWord(platform) {
            text.append(NSAttributedString(string: word + "  ·  ", attributes: [.font: Theme.subhead, .foregroundColor: Theme.text2]))
        }
        text.append(NSAttributedString(string: address, attributes: [.font: Theme.font(12, mono: true), .foregroundColor: Theme.text3]))
        subtitle.attributedText = text
        let labels = UIStackView(arrangedSubviews: [title, subtitle])
        labels.axis = .vertical
        labels.spacing = 2
        addArrangedSubview(glyph)
        addArrangedSubview(labels)
        spacing = 14
        alignment = .center
        isAccessibilityElement = true
        accessibilityLabel = [name, Computer.platformWord(platform), address].compactMap { $0 }.joined(separator: ", ")
    }
    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// Two-step indicator with 26 pt rings: current, upcoming, done.
final class StepperView: UIStackView {
    enum State { case current, upcoming, done }
    private let one = StepRow()
    private let two = StepRow()

    init() {
        super.init(frame: .zero)
        axis = .vertical
        spacing = 14
        alignment = .leading
        addArrangedSubview(one)
        addArrangedSubview(two)
    }
    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// `step1` nil: hosts without TLS have no security step ("1 of 1").
    func configure(step1: State?, step2: State) {
        one.isHidden = step1 == nil
        let total = step1 == nil ? 1 : 2
        if let step1 {
            one.configure(number: 1, title: step1 == .done ? "Security code checked" : "Check the security code", state: step1, total: total)
        }
        two.configure(number: step1 == nil ? 1 : 2, title: "Enter the PIN", state: step2, total: total)
    }
}

final class StepRow: UIStackView {
    private let ring = UILabel()
    private let check = UIImageView(image: Theme.symbol(Theme.Icon.check, size: 12, weight: .bold))
    private let title = Theme.label(font: Theme.body)
    private let badge = UIView()

    init() {
        super.init(frame: .zero)
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.layer.cornerRadius = 13
        NSLayoutConstraint.activate([badge.widthAnchor.constraint(equalToConstant: 26), badge.heightAnchor.constraint(equalToConstant: 26)])
        ring.font = Theme.font(13, .semibold)
        ring.textAlignment = .center
        check.tintColor = Theme.accent
        for view in [ring, check] as [UIView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            badge.addSubview(view)
            NSLayoutConstraint.activate([view.centerXAnchor.constraint(equalTo: badge.centerXAnchor), view.centerYAnchor.constraint(equalTo: badge.centerYAnchor)])
        }
        addArrangedSubview(badge)
        addArrangedSubview(title)
        spacing = 12
        alignment = .center
        isAccessibilityElement = true
    }
    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(number: Int, title text: String, state: StepperView.State, total: Int) {
        ring.text = "\(number)"
        title.text = text
        switch state {
        case .current:
            badge.layer.borderWidth = 1.5
            badge.layer.borderColor = Theme.accent.cgColor
            badge.backgroundColor = .clear
            ring.textColor = Theme.accent
            ring.isHidden = false
            check.isHidden = true
            title.textColor = Theme.text
            title.font = Theme.font(15, .semibold)
        case .upcoming:
            badge.layer.borderWidth = 1.5
            badge.layer.borderColor = Theme.idle.cgColor
            badge.backgroundColor = .clear
            ring.textColor = Theme.text3
            ring.isHidden = false
            check.isHidden = true
            title.textColor = Theme.text3
            title.font = Theme.font(15)
        case .done:
            badge.layer.borderWidth = 0
            badge.backgroundColor = Theme.accentTint
            ring.isHidden = true
            check.isHidden = false
            title.textColor = Theme.text2
            title.font = Theme.font(15)
        }
        let word: String
        switch state { case .current: word = "current"; case .upcoming: word = "upcoming"; case .done: word = "done" }
        accessibilityLabel = "Step \(number) of \(total), \(text), \(word)"
    }
}

/// Six 46 × 56 boxes (extra 10 after the third); one accessibility element for the whole PIN.
final class PinBoxesView: UIView {
    var onTap: (() -> Void)?
    var onActivate: (() -> Bool)?
    private var boxes: [UILabel] = []
    private var carets: [UIView] = []
    private let row = UIStackView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        row.spacing = 8
        row.alignment = .center
        for index in 0..<6 {
            let box = UILabel()
            box.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 26, weight: .medium), maximumPointSize: 34)
            box.textColor = Theme.text
            box.textAlignment = .center
            box.backgroundColor = Theme.field
            box.layer.cornerRadius = 12
            box.layer.cornerCurve = .continuous
            box.layer.masksToBounds = true
            box.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([box.widthAnchor.constraint(equalToConstant: 46), box.heightAnchor.constraint(equalToConstant: 56)])
            let caret = UIView()
            caret.backgroundColor = Theme.accent
            caret.layer.cornerRadius = 1
            caret.translatesAutoresizingMaskIntoConstraints = false
            box.addSubview(caret)
            NSLayoutConstraint.activate([
                caret.widthAnchor.constraint(equalToConstant: 2), caret.heightAnchor.constraint(equalToConstant: 26),
                caret.centerXAnchor.constraint(equalTo: box.centerXAnchor), caret.centerYAnchor.constraint(equalTo: box.centerYAnchor)
            ])
            boxes.append(box)
            carets.append(caret)
            row.addArrangedSubview(box)
            if index == 2 { row.setCustomSpacing(18, after: box) }
        }
        addSubview(row)
        row.pinEdges(to: self)
        isAccessibilityElement = true
        accessibilityLabel = "PIN, 6 digits"
        accessibilityTraits = .updatesFrequently
        accessibilityIdentifier = "pin-boxes"
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        update(digits: "", focused: true, error: false)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func tapped() { onTap?() }

    override func accessibilityActivate() -> Bool { onActivate?() ?? false }

    func spokenValue(_ digits: String) -> String {
        let spoken = digits.map(String.init).joined(separator: " ")
        return spoken.isEmpty ? "0 of 6" : "\(spoken), \(digits.count) of 6"
    }

    func update(digits: String, focused: Bool, error: Bool, disabled: Bool = false) {
        let characters = Array(digits)
        for (index, box) in boxes.enumerated() {
            box.text = index < characters.count ? String(characters[index]) : nil
            let current = focused && !error && !disabled && index == min(characters.count, 5) && characters.count < 6
            box.layer.borderWidth = current ? 2 : (error ? 1.5 : 1)
            box.layer.borderColor = (current ? Theme.accent : (error ? Theme.dangerLine : Theme.lineStrong)).cgColor
            box.textColor = error ? Theme.dangerText : Theme.text
            box.alpha = disabled ? 0.5 : 1
            carets[index].isHidden = !current
        }
        accessibilityValue = spokenValue(digits)
    }

    /// translateX 0, −10, 8, −6, 4, 0 over 320 ms; no shake with Reduce Motion (border colour + haptic only).
    func shake() {
        guard !Motion.reduced else { return }
        let animation = CAKeyframeAnimation(keyPath: "transform.translation.x")
        animation.values = [0, -10, 8, -6, 4, 0]
        animation.duration = 0.32
        animation.calculationMode = .linear
        row.layer.add(animation, forKey: "shake")
    }
}
