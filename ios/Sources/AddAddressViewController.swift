import UIKit

/// S7 Add by address (mockup 15): one field and Connect on the same line, above the keyboard.
final class AddAddressViewController: ScreenViewController, UITextFieldDelegate, FocusProviding {
    private unowned let coordinator: ConnectionCoordinator
    let field = UITextField()
    let connectButton = ThemedButton("Connect", kind: .primary)
    let captionLabel = Theme.label(font: Theme.font(13), color: Theme.text3)
    private let captionIcon = UIImageView()
    private let ghostPort = Theme.label(":8620", font: Theme.font(18, mono: true), color: Theme.text3)
    private let titleLabel = Theme.label("Add by address", font: Theme.headline, alignment: .center)
    private var checking = false
    private var ghostLeading: NSLayoutConstraint?
    private(set) var isShowingError = false

    var initialFocus: UIView? { field }

    init(coordinator: ConnectionCoordinator) {
        self.coordinator = coordinator
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "add-address"
        let safe = view.safeAreaLayoutGuide
        let close = IconButton(symbol: Theme.Icon.close, label: "Close")
        close.accessibilityIdentifier = "address-close"
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        titleLabel.accessibilityTraits = .header
        field.accessibilityIdentifier = "pc-address"
        field.accessibilityLabel = "Computer address"
        field.attributedPlaceholder = NSAttributedString(string: "192.168.1.20:8620", attributes: [.foregroundColor: Theme.text3])
        field.keyboardType = .numbersAndPunctuation
        field.keyboardAppearance = .dark
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.returnKeyType = .go
        field.font = Theme.font(18, mono: true)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = Theme.text
        field.tintColor = Theme.accent
        field.backgroundColor = Theme.field
        field.layer.cornerRadius = 12
        field.layer.cornerCurve = .continuous
        field.layer.borderColor = Theme.accent.cgColor
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        field.leftViewMode = .always
        field.delegate = self
        field.addTarget(self, action: #selector(edited), for: .editingChanged)
        ghostPort.isAccessibilityElement = false
        ghostPort.translatesAutoresizingMaskIntoConstraints = false
        field.addSubview(ghostPort)
        ghostLeading = ghostPort.leadingAnchor.constraint(equalTo: field.leadingAnchor, constant: 14)
        NSLayoutConstraint.activate([ghostLeading!, ghostPort.centerYAnchor.constraint(equalTo: field.centerYAnchor)])
        connectButton.busyTitle = "Checking…"
        connectButton.accessibilityIdentifier = "connect"
        connectButton.addTarget(self, action: #selector(connect), for: .touchUpInside)
        captionIcon.isHidden = true
        captionIcon.tintColor = Theme.dangerText
        captionIcon.image = Theme.symbol(Theme.Icon.warning, size: 13)
        captionIcon.setContentHuggingPriority(.required, for: .horizontal)
        captionLabel.accessibilityIdentifier = "address-caption"
        showHint()
        let fieldRow = UIStackView(arrangedSubviews: [field, connectButton])
        fieldRow.spacing = 20
        fieldRow.alignment = .fill
        let captionRow = UIStackView(arrangedSubviews: [captionIcon, captionLabel])
        captionRow.spacing = 8
        captionRow.alignment = .firstBaseline
        for subview in [close, titleLabel, fieldRow, captionRow] as [UIView] {
            subview.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(subview)
        }
        NSLayoutConstraint.activate([
            close.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            close.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8),
            titleLabel.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: close.centerYAnchor),
            fieldRow.topAnchor.constraint(equalTo: close.bottomAnchor, constant: 8),
            fieldRow.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 80),
            fieldRow.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -80),
            field.heightAnchor.constraint(greaterThanOrEqualToConstant: 52),
            connectButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 52),
            captionRow.topAnchor.constraint(equalTo: fieldRow.bottomAnchor, constant: 12),
            captionRow.leadingAnchor.constraint(equalTo: fieldRow.leadingAnchor),
            captionRow.trailingAnchor.constraint(lessThanOrEqualTo: fieldRow.trailingAnchor),
            captionRow.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor, constant: -8)
        ])
        connectButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        connectButton.setContentHuggingPriority(.required, for: .horizontal)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        field.becomeFirstResponder()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        positionGhost()
    }

    override func accessibilityPerformEscape() -> Bool {
        closeTapped()
        return true
    }

    // MARK: Field

    func textFieldDidBeginEditing(_ textField: UITextField) { field.layer.borderWidth = 2 }
    func textFieldDidEndEditing(_ textField: UITextField) { field.layer.borderWidth = 0 }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        connect()
        return false
    }

    @objc private func edited() {
        if isShowingError { showHint() }
        positionGhost()
    }

    /// A bare address means port 8620, shown as ghost text after the caret.
    private func positionGhost() {
        let text = field.text ?? ""
        ghostPort.isHidden = text.isEmpty || text.contains(":") || text.contains("/")
        guard !ghostPort.isHidden, let font = field.font else { return }
        let width = (text as NSString).size(withAttributes: [.font: font]).width
        ghostLeading?.constant = 14 + ceil(width) + 6
    }

    private func showHint() {
        isShowingError = false
        captionIcon.isHidden = true
        captionLabel.attributedText = hintText()
    }

    private func hintText() -> NSAttributedString {
        let font = Theme.font(13)
        // Section 10.9: the new wording once a computer has reported its own UI (`/health.hostUi`);
        // nothing is known about the computer being added before it answers.
        if coordinator.store.computers.contains(where: { $0.hostUi == true }) {
            return NSAttributedString(string: "The address is under Pair a new phone in WinDock on the computer. The port is usually 8620.",
                                      attributes: [.font: font, .foregroundColor: Theme.text3])
        }
        let result = NSMutableAttributedString(string: "The address is in Show connection info (Windows tray) or ",
                                               attributes: [.font: font, .foregroundColor: Theme.text3])
        result.append(NSAttributedString(string: "\u{2009}npm run info\u{2009}", attributes: [
            .font: Theme.font(13, mono: true), .foregroundColor: Theme.text, .backgroundColor: Theme.secondaryFill
        ]))
        result.append(NSAttributedString(string: " (Mac). The port is usually 8620.", attributes: [.font: font, .foregroundColor: Theme.text3]))
        return result
    }

    private func showError(_ message: String) {
        isShowingError = true
        captionIcon.isHidden = false
        captionLabel.attributedText = NSAttributedString(string: message, attributes: [.font: Theme.font(13), .foregroundColor: Theme.dangerText])
        UIAccessibility.post(notification: .announcement, argument: message)
    }

    /// Distinguishes a literal public IPv4 address (its own message) from malformed input.
    static func isPublicIPv4(_ input: String) -> Bool {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed.contains("://") ? trimmed : "http://" + trimmed),
              let host = parts.host, NetworkStatus.ipv4(host) != nil else { return false }
        return !EndpointPolicy.isPrivateHost(host)
    }

    @objc func connect() {
        guard !checking else { return }
        let input = field.text ?? ""
        guard let endpoint = EndpointPolicy.normalize(input) else {
            showError(Self.isPublicIPv4(input)
                      ? "WinDock only connects to computers on your local network, like 192.168.x.x or 10.x.x.x."
                      : "Enter a local address like 192.168.1.20:8620.")
            return
        }
        checking = true
        connectButton.isBusy = true
        let shown = "\(endpoint.host ?? ""):\(EndpointPolicy.effectivePort(endpoint))"
        coordinator.checkAddress(endpoint) { [weak self] result in
            guard let self else { return }
            self.checking = false
            self.connectButton.isBusy = false
            guard result.info != nil else {
                self.showError("No WinDock answered at \(shown). Check the address and that WinDock is running.")
                self.field.becomeFirstResponder()
                return
            }
            self.view.endEditing(true)
            self.coordinator.arrived(result)
        }
    }

    @objc private func closeTapped() {
        view.endEditing(true)
        dismiss(animated: true)
    }
}
