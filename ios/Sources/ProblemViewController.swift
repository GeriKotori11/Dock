import UIKit

/// S8 Can't reach, S9 No Wi-Fi, S10 Security code changed, S11 Local Network off, and the two
/// dock load failures. Two columns that collapse into one scrolling column at large text sizes.
final class ProblemViewController: ScreenViewController, FocusProviding {
    enum Problem: Equatable {
        case cantReach(name: String, platform: String, checks: ConnectionRules.CheckList)
        case noWifi(name: String)
        case securityChanged(hostId: String, name: String, then: String, now: String)
        case localNetworkOff
        case dockFailed(name: String)
        case dockTimeout(name: String)
    }

    private(set) var problem: Problem
    var onPrimary: (() -> Void)?
    /// `/health.hostUi` of this computer: "Pair a new phone" instructions (section 10.9).
    var hostUi = false
    var onSecondary: (() -> Void)?

    let titleLabel = Theme.label(font: Theme.title)
    private let bodyLabel = Theme.label(font: Theme.body, color: Theme.text2)
    private let statusLabel = Theme.label(font: Theme.body, color: Theme.text3)
    private let spinner = makeSpinner(color: Theme.text3)
    private let scroll = UIScrollView()
    private let columns = UIStackView()
    private let left = UIStackView()
    private let right = UIStackView()
    private var leftWidth: NSLayoutConstraint?
    private var minHeight: NSLayoutConstraint?
    private(set) var primaryButton: ThemedButton?
    private(set) var secondaryButton: ThemedButton?
    private var dimmer: IdleDimmer?
    private var stillLookingTimer: Timer?
    private let checksStack = UIStackView()
    private var buttonRow: UIStackView?

    var initialFocus: UIView? { titleLabel }

    init(problem: Problem) {
        self.problem = problem
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "problem"
        titleLabel.accessibilityTraits = .header
        scroll.alwaysBounceVertical = false
        scroll.showsVerticalScrollIndicator = false
        view.addSubview(scroll)
        scroll.pinEdges(to: view.safeAreaLayoutGuide)
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
            columns.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            columns.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -14),
            columns.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor)
        ])
        let height = columns.heightAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.heightAnchor, constant: -38)
        height.isActive = true
        minHeight = height
        build()
        updateLayout()
        // Title → body → right column → primary → secondary (section 9.2).
        var order: [Any] = [titleLabel, bodyLabel]
        if statusLabel.superview != nil { order.append(statusLabel) }
        order.append(right)
        if let primaryButton, primaryButton.isDescendant(of: left) { order.append(primaryButton) }
        if let secondaryButton, secondaryButton.isDescendant(of: left) { order.append(secondaryButton) }
        view.accessibilityElements = order
        if isWaitingScreen {
            dimmer = IdleDimmer(content: columns, host: view)
        }
        if case .securityChanged = problem {
            accessibilityViewIsModal = true
        }
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: { _ in self.updateLayout() })
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { updateLayout() }
    }

    private var isWaitingScreen: Bool {
        switch problem {
        case .cantReach, .noWifi, .localNetworkOff: return true
        default: return false
        }
    }

    private func updateLayout() {
        let single = traitCollection.prefersSingleColumn
        let wide = view.bounds.width >= 900
        columns.axis = single ? .vertical : .horizontal
        columns.alignment = single ? .fill : .center
        leftWidth?.isActive = false
        if !single {
            let width: CGFloat
            switch problem {
            case .securityChanged: width = 330
            case .localNetworkOff: width = wide ? 360 : 330
            default: width = wide ? 330 : 300
            }
            leftWidth = left.widthAnchor.constraint(equalToConstant: width)
            leftWidth?.priority = UILayoutPriority(999)
            leftWidth?.isActive = true
        }
        buttonRow?.axis = single ? .vertical : .horizontal
        buttonRow?.alignment = single ? .leading : .center
        if case .noWifi = problem, !single {
            right.alignment = .leading
        }
    }

    // MARK: Content

    private func addGlyph(_ symbol: String, tone: GlyphTile.Tone) {
        let glyph = GlyphTile(symbol: symbol, tone: tone, size: 56)
        left.addArrangedSubview(glyph)
        left.setCustomSpacing(18, after: glyph)
    }

    private func addTitle(_ title: String, body: String, bodySize: CGFloat = 15) {
        titleLabel.text = title
        bodyLabel.attributedText = Theme.paragraph(body, font: Theme.font(bodySize))
        left.addArrangedSubview(titleLabel)
        left.setCustomSpacing(8, after: titleLabel)
        left.addArrangedSubview(bodyLabel)
    }

    private func addLeftButtons(_ buttons: [ThemedButton]) {
        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow, for: .vertical)
        spacer.heightAnchor.constraint(greaterThanOrEqualToConstant: 24).isActive = true
        left.addArrangedSubview(spacer)
        let row = UIStackView(arrangedSubviews: buttons)
        row.spacing = 12
        row.alignment = .center
        // Button titles stay on one line; the column gives way a little if it must.
        buttons.forEach { $0.setContentCompressionResistancePriority(.required, for: .horizontal) }
        buttonRow = row
        left.addArrangedSubview(row)
        left.alignment = .leading
        left.distribution = .fill
    }

    private func button(_ title: String, _ kind: ThemedButton.Kind, primary: Bool) -> ThemedButton {
        let button = ThemedButton(title, kind: kind)
        button.addTarget(self, action: primary ? #selector(primaryTapped) : #selector(secondaryTapped), for: .touchUpInside)
        button.accessibilityIdentifier = primary ? "problem-primary" : "problem-secondary"
        if primary { primaryButton = button } else { secondaryButton = button }
        return button
    }

    private func build() {
        switch problem {
        case let .cantReach(name, platform, checks):
            buildCantReach(name: name, platform: platform, checks: checks)
        case let .noWifi(name):
            addGlyph(Theme.Icon.wifiOff, tone: .neutral)
            addTitle("This phone isn't on Wi-Fi",
                     body: "WinDock reaches \(name) over your local network. Join the same Wi-Fi and it will connect by itself. Turn on Wi-Fi in Control Center.")
            let stack = UIStackView(arrangedSubviews: [button("Try again", .primary, primary: true),
                                                       button("Other computers", .secondary, primary: false)])
            stack.axis = .vertical
            stack.spacing = 12
            stack.alignment = .fill
            stack.widthAnchor.constraint(equalToConstant: 300).isActive = true
            right.addArrangedSubview(stack)
            left.alignment = .leading
        case let .securityChanged(_, name, then, now):
            buildSecurityChanged(name: name, then: then, now: now)
        case .localNetworkOff:
            addGlyph(Theme.Icon.network, tone: .neutral)
            addTitle("Turn on Local Network for WinDock",
                     body: "WinDock needs it to find your computers and talk to them on your Wi-Fi. Nothing leaves your network.")
            let card = InstructionCard(symbol: Theme.Icon.settings, tone: .accent,
                                       text: Theme.rich("In Settings, WinDock's page opens. Turn on **Local Network**, then come back here.",
                                                        font: Theme.font(14)))
            let open = button("Open Settings", .primary, primary: true)
            let caption = Theme.label("WinDock checks again when you return.", font: Theme.font(13), color: Theme.text3, alignment: .center)
            right.addArrangedSubview(card)
            right.setCustomSpacing(16, after: card)
            right.addArrangedSubview(open)
            right.setCustomSpacing(16, after: open)
            right.addArrangedSubview(caption)
            right.widthAnchor.constraint(lessThanOrEqualToConstant: 320).isActive = true
        case let .dockFailed(name), let .dockTimeout(name):
            addGlyph(Theme.Icon.monitor, tone: .neutral)
            titleLabel.text = name
            bodyLabel.attributedText = Theme.paragraph({
                if case .dockTimeout = problem {
                    return "The dock took too long to load. Check that WinDock is still running on \(name), then try again."
                }
                return "Couldn't open the dock. Try again, or choose another computer."
            }())
            left.addArrangedSubview(titleLabel)
            left.setCustomSpacing(8, after: titleLabel)
            left.addArrangedSubview(bodyLabel)
            addLeftButtons([button("Try again", .primary, primary: true), button("Other computers", .secondary, primary: false)])
        }
    }

    private func buildCantReach(name: String, platform: String, checks: ConnectionRules.CheckList) {
        addGlyph(Theme.Icon.monitor, tone: .neutral)
        addTitle("Can't reach \(name)", body: "WinDock keeps trying while this screen is open and opens the dock as soon as \(name) answers.")
        left.setCustomSpacing(16, after: bodyLabel)
        statusLabel.text = "Looking on this network"
        statusLabel.accessibilityIdentifier = "reach-status"
        spinner.startAnimating()
        let statusRow = UIStackView(arrangedSubviews: [spinner, statusLabel])
        statusRow.spacing = 8
        statusRow.alignment = .center
        left.addArrangedSubview(statusRow)
        addLeftButtons([button("Try again", .primary, primary: true), button("Other computers", .secondary, primary: false)])
        checksStack.axis = .vertical
        checksStack.spacing = 8
        right.addArrangedSubview(checksStack)
        fillChecks(name: name, platform: platform, checks: checks)
        // After 60 s the spinner stops and the line reads "Still looking".
        stillLookingTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.spinner.stopAnimating()
            self.statusLabel.text = "Still looking"
        }
    }

    private func fillChecks(name: String, platform: String, checks: ConnectionRules.CheckList) {
        checksStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (index, check) in checks.checks.enumerated() {
            let title: String
            let body: NSAttributedString
            switch check {
            case let .differentNetwork(phoneIp, hostIp):
                title = "This phone is on a different network"
                body = Theme.rich("This phone is at `\(phoneIp)`, but \(name) was at `\(hostIp)`. Join the same Wi-Fi as the computer.", font: Theme.font(13), lineHeight: 1.4)
            case .notRunning:
                title = "WinDock is running on \(name)"
                let mac = hostUi ? "Its icon should be in the Mac's menu bar." : "On the Mac, run `npm run mac:status` to check."
                body = Theme.rich(platform == "macos" ? mac
                                    : "Look for the WinDock icon in the taskbar tray, by the clock.", font: Theme.font(13), lineHeight: 1.4)
            case .isolation:
                title = "The network lets devices see each other"
                body = Theme.rich("Guest, hotel and office Wi-Fi often keep devices apart.", font: Theme.font(13), lineHeight: 1.4)
            case .macFirewall:
                title = "macOS allows incoming connections"
                body = Theme.rich("If macOS asked about node, choose Allow. You can change it in System Settings → Network → Firewall.", font: Theme.font(13), lineHeight: 1.4)
            }
            checksStack.addArrangedSubview(CheckCard(number: index + 1, title: title, body: body, likely: checks.likely == index))
        }
    }

    func update(_ problem: Problem) {
        guard case let .cantReach(name, platform, checks) = problem, case .cantReach = self.problem else { return }
        self.problem = problem
        if isViewLoaded { fillChecks(name: name, platform: platform, checks: checks) }
    }

    private func buildSecurityChanged(name: String, then: String, now: String) {
        addGlyph(Theme.Icon.shield, tone: .danger)
        addTitle("\(name) has a new security code",
                 body: "That's expected if WinDock was reinstalled or reset on \(name). If it wasn't, another device may be pretending to be it. Don't continue until you've checked.",
                 bodySize: 14)
        let forget = button("Forget and pair again", .danger, primary: true)
        let notNow = button("Not now", .secondary, primary: false)
        addLeftButtons([forget, notNow])
        let thenCard = CodeCard(key: "When you paired", code: then, current: false)
        let nowCard = CodeCard(key: "Now", code: now, current: true)
        let caption = Theme.label(font: Theme.caption, color: Theme.text3)
        let howTo = hostUi ? "To check, open WinDock on \(name) and choose Pair a new phone. If it shows the new code, pair again."
                           : "To check, open Show connection info on \(name). If it shows the new code, pair again."
        caption.attributedText = Theme.paragraph(howTo,
                                                 font: Theme.font(12), color: Theme.text3, lineHeight: 1.4)
        right.addArrangedSubview(thenCard)
        right.setCustomSpacing(8, after: thenCard)
        right.addArrangedSubview(nowCard)
        right.setCustomSpacing(16, after: nowCard)
        right.addArrangedSubview(caption)
    }

    override var preferredFocusEnvironments: [UIFocusEnvironment] {
        if case .securityChanged = problem, let secondaryButton { return [secondaryButton] }
        return super.preferredFocusEnvironments
    }

    /// Escape / two-finger scrub is "Not now" on S10, "Other computers" elsewhere.
    override func accessibilityPerformEscape() -> Bool {
        guard secondaryButton != nil else { return false }
        onSecondary?()
        return true
    }

    @objc private func primaryTapped() { onPrimary?() }
    @objc private func secondaryTapped() { onSecondary?() }

    deinit { stillLookingTimer?.invalidate() }
}

/// Numbered check card on S8; the likely one has an accent outline and a "Likely" tag.
final class CheckCard: UIView {
    init(number: Int, title: String, body: NSAttributedString, likely: Bool) {
        super.init(frame: .zero)
        backgroundColor = Theme.row
        layer.cornerRadius = 16
        layer.cornerCurve = .continuous
        if likely {
            layer.borderWidth = 1
            layer.borderColor = Theme.accentLine.cgColor
        }
        let badge = Theme.label("\(number)", font: Theme.font(13, .semibold), color: likely ? Theme.accent : Theme.text2, alignment: .center)
        badge.backgroundColor = likely ? Theme.accentTint : Theme.glyphFill
        badge.layer.cornerRadius = 12
        badge.layer.masksToBounds = true
        badge.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([badge.widthAnchor.constraint(equalToConstant: 24), badge.heightAnchor.constraint(equalToConstant: 24)])
        let titleLabel = Theme.label(font: Theme.font(15, .semibold))
        let titleText = NSMutableAttributedString(string: title, attributes: [.font: Theme.font(15, .semibold), .foregroundColor: Theme.text])
        titleLabel.attributedText = titleText
        var titleViews: [UIView] = [titleLabel]
        if likely {
            let tag = PaddedLabel(text: "Likely")
            titleViews.append(tag)
        }
        let titleRow = UIStackView(arrangedSubviews: titleViews)
        titleRow.spacing = 8
        titleRow.alignment = .center
        let bodyLabel = Theme.label(font: Theme.subhead, color: Theme.text2)
        bodyLabel.attributedText = body
        let text = UIStackView(arrangedSubviews: [titleRow, bodyLabel])
        text.axis = .vertical
        text.spacing = 2
        text.alignment = .leading
        let row = UIStackView(arrangedSubviews: [badge, text])
        row.spacing = 14
        row.alignment = .top
        addSubview(row)
        row.pinEdges(to: self, insets: UIEdgeInsets(top: 14, left: 16, bottom: 14, right: 16))
        isAccessibilityElement = true
        accessibilityLabel = "\(number). \(title)\(likely ? ", likely" : ""). \(body.string)"
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// The small accent "Likely" tag.
final class PaddedLabel: UILabel {
    init(text: String) {
        super.init(frame: .zero)
        self.text = text
        font = Theme.font(11, .semibold)
        adjustsFontForContentSizeCategory = true
        textColor = Theme.accent
        backgroundColor = Theme.accentTint
        layer.cornerRadius = 10
        layer.masksToBounds = true
        textAlignment = .center
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 16, height: max(20, size.height + 4))
    }
}

/// A security code drawn in mono with the hyphens in text-3, spelled out for VoiceOver.
func securityCodeText(_ code: String, size: CGFloat, color: UIColor) -> NSAttributedString {
    let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: size, weight: .medium))
    let result = NSMutableAttributedString()
    for character in code {
        let isDash = character == "-"
        result.append(NSAttributedString(string: isDash ? "–" : String(character), attributes: [
            .font: font, .foregroundColor: isDash ? Theme.text3 : color, .kern: size * 0.04
        ]))
    }
    return result
}

func spokenCode(_ code: String) -> NSAttributedString {
    let spoken = code.split(separator: "-").map { $0.map(String.init).joined(separator: " ") }.joined(separator: ", ")
    return NSAttributedString(string: spoken, attributes: [.accessibilitySpeechSpellOut: true])
}

/// "When you paired" / "Now" code cards on S10.
final class CodeCard: UIView {
    init(key: String, code: String, current: Bool) {
        super.init(frame: .zero)
        backgroundColor = Theme.row
        layer.cornerRadius = 16
        layer.cornerCurve = .continuous
        if current {
            layer.borderWidth = 1
            layer.borderColor = Theme.dangerLine.cgColor
        }
        let keyLabel = Theme.label(key, font: Theme.caption, color: Theme.text3)
        let codeLabel = UILabel()
        codeLabel.adjustsFontForContentSizeCategory = true
        codeLabel.attributedText = securityCodeText(code, size: 19, color: current ? Theme.text : Theme.text2)
        codeLabel.adjustsFontSizeToFitWidth = true
        codeLabel.minimumScaleFactor = 0.6
        let stack = UIStackView(arrangedSubviews: [keyLabel, codeLabel])
        stack.axis = .vertical
        stack.spacing = 4
        addSubview(stack)
        stack.pinEdges(to: self, insets: UIEdgeInsets(top: 16, left: 18, bottom: 16, right: 18))
        isAccessibilityElement = true
        accessibilityLabel = key
        accessibilityAttributedValue = spokenCode(code)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
