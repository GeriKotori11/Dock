import UIKit

/// S1 Connecting (mockups 01, 02): BrandMark, "Opening {name}", one status line.
final class ConnectingViewController: ScreenViewController, FocusProviding {
    enum Status: Equatable {
        case connecting
        case looking(String)
        case moved(String)
    }

    var onChooseAnother: (() -> Void)?
    private var name: String
    private(set) var status: Status = .connecting
    let titleLabel = Theme.label(font: Theme.title, alignment: .center)
    let statusLabel = Theme.label(font: Theme.body, color: Theme.text2, alignment: .center)
    private let spinner = makeSpinner()
    private let check = UIImageView(image: Theme.symbol(Theme.Icon.check, size: 14, weight: .semibold))
    private let chooseButton = ThemedButton("Choose another computer", kind: .ghost)

    var initialFocus: UIView? { titleLabel }

    init(name: String) {
        self.name = name
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        titleLabel.accessibilityTraits = .header
        titleLabel.text = "Opening \(name)"
        check.tintColor = Theme.accent
        check.isHidden = true
        check.isAccessibilityElement = false
        spinner.startAnimating()
        let statusRow = UIStackView(arrangedSubviews: [spinner, check, statusLabel])
        statusRow.spacing = 8
        statusRow.alignment = .center
        let stack = UIStackView(arrangedSubviews: [BrandMark(size: 44), titleLabel, statusRow])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 8
        stack.setCustomSpacing(24, after: stack.arrangedSubviews[0])
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        chooseButton.translatesAutoresizingMaskIntoConstraints = false
        chooseButton.accessibilityIdentifier = "choose-another"
        chooseButton.addTarget(self, action: #selector(chooseAnother), for: .touchUpInside)
        view.addSubview(chooseButton)
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: safe.centerYAnchor, constant: -10),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: safe.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: chooseButton.topAnchor, constant: -8),
            chooseButton.centerXAnchor.constraint(equalTo: safe.centerXAnchor),
            chooseButton.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -14)
        ])
        apply(status, animated: false)
    }

    func setName(_ name: String) {
        guard name != self.name else { return }
        self.name = name
        if isViewLoaded { titleLabel.text = "Opening \(name)" }
    }

    func setStatus(_ status: Status) {
        guard status != self.status else { return }
        self.status = status
        if isViewLoaded { apply(status, animated: true) }
    }

    private func apply(_ status: Status, animated: Bool) {
        let text: String
        switch status {
        case .connecting: text = "Connecting…"
        case .looking(let name): text = "Looking for \(name) on this network…"
        case .moved(let ip): text = "Found it at a new address, \(ip)"
        }
        let moved: Bool
        if case .moved = status { moved = true } else { moved = false }
        let change = {
            self.statusLabel.text = text
            self.check.isHidden = !moved
            if moved { self.spinner.stopAnimating() } else { self.spinner.startAnimating() }
        }
        if animated { Motion.crossfade(statusLabel, change) } else { change() }
        statusLabel.accessibilityIdentifier = "connecting-status"
        if animated { UIAccessibility.post(notification: .announcement, argument: text) }
    }

    @objc private func chooseAnother() { onChooseAnother?() }
}
