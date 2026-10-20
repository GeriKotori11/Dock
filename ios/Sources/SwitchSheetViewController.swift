import UIKit

/// S12 Switch computer (mockup 21): a 500 pt bottom sheet over the dimmed, still-live dock.
final class SwitchSheetViewController: UIViewController, UIAdaptivePresentationControllerDelegate {
    let coordinator: ConnectionCoordinator
    var onWillDismiss: ((UIViewControllerTransitionCoordinator?) -> Void)?
    private let scroll = UIScrollView()
    private let group = UIStackView()
    private let stack = UIStackView()
    private var observer: NSObjectProtocol?
    private var rows: [String: SheetRow] = [:]
    private var order: [String] = []

    init(coordinator: ConnectionCoordinator) {
        self.coordinator = coordinator
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        presentationController?.delegate = self
        if let sheet = sheetPresentationController {
            sheet.prefersEdgeAttachedInCompactHeight = true
            sheet.widthFollowsPreferredContentSizeWhenEdgeAttached = true
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 24
            sheet.largestUndimmedDetentIdentifier = .init("content")
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.sheet
        view.tintColor = Theme.accent
        view.accessibilityIdentifier = "switch-sheet"
        view.maximumContentSizeCategory = .accessibilityLarge
        let title = Theme.label("Switch computer", font: Theme.headline)
        title.accessibilityTraits = .header
        let manage = ThemedButton("Manage", kind: .ghostSmall)
        manage.accessibilityIdentifier = "switch-manage"
        manage.addTarget(self, action: #selector(manageTapped), for: .touchUpInside)
        let header = UIStackView(arrangedSubviews: [title, manage])
        header.alignment = .center
        title.setContentHuggingPriority(.defaultLow, for: .horizontal)
        manage.setContentHuggingPriority(.required, for: .horizontal)
        header.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        group.axis = .vertical
        group.backgroundColor = Theme.sheetGroup
        group.layer.cornerRadius = 16
        group.layer.cornerCurve = .continuous
        group.clipsToBounds = true
        stack.axis = .vertical
        stack.spacing = 4
        stack.addArrangedSubview(header)
        stack.addArrangedSubview(group)
        scroll.addSubview(stack)
        scroll.alwaysBounceVertical = false
        view.addSubview(scroll)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor, constant: 20),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -8),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -16),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -32)
        ])
        header.isLayoutMarginsRelativeArrangement = true
        header.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 4, bottom: 4, trailing: 0)
        observer = NotificationCenter.default.addObserver(forName: ConnectionCoordinator.didChange, object: coordinator, queue: .main) { [weak self] _ in
            self?.reload()
        }
        order = coordinator.store.byLastConnected.map(\.hostId)
        reload()
    }

    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        updateDetent()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed { onWillDismiss?(transitionCoordinator) }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        onWillDismiss?(nil)
    }

    /// Height follows content, up to 85% of the screen, then scrolls.
    private func updateDetent() {
        stack.layoutIfNeeded()
        let height = stack.systemLayoutSizeFitting(CGSize(width: 500 - 32, height: UIView.layoutFittingCompressedSize.height),
                                                   withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel).height + 20 + 8
        preferredContentSize = CGSize(width: 500, height: height)
        guard let sheet = sheetPresentationController else { return }
        let detent = UISheetPresentationController.Detent.custom(identifier: .init("content")) { context in
            min(height, context.maximumDetentValue * 0.85)
        }
        if sheet.detents.count != 1 || sheet.detents.first?.identifier != detent.identifier || abs(lastHeight - height) > 0.5 {
            lastHeight = height
            sheet.animateChanges { sheet.detents = [detent] }
        }
    }
    private var lastHeight: CGFloat = 0

    private func reload() {
        let paired = coordinator.store.computers.map(\.hostId)
        order = order.filter { paired.contains($0) } + paired.filter { !order.contains($0) }
        group.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (index, hostId) in order.enumerated() {
            guard let computer = coordinator.store.computer(hostId) else { continue }
            let isCurrent = coordinator.current?.hostId == hostId && coordinator.dock?.isReady == true
            let row = SheetRow()
            row.configure(computer, status: isCurrent ? nil : coordinator.status(for: computer), current: isCurrent, separator: index > 0)
            row.addTarget(self, action: #selector(rowTapped(_:)), for: .touchUpInside)
            row.hostId = hostId
            group.addArrangedSubview(row)
        }
        let add = SheetRow()
        add.configureAdd(separator: !order.isEmpty)
        add.addTarget(self, action: #selector(addTapped), for: .touchUpInside)
        group.addArrangedSubview(add)
        view.setNeedsLayout()
    }

    @objc private func rowTapped(_ row: SheetRow) {
        guard let hostId = row.hostId, let computer = coordinator.store.computer(hostId) else { return }
        if coordinator.current?.hostId == hostId, coordinator.dock?.isReady == true {
            dismiss(animated: true); return
        }
        dismiss(animated: true) { [coordinator] in coordinator.select(computer) }
    }

    @objc private func manageTapped() {
        dismiss(animated: true) { [coordinator] in coordinator.showHub(overDock: true) }
    }

    @objc private func addTapped() {
        dismiss(animated: true) { [coordinator] in
            coordinator.startDiscovery()
            coordinator.showHub(overDock: true)
        }
    }
}

/// A compact (56) row in the switch sheet.
final class SheetRow: UIControl {
    var hostId: String?
    private let glyph = GlyphTile(symbol: Theme.Icon.monitor)
    private let title = Theme.label(font: Theme.headline, lines: 1)
    private let subtitle = Theme.label(font: Theme.subhead, color: Theme.text2, lines: 1)
    private let mark = StatusMark()
    private let check = UIImageView(image: Theme.symbol(Theme.Icon.check, size: 18, weight: .medium))
    private let separator = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        title.lineBreakMode = .byTruncatingTail
        let subRow = UIStackView(arrangedSubviews: [mark, subtitle])
        subRow.spacing = 6
        subRow.alignment = .center
        let text = UIStackView(arrangedSubviews: [title, subRow])
        text.axis = .vertical
        text.spacing = 2
        check.tintColor = Theme.accent
        check.setContentHuggingPriority(.required, for: .horizontal)
        let row = UIStackView(arrangedSubviews: [glyph, text, check])
        row.spacing = 14
        row.alignment = .center
        row.isUserInteractionEnabled = false
        addSubview(row)
        row.pinEdges(to: self, insets: UIEdgeInsets(top: 8, left: 14, bottom: 8, right: 18))
        separator.backgroundColor = Theme.line
        separator.translatesAutoresizingMaskIntoConstraints = false
        addSubview(separator)
        NSLayoutConstraint.activate([
            separator.topAnchor.constraint(equalTo: topAnchor), separator.trailingAnchor.constraint(equalTo: trailingAnchor),
            separator.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 68), separator.heightAnchor.constraint(equalToConstant: 1),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 56)
        ])
        isAccessibilityElement = true
        accessibilityTraits = .button
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? Theme.rowPressed : .clear }
    }

    func configure(_ computer: Computer, status: RowStatus?, current: Bool, separator: Bool) {
        self.separator.isHidden = !separator
        title.text = computer.displayName
        check.isHidden = !current
        var words: String
        switch status {
        case nil:
            glyph.set(symbol: Theme.Icon.monitor, tone: .accent)
            mark.show(.dot(.live))
            words = "Connected"
        case .online?:
            glyph.set(symbol: Theme.Icon.monitor, tone: .accent)
            mark.show(.dot(.live))
            words = "Online"
        case .checking?:
            glyph.set(symbol: Theme.Icon.monitor, tone: .neutral)
            mark.show(.spinner)
            words = "Checking…"
        case .notFound?:
            glyph.set(symbol: Theme.Icon.monitor, tone: .neutral)
            mark.show(.dot(.ring))
            words = "Not found on this network"
        case .securityChanged?:
            glyph.set(symbol: Theme.Icon.shield, tone: .danger)
            mark.show(.dot(.danger))
            words = "Security code changed. Tap to check."
        case .needsPin?:
            glyph.set(symbol: Theme.Icon.monitor, tone: .neutral)
            mark.show(.none)
            words = "Needs a new PIN"
        }
        subtitle.text = words
        subtitle.textColor = status == .securityChanged ? Theme.dangerText : Theme.text2
        accessibilityLabel = "\(computer.displayName). \(words)"
        accessibilityTraits = current ? [.button, .selected] : .button
        accessibilityIdentifier = "sheet-\(computer.hostId)"
    }

    func configureAdd(separator: Bool) {
        self.separator.isHidden = !separator
        glyph.set(symbol: Theme.Icon.plus, tone: .clear)
        title.text = "Add a computer"
        title.font = Theme.font(15, .medium)
        title.textColor = Theme.accent
        subtitle.isHidden = true
        mark.isHidden = true
        check.isHidden = true
        accessibilityLabel = "Add a computer"
        accessibilityIdentifier = "sheet-add"
    }
}
