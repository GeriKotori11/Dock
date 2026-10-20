import UIKit

/// S2 (first launch) and S3 (hub): a rail on the left and a list of paired and discovered
/// computers on the right (mockups 03, 04, 06).
final class ComputersViewController: ScreenViewController, UICollectionViewDelegate, FocusProviding {
    enum Section: Hashable { case paired, network }
    enum Item: Hashable { case paired(String), discovered(String) }
    enum Panel: Equatable { case none, priming, empty }

    let coordinator: ConnectionCoordinator
    let overDock: Bool
    private var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Section, Item>!
    private let rail = UIStackView()
    private let railHeading = Theme.label(font: Theme.display)
    private let railBody = Theme.label(font: Theme.body, color: Theme.text2)
    let addLink = RailLink("Add by address", symbol: Theme.Icon.plus)
    private let railContainer = UIView()
    private let content = UIView()
    private let panelScroll = UIScrollView()
    private let panelStack = UIStackView()
    private let fade = GradientFade()
    private var railWidth: NSLayoutConstraint?
    private var contentLeading: NSLayoutConstraint?
    private var railInHeader = false
    private var pairedOrder: [String] = []
    /// The snapshot being shown (set before it is applied, so cells see their final position).
    private var currentSnapshot = NSDiffableDataSourceSnapshot<Section, Item>()
    private var discoveredOrder: [String] = []
    private var appearing: Set<String> = []
    private var panel: Panel = .none
    private var timers: [Timer] = []
    private var observer: NSObjectProtocol?
    private(set) var firstLaunch = false

    var initialFocus: UIView? { railHeading }

    init(coordinator: ConnectionCoordinator, overDock: Bool) {
        self.coordinator = coordinator
        self.overDock = overDock
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "computers"
        pairedOrder = coordinator.store.byLastConnected.map(\.hostId)
        firstLaunch = pairedOrder.isEmpty
        buildRail()
        buildList()
        buildPanel()
        layoutColumns()
        observer = NotificationCenter.default.addObserver(forName: ConnectionCoordinator.didChange, object: coordinator, queue: .main) { [weak self] _ in
            self?.reload(animated: true)
        }
        scheduleSearchTimers()
        reload(animated: false)
        view.accessibilityElements = nil
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: { _ in self.layoutColumns() })
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { layoutColumns() }
    }

    deinit {
        timers.forEach { $0.invalidate() }
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    // MARK: Rail

    private func buildRail() {
        rail.axis = .vertical
        rail.alignment = .leading
        rail.spacing = 0
        if overDock {
            let close = IconButton(symbol: Theme.Icon.close, label: "Close")
            close.accessibilityIdentifier = "hub-close"
            close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
            let top = UIStackView(arrangedSubviews: [close, makeBrandRow()])
            top.spacing = 12
            top.alignment = .center
            rail.addArrangedSubview(top)
        } else {
            rail.addArrangedSubview(makeBrandRow())
        }
        rail.setCustomSpacing(28, after: rail.arrangedSubviews[0])
        railHeading.accessibilityTraits = .header
        rail.addArrangedSubview(railHeading)
        rail.setCustomSpacing(10, after: railHeading)
        rail.addArrangedSubview(railBody)
        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow, for: .vertical)
        spacer.heightAnchor.constraint(greaterThanOrEqualToConstant: 16).isActive = true
        rail.addArrangedSubview(spacer)
        addLink.accessibilityIdentifier = "add-by-address"
        addLink.addTarget(self, action: #selector(addTapped), for: .touchUpInside)
        rail.addArrangedSubview(addLink)
        addLink.transform = .identity
        rail.setCustomSpacing(0, after: spacer)
        rail.translatesAutoresizingMaskIntoConstraints = false
        railContainer.addSubview(rail)
        NSLayoutConstraint.activate([
            rail.leadingAnchor.constraint(equalTo: railContainer.leadingAnchor),
            rail.trailingAnchor.constraint(equalTo: railContainer.trailingAnchor),
            rail.topAnchor.constraint(equalTo: railContainer.topAnchor, constant: 24),
            rail.bottomAnchor.constraint(equalTo: railContainer.bottomAnchor, constant: -16)
        ])
        // The rail link sits 12 pt into the gutter so its icon lines up with the text above.
        addLink.contentHorizontalAlignment = .leading
        updateRailText()
    }

    private func updateRailText() {
        if firstLaunch {
            let text = NSMutableAttributedString(string: "Your computer.\n", attributes: displayAttributes(Theme.text))
            text.append(NSAttributedString(string: "Within reach.", attributes: displayAttributes(Theme.accent)))
            railHeading.attributedText = text
            railHeading.accessibilityLabel = "Your computer. Within reach."
            railBody.attributedText = Theme.paragraph("Open WinDock on your computer, then pick it here.")
        } else {
            railHeading.attributedText = NSAttributedString(string: "Computers", attributes: displayAttributes(Theme.text))
            railHeading.accessibilityLabel = "Computers"
            railBody.attributedText = Theme.paragraph("Tap one to open its dock. Each computer keeps its own apps.")
        }
    }

    private func displayAttributes(_ color: UIColor) -> [NSAttributedString.Key: Any] {
        let style = NSMutableParagraphStyle()
        style.lineHeightMultiple = 0.98
        return [.font: Theme.display, .foregroundColor: color, .kern: -0.4, .paragraphStyle: style]
    }

    // MARK: List

    private func buildList() {
        let layout = UICollectionViewCompositionalLayout { [weak self] index, environment in
            var config = UICollectionLayoutListConfiguration(appearance: .plain)
            config.backgroundColor = .clear
            config.showsSeparators = true
            config.separatorConfiguration.color = Theme.line
            config.headerMode = .supplementary
            let isNetwork = self?.currentSnapshot.sectionIdentifiers[safe: index] == .network
            config.footerMode = isNetwork ? .supplementary : .none
            config.headerTopPadding = 0
            config.itemSeparatorHandler = { indexPath, separator in
                var separator = separator
                separator.topSeparatorVisibility = .hidden
                separator.bottomSeparatorInsets = NSDirectionalEdgeInsets(top: 0, leading: 68, bottom: 0, trailing: 0)
                let count = self?.itemCount(inSection: indexPath.section) ?? 0
                if indexPath.item == count - 1 { separator.bottomSeparatorVisibility = .hidden }
                return separator
            }
            config.trailingSwipeActionsConfigurationProvider = { [weak self] indexPath in
                guard let self, case .paired(let hostId) = self.dataSource.itemIdentifier(for: indexPath),
                      let computer = self.coordinator.store.computer(hostId) else { return nil }
                let forget = UIContextualAction(style: .destructive, title: "Forget") { [weak self] _, _, done in
                    self?.confirmForget(computer)
                    done(false)
                }
                return UISwipeActionsConfiguration(actions: [forget])
            }
            let section = NSCollectionLayoutSection.list(using: config, layoutEnvironment: environment)
            // Plain lists pin headers and footers (with a material behind them); these scroll with the rows.
            section.boundarySupplementaryItems.forEach { $0.pinToVisibleBounds = false }
            section.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 0, bottom: isNetwork ? 0 : 16, trailing: 0)
            return section
        }
        collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        collectionView.backgroundColor = .clear
        collectionView.delegate = self
        collectionView.showsVerticalScrollIndicator = false
        collectionView.contentInset = UIEdgeInsets(top: 20, left: 0, bottom: 28, right: 0)
        collectionView.accessibilityIdentifier = "computer-list"
        let cell = UICollectionView.CellRegistration<ComputerCell, Item> { [weak self] cell, indexPath, item in
            guard let self else { return }
            self.configure(cell, item: item, animated: false)
            let count = self.itemCount(inSection: indexPath.section)
            cell.setGroupCorners(first: indexPath.item == 0, last: indexPath.item == count - 1)
        }
        let header = UICollectionView.SupplementaryRegistration<SectionHeader>(elementKind: UICollectionView.elementKindSectionHeader) { [weak self] header, _, indexPath in
            guard let self, let section = self.currentSnapshot.sectionIdentifiers[safe: indexPath.section] else { return }
            self.configure(header, section: section)
        }
        let footer = UICollectionView.SupplementaryRegistration<FooterCaption>(elementKind: UICollectionView.elementKindSectionFooter) { [weak self] footer, _, _ in
            footer.label.text = "Don't see your computer? Check that WinDock is running on it and that both are on the same Wi-Fi."
            footer.label.isHidden = !(self?.showsFooter ?? false)
        }
        dataSource = UICollectionViewDiffableDataSource<Section, Item>(collectionView: collectionView) { collectionView, indexPath, item in
            collectionView.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: item)
        }
        dataSource.supplementaryViewProvider = { collectionView, kind, indexPath in
            if kind == UICollectionView.elementKindSectionFooter {
                return collectionView.dequeueConfiguredReusableSupplementary(using: footer, for: indexPath)
            }
            return collectionView.dequeueConfiguredReusableSupplementary(using: header, for: indexPath)
        }
        content.addSubview(collectionView)
        collectionView.pinEdges(to: content)
        fade.isUserInteractionEnabled = false
        content.addSubview(fade)
        fade.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            fade.leadingAnchor.constraint(equalTo: content.leadingAnchor), fade.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            fade.bottomAnchor.constraint(equalTo: content.bottomAnchor), fade.heightAnchor.constraint(equalToConstant: 28)
        ])
    }

    private func buildPanel() {
        panelStack.axis = .vertical
        panelStack.alignment = .leading
        panelScroll.addSubview(panelStack)
        panelScroll.showsVerticalScrollIndicator = false
        panelStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            panelStack.leadingAnchor.constraint(equalTo: panelScroll.contentLayoutGuide.leadingAnchor),
            panelStack.trailingAnchor.constraint(equalTo: panelScroll.contentLayoutGuide.trailingAnchor),
            panelStack.topAnchor.constraint(equalTo: panelScroll.contentLayoutGuide.topAnchor, constant: 20),
            panelStack.bottomAnchor.constraint(equalTo: panelScroll.contentLayoutGuide.bottomAnchor, constant: -24),
            panelStack.widthAnchor.constraint(equalTo: panelScroll.frameLayoutGuide.widthAnchor),
            panelStack.heightAnchor.constraint(greaterThanOrEqualTo: panelScroll.frameLayoutGuide.heightAnchor, constant: -44)
        ])
        content.addSubview(panelScroll)
        panelScroll.pinEdges(to: content)
        panelScroll.isHidden = true
    }

    private func layoutColumns() {
        if railContainer.superview == nil {
            view.addSubview(railContainer)
            view.addSubview(content)
            railContainer.translatesAutoresizingMaskIntoConstraints = false
            content.translatesAutoresizingMaskIntoConstraints = false
            let safe = view.safeAreaLayoutGuide
            railWidth = railContainer.widthAnchor.constraint(equalToConstant: 248)
            contentLeading = content.leadingAnchor.constraint(equalTo: railContainer.trailingAnchor, constant: 32)
            NSLayoutConstraint.activate([
                railContainer.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
                railContainer.topAnchor.constraint(equalTo: safe.topAnchor),
                railContainer.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
                railWidth!, contentLeading!,
                content.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
                content.topAnchor.constraint(equalTo: safe.topAnchor),
                content.bottomAnchor.constraint(equalTo: view.bottomAnchor)
            ])
        }
        let wide = view.bounds.width >= 900
        let single = traitCollection.prefersSingleColumn
        railWidth?.constant = single ? 0 : (wide ? 268 : 248)
        contentLeading?.constant = single ? 0 : (wide ? 40 : 32)
        railContainer.isHidden = single
        if single != railInHeader {
            railInHeader = single
            reload(animated: false)
        }
    }

    // MARK: State

    private var searchElapsed: TimeInterval {
        guard let started = coordinator.discoveryStartedAt else { return 0 }
        return Date().timeIntervalSince(started)
    }

    private var showsFooter: Bool { coordinator.isSearching && searchElapsed >= 3 }
    private var stillLooking: Bool { searchElapsed >= 8 }

    private func scheduleSearchTimers() {
        timers.forEach { $0.invalidate() }
        timers = [3.05, 8.05, 60.05].compactMap { mark in
            let remaining = mark - searchElapsed
            guard remaining > 0 else { return nil }
            return Timer.scheduledTimer(withTimeInterval: remaining, repeats: false) { [weak self] _ in self?.reload(animated: true) }
        }
    }

    private var lastDiscoveryStart: Date?

    func reload(animated: Bool) {
        guard isViewLoaded else { return }
        if coordinator.discoveryStartedAt != lastDiscoveryStart {
            lastDiscoveryStart = coordinator.discoveryStartedAt
            scheduleSearchTimers()
        }
        let paired = coordinator.store.computers.map(\.hostId)
        pairedOrder = pairedOrder.filter { paired.contains($0) } + paired.filter { !pairedOrder.contains($0) }
        let wasFirstLaunch = firstLaunch
        firstLaunch = pairedOrder.isEmpty
        if wasFirstLaunch != firstLaunch { updateRailText() }
        let found = coordinator.discovered.map(\.hostId)
        let added = found.filter { !discoveredOrder.contains($0) }
        discoveredOrder = discoveredOrder.filter { found.contains($0) } + added
        appearing.formUnion(added)

        let needsPriming = firstLaunch && !coordinator.store.localNetworkPrimed && coordinator.discoveryEnabled
        let nextPanel: Panel = needsPriming ? .priming : (firstLaunch && discoveredOrder.isEmpty && stillLooking ? .empty : .none)
        if nextPanel != panel || railInHeader != (panelStack.arrangedSubviews.first === rail) { showPanel(nextPanel) }
        addLink.isHidden = nextPanel != .none
        collectionView.isHidden = nextPanel != .none
        fade.isHidden = nextPanel != .none
        panelScroll.isHidden = nextPanel == .none

        var snapshot = NSDiffableDataSourceSnapshot<Section, Item>()
        if !pairedOrder.isEmpty {
            snapshot.appendSections([.paired])
            snapshot.appendItems(pairedOrder.map(Item.paired), toSection: .paired)
        }
        snapshot.appendSections([.network])
        snapshot.appendItems(discoveredOrder.map(Item.discovered), toSection: .network)
        let existing = Set(dataSource.snapshot().itemIdentifiers)
        snapshot.reconfigureItems(snapshot.itemIdentifiers.filter { existing.contains($0) })
        currentSnapshot = snapshot
        dataSource.apply(snapshot, animatingDifferences: animated && !Motion.reduced)
        for header in collectionView.visibleSupplementaryViews(ofKind: UICollectionView.elementKindSectionHeader) {
            guard let header = header as? SectionHeader, let indexPath = header.indexPath,
                  let section = snapshot.sectionIdentifiers[safe: indexPath.section] else { continue }
            configure(header, section: section)
        }
        for footer in collectionView.visibleSupplementaryViews(ofKind: UICollectionView.elementKindSectionFooter) {
            (footer as? FooterCaption)?.label.isHidden = !showsFooter
        }
        updateRailHeader()
        // Heading → list → rail links (section 9.2).
        var order: [Any] = []
        if let close = rail.arrangedSubviews.first?.subviews.first(where: { $0 is IconButton }) { order.append(close) }
        order += [railHeading, railBody, nextPanel == .none ? collectionView! : panelScroll]
        if !addLink.isHidden { order.append(addLink) }
        view.accessibilityElements = railInHeader ? nil : order
    }

    /// At accessibility text sizes the rail becomes a header above the list.
    private func updateRailHeader() {
        if railInHeader, panel == .none {
            if rail.superview !== collectionView {
                rail.removeFromSuperview()
                rail.translatesAutoresizingMaskIntoConstraints = true
                collectionView.addSubview(rail)
            }
            let width = collectionView.bounds.width
            let size = rail.systemLayoutSizeFitting(CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
                                                    withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
            rail.frame = CGRect(x: 0, y: -size.height - 4, width: width, height: size.height)
            collectionView.contentInset.top = size.height + 24
        } else if !railInHeader, rail.superview !== railContainer {
            rail.removeFromSuperview()
            rail.translatesAutoresizingMaskIntoConstraints = false
            railContainer.addSubview(rail)
            NSLayoutConstraint.activate([
                rail.leadingAnchor.constraint(equalTo: railContainer.leadingAnchor),
                rail.trailingAnchor.constraint(equalTo: railContainer.trailingAnchor),
                rail.topAnchor.constraint(equalTo: railContainer.topAnchor, constant: 24),
                rail.bottomAnchor.constraint(equalTo: railContainer.bottomAnchor, constant: -16)
            ])
            collectionView.contentInset.top = 20
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if railInHeader, panel == .none { updateRailHeader() }
    }

    private func showPanel(_ next: Panel) {
        panel = next
        panelStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if railInHeader, next != .none {
            rail.removeFromSuperview()
            rail.translatesAutoresizingMaskIntoConstraints = false
            panelStack.addArrangedSubview(rail)
            panelStack.setCustomSpacing(24, after: rail)
        }
        let top = UIView()
        top.setContentHuggingPriority(.defaultLow, for: .vertical)
        let bottom = UIView()
        bottom.setContentHuggingPriority(.defaultLow, for: .vertical)
        switch next {
        case .none:
            return
        case .priming:
            panelStack.addArrangedSubview(top)
            addPanelContent(symbol: Theme.Icon.network, tone: .accent, title: "Find computers on your Wi-Fi",
                            body: "WinDock looks for computers on your local network and only talks to them there. iOS will ask you to allow this next.",
                            buttons: [primaryButton("Continue", #selector(primeTapped), id: "priming-continue"),
                                      ghostButton("Enter an address", #selector(addTapped))])
            panelStack.addArrangedSubview(bottom)
        case .empty:
            let header = SectionHeader()
            header.configure(title: "On this network", status: "Still looking", spinning: false)
            panelStack.addArrangedSubview(header)
            header.widthAnchor.constraint(equalTo: panelStack.widthAnchor).isActive = true
            panelStack.addArrangedSubview(top)
            let enter = ThemedButton("Enter an address", kind: .secondary)
            enter.addTarget(self, action: #selector(addTapped), for: .touchUpInside)
            addPanelContent(symbol: Theme.Icon.search, tone: .neutral, title: "No computers found yet",
                            body: "Make sure WinDock is running on your computer and both devices are on the same Wi-Fi. Guest networks often keep devices from seeing each other.",
                            buttons: [enter])
            panelStack.addArrangedSubview(bottom)
        }
        top.heightAnchor.constraint(equalTo: bottom.heightAnchor).isActive = true
    }

    private func addPanelContent(symbol: String, tone: GlyphTile.Tone, title: String, body: String, buttons: [UIView]) {
        let glyph = GlyphTile(symbol: symbol, tone: tone, size: 56)
        let titleLabel = Theme.label(title, font: Theme.title)
        titleLabel.accessibilityTraits = .header
        let bodyLabel = Theme.label(font: Theme.body, color: Theme.text2)
        bodyLabel.attributedText = Theme.paragraph(body)
        let row = UIStackView(arrangedSubviews: buttons)
        row.spacing = 12
        row.alignment = .center
        for view in [glyph, titleLabel, bodyLabel, row] as [UIView] { panelStack.addArrangedSubview(view) }
        panelStack.setCustomSpacing(18, after: glyph)
        panelStack.setCustomSpacing(8, after: titleLabel)
        panelStack.setCustomSpacing(22, after: bodyLabel)
        bodyLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 440).isActive = true
    }

    private func primaryButton(_ title: String, _ action: Selector, id: String) -> ThemedButton {
        let button = ThemedButton(title, kind: .primary)
        button.accessibilityIdentifier = id
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    private func ghostButton(_ title: String, _ action: Selector) -> ThemedButton {
        let button = ThemedButton(title, kind: .ghost)
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    private func itemCount(inSection index: Int) -> Int {
        guard let section = currentSnapshot.sectionIdentifiers[safe: index] else { return 0 }
        return currentSnapshot.numberOfItems(inSection: section)
    }

    private func configure(_ header: SectionHeader, section: Section) {
        switch section {
        case .paired:
            header.configure(title: "Paired", status: nil, spinning: false)
        case .network:
            guard coordinator.isSearching else { header.configure(title: "On this network", status: nil, spinning: false); return }
            let long = discoveredOrder.isEmpty && stillLooking
            header.configure(title: "On this network", status: long ? "Still looking" : "Looking",
                             spinning: searchElapsed < 60 && !long)
        }
    }

    // MARK: Cells

    private func configure(_ cell: ComputerCell, item: Item, animated: Bool) {
        switch item {
        case .paired(let hostId):
            guard let computer = coordinator.store.computer(hostId) else { return }
            let status = coordinator.status(for: computer)
            let isLast = coordinator.store.last?.hostId == hostId && coordinator.store.computers.count > 1
            cell.configurePaired(computer, status: status, lastUsed: isLast, menu: menu(for: computer))
            cell.accessibilityCustomActions = [
                UIAccessibilityCustomAction(name: "Rename") { [weak self] _ in self?.promptRename(computer); return true },
                UIAccessibilityCustomAction(name: "Forget") { [weak self] _ in self?.confirmForget(computer); return true }
            ]
        case .discovered(let hostId):
            guard let host = coordinator.verified[hostId] else { return }
            cell.configureDiscovered(host)
            cell.accessibilityCustomActions = nil
        }
    }

    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        guard case .discovered(let hostId) = dataSource.itemIdentifier(for: indexPath), appearing.contains(hostId) else { return }
        appearing.remove(hostId)
        let batchIndex = Double(min(appearing.count, 3))
        cell.alpha = 0
        if !Motion.reduced { cell.transform = CGAffineTransform(translationX: 0, y: 6) }
        Motion.easeOut(0.2, delay: batchIndex * 0.04) {
            cell.alpha = 1
            cell.transform = .identity
        }
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        guard let item = dataSource.itemIdentifier(for: indexPath) else { return }
        switch item {
        case .paired(let hostId):
            guard let computer = coordinator.store.computer(hostId) else { return }
            if overDock { dismiss(animated: false) }
            coordinator.select(computer)
        case .discovered(let hostId):
            guard let host = coordinator.verified[hostId] else { return }
            let cell = collectionView.cellForItem(at: indexPath) as? ComputerCell
            cell?.setBusy(true)
            coordinator.pairDiscovered(host) { [weak cell] _ in cell?.setBusy(false) }
        }
    }

    func collectionView(_ collectionView: UICollectionView, contextMenuConfigurationForItemsAt indexPaths: [IndexPath],
                        point: CGPoint) -> UIContextMenuConfiguration? {
        guard let indexPath = indexPaths.first, case .paired(let hostId) = dataSource.itemIdentifier(for: indexPath),
              let computer = coordinator.store.computer(hostId) else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in self?.menu(for: computer) }
    }

    private func menu(for computer: Computer) -> UIMenu {
        UIMenu(children: [
            UIAction(title: "Rename", image: UIImage(systemName: "pencil")) { [weak self] _ in self?.promptRename(computer) },
            UIAction(title: "Forget", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in self?.confirmForget(computer) }
        ])
    }

    // MARK: Rename / Forget (S4)

    func promptRename(_ computer: Computer) {
        guard let saved = coordinator.store.computer(computer.hostId) else { return }
        let hostName = Computer.cleanHostName(saved.hostName).isEmpty ? saved.address : Computer.cleanHostName(saved.hostName)
        let alert = UIAlertController(title: "Rename computer",
                                      message: "Only this phone uses this name. Leave it empty to use \(hostName).", preferredStyle: .alert)
        alert.view.tintColor = Theme.accent
        let limiter = NicknameLimiter()
        alert.addTextField { field in
            field.text = saved.displayName
            field.autocapitalizationType = .words
            field.clearButtonMode = .whileEditing
            field.returnKeyType = .done
            field.accessibilityLabel = "Name"
            field.delegate = limiter
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in _ = limiter })
        let save = UIAlertAction(title: "Save", style: .default) { [weak self, weak alert] _ in
            let text = alert?.textFields?.first?.text
            self?.coordinator.rename(saved, to: text == Computer.cleanHostName(saved.hostName) ? nil : text)
        }
        alert.addAction(save)
        alert.preferredAction = save
        present(alert, animated: true)
    }

    func confirmForget(_ computer: Computer) {
        let name = computer.displayName
        let alert = UIAlertController(title: "Forget \(name)?",
                                      message: "To connect again, you'll check the security code and enter a new PIN. Your dock stays on \(name). This phone will also be removed from \(name).",
                                      preferredStyle: .alert)
        alert.view.tintColor = Theme.accent
        let cancel = UIAlertAction(title: "Cancel", style: .cancel)
        alert.addAction(cancel)
        alert.addAction(UIAlertAction(title: "Forget", style: .destructive) { [weak self] _ in
            guard let self else { return }
            let presenter = self.view.window?.rootViewController
            self.coordinator.forget(computer) { removed in
                guard !removed else { return }
                let note = UIAlertController(title: "Forgotten on this phone",
                                             message: "\(name) didn't answer, so it may still list this phone. You can remove it there later.",
                                             preferredStyle: .alert)
                note.view.tintColor = Theme.accent
                note.addAction(UIAlertAction(title: "OK", style: .default))
                var top = presenter
                while let next = top?.presentedViewController { top = next }
                top?.present(note, animated: true)
            }
        })
        alert.preferredAction = cancel
        present(alert, animated: true)
    }

    // MARK: Actions

    @objc private func addTapped() { coordinator.presentAddByAddress() }

    @objc private func primeTapped() {
        coordinator.primeLocalNetwork()
        reload(animated: true)
    }

    @objc private func closeTapped() {
        coordinator.root?.dismissModals(animated: true)
    }

    override func accessibilityPerformEscape() -> Bool {
        guard overDock else { return false }
        closeTapped()
        return true
    }
}

/// Max 40 characters in the rename field.
private final class NicknameLimiter: NSObject, UITextFieldDelegate {
    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        let current = (textField.text ?? "") as NSString
        return current.replacingCharacters(in: range, with: string).count <= Computer.nicknameLimit
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

/// 32 tall section header: label + optional trailing status with spinner.
final class SectionHeader: UICollectionReusableView {
    private let title = Theme.label(font: Theme.label, color: Theme.text2)
    private let status = Theme.label(font: Theme.caption, color: Theme.text3)
    private let spinner = makeSpinner(color: Theme.text3)
    private(set) var indexPath: IndexPath?

    override init(frame: CGRect) {
        super.init(frame: frame)
        title.accessibilityTraits = .header
        let trailing = UIStackView(arrangedSubviews: [spinner, status])
        trailing.spacing = 6
        trailing.alignment = .center
        let row = UIStackView(arrangedSubviews: [title, trailing])
        row.alignment = .center
        row.spacing = 8
        title.setContentHuggingPriority(.defaultLow, for: .horizontal)
        status.numberOfLines = 1
        status.setContentHuggingPriority(.required, for: .horizontal)
        status.setContentCompressionResistancePriority(.required, for: .horizontal)
        addSubview(row)
        row.pinEdges(to: self, insets: UIEdgeInsets(top: 0, left: 4, bottom: 0, right: 4))
        heightAnchor.constraint(greaterThanOrEqualToConstant: 32).isActive = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func apply(_ attributes: UICollectionViewLayoutAttributes) {
        super.apply(attributes)
        indexPath = attributes.indexPath
    }

    func configure(title text: String, status statusText: String?, spinning: Bool) {
        title.text = text
        status.text = statusText
        status.isHidden = statusText == nil
        if spinning && statusText != nil { spinner.startAnimating() } else { spinner.stopAnimating() }
        accessibilityElements = [title, status]
    }
}

final class FooterCaption: UICollectionReusableView {
    let label = Theme.label(font: Theme.caption, color: Theme.text3)
    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(label)
        label.pinEdges(to: self, insets: UIEdgeInsets(top: 16, left: 4, bottom: 24, right: 4))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// 28 pt fade at the list's bottom edge that signals more rows.
final class GradientFade: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }
    override init(frame: CGRect) {
        super.init(frame: frame)
        let gradient = layer as! CAGradientLayer
        gradient.colors = [Theme.bg.withAlphaComponent(0).cgColor, Theme.bg.cgColor]
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}

/// One computer row: glyph 40, title 17/600, subtitle with status dot, trailing "…" / Pair / check.
final class ComputerCell: UICollectionViewListCell {
    private let glyph = GlyphTile(symbol: Theme.Icon.monitor)
    private let title = Theme.label(font: Theme.headline, lines: 1)
    private let subtitle = Theme.label(font: Theme.subhead, color: Theme.text2, lines: 1)
    private let mark = StatusMark()
    private let more = UIButton(type: .system)
    private let pill = PillLabel(text: "Pair")
    private let checkmark = UIImageView(image: Theme.symbol(Theme.Icon.check, size: 18, weight: .medium))
    private let busy = makeSpinner(color: Theme.accent)
    private var compact = false
    private var titleText = ""

    override init(frame: CGRect) {
        super.init(frame: frame)
        title.lineBreakMode = .byTruncatingTail
        subtitle.lineBreakMode = .byTruncatingTail
        let subRow = UIStackView(arrangedSubviews: [mark, subtitle])
        subRow.spacing = 6
        subRow.alignment = .center
        let text = UIStackView(arrangedSubviews: [title, subRow])
        text.axis = .vertical
        text.spacing = 2
        var config = UIButton.Configuration.plain()
        config.image = Theme.symbol(Theme.Icon.more, size: 17, weight: .semibold)
        config.baseForegroundColor = Theme.text3
        more.configuration = config
        more.showsMenuAsPrimaryAction = true
        more.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([more.widthAnchor.constraint(equalToConstant: 44), more.heightAnchor.constraint(equalToConstant: 44)])
        checkmark.tintColor = Theme.accent
        for view in [busy, pill, checkmark, more] as [UIView] {
            view.setContentHuggingPriority(.required, for: .horizontal)
            view.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        let trailing = UIStackView(arrangedSubviews: [busy, pill, checkmark, more])
        trailing.spacing = 8
        trailing.alignment = .center
        let row = UIStackView(arrangedSubviews: [glyph, text, trailing])
        row.spacing = 14
        row.alignment = .center
        text.setContentHuggingPriority(.defaultLow, for: .horizontal)
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        trailing.setContentCompressionResistancePriority(.required, for: .horizontal)
        contentView.addSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -6),
            row.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 10),
            row.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -10),
            contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 64)
        ])
        isAccessibilityElement = true
        accessibilityTraits = .button
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func updateConfiguration(using state: UICellConfigurationState) {
        var background = UIBackgroundConfiguration.listPlainCell()
        background.backgroundColor = state.isHighlighted || state.isSelected ? Theme.rowPressed : groupColor
        backgroundConfiguration = background
    }

    /// The group (radius 16) is drawn by its rows: the first rounds the top, the last the bottom.
    var groupColor = Theme.row

    func setGroupCorners(first: Bool, last: Bool) {
        var corners: CACornerMask = []
        if first { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
        if last { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
        layer.cornerRadius = corners.isEmpty ? 0 : 16
        layer.cornerCurve = .continuous
        layer.maskedCorners = corners
        clipsToBounds = true
    }

    private func subtitleText(_ parts: [String], address: String?, color: UIColor = Theme.text2) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let separator = NSAttributedString(string: "  ·  ", attributes: [.font: Theme.subhead, .foregroundColor: Theme.text3])
        for (index, part) in parts.enumerated() {
            if index > 0 { result.append(separator) }
            result.append(NSAttributedString(string: part, attributes: [.font: Theme.subhead, .foregroundColor: color]))
        }
        if let address, !address.isEmpty {
            if !parts.isEmpty { result.append(separator) }
            result.append(NSAttributedString(string: address, attributes: [.font: Theme.font(12, mono: true), .foregroundColor: Theme.text3]))
        }
        return result
    }

    func configurePaired(_ computer: Computer, status: RowStatus, lastUsed: Bool, menu: UIMenu) {
        titleText = computer.displayName
        title.text = computer.displayName
        pill.isHidden = true
        checkmark.isHidden = true
        busy.stopAnimating()
        more.isHidden = false
        more.menu = menu
        more.accessibilityLabel = "More for \(computer.displayName)"
        let platform = Computer.platformWord(computer.platform)
        var spoken: [String] = [computer.displayName]
        let change: () -> Void
        switch status {
        case .checking:
            change = {
                self.glyph.set(symbol: Theme.Icon.monitor, tone: .neutral)
                self.mark.show(.spinner)
                self.subtitle.attributedText = self.subtitleText(["Checking…"], address: nil)
            }
            spoken.append("Checking")
        case .online(let address):
            let detail = lastUsed ? "Last used" : (platform ?? "")
            change = {
                self.glyph.set(symbol: Theme.Icon.monitor, tone: .accent)
                self.mark.show(.dot(.live))
                self.subtitle.attributedText = self.subtitleText(["Online"] + (detail.isEmpty ? [] : [detail]), address: address)
            }
            spoken += ["Online"] + (lastUsed ? ["Last used"] : []) + (platform.map { [$0] } ?? [])
        case .notFound(let address):
            change = {
                self.glyph.set(symbol: Theme.Icon.monitor, tone: .neutral)
                self.mark.show(.dot(.ring))
                self.subtitle.attributedText = self.subtitleText(["Not found on this network"], address: address)
            }
            spoken.append("Not found on this network")
        case .securityChanged:
            change = {
                self.glyph.set(symbol: Theme.Icon.shield, tone: .danger)
                self.mark.show(.dot(.danger))
                self.subtitle.attributedText = self.subtitleText(["Security code changed. Tap to check."], address: nil, color: Theme.dangerText)
            }
            spoken.append("Security code changed. Tap to check")
        case .needsPin:
            change = {
                self.glyph.set(symbol: Theme.Icon.monitor, tone: .neutral)
                self.mark.show(.none)
                self.subtitle.attributedText = self.subtitleText(["Needs a new PIN"], address: nil)
            }
            spoken.append("Needs a new PIN")
        }
        let previous = subtitle.attributedText
        change()
        if window != nil, let previous, previous != subtitle.attributedText {
            let next = subtitle.attributedText
            subtitle.attributedText = previous
            Motion.crossfade(subtitle) { self.subtitle.attributedText = next }
        }
        accessibilityLabel = spoken.joined(separator: ". ")
        accessibilityHint = status == .securityChanged ? "Shows the security code." : "Opens its dock."
        accessibilityIdentifier = "paired-\(computer.hostId)"
    }

    func configureDiscovered(_ host: VerifiedHost) {
        titleText = host.displayName
        title.text = host.displayName
        glyph.set(symbol: Theme.Icon.monitor, tone: .neutral)
        mark.show(.none)
        let platform = Computer.platformWord(host.platform)
        subtitle.attributedText = subtitleText(platform.map { [$0] } ?? [], address: host.address)
        pill.isHidden = false
        checkmark.isHidden = true
        more.isHidden = true
        busy.stopAnimating()
        accessibilityLabel = [host.displayName, platform, "not paired"].compactMap { $0 }.joined(separator: ", ")
        accessibilityHint = "Starts pairing."
        accessibilityIdentifier = "discovered-\(host.hostId)"
    }

    func setBusy(_ isBusy: Bool) {
        if isBusy { busy.startAnimating(); pill.isHidden = true } else { busy.stopAnimating(); pill.isHidden = more.isHidden == false }
        isUserInteractionEnabled = !isBusy
    }
}

/// The 32 tall "Pair" pill (visual only; the whole row is the target).
final class PillLabel: UILabel {
    init(text: String) {
        super.init(frame: .zero)
        self.text = text
        font = Theme.font(13, .semibold)
        adjustsFontForContentSizeCategory = true
        textColor = Theme.accent
        backgroundColor = Theme.accentTint
        textAlignment = .center
        layer.cornerRadius = 16
        layer.masksToBounds = true
        isAccessibilityElement = false
        setContentCompressionResistancePriority(.required, for: .horizontal)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 28, height: max(32, size.height + 12))
    }
}

/// The leading status mark in a row subtitle: a 7 pt dot, a small spinner, or nothing.
/// One fixed-size view, so a stack view never has to hide and show an animating spinner.
final class StatusMark: UIView {
    enum Kind: Equatable { case none, spinner, dot(StatusDot.Style) }
    let dot = StatusDot()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var width: NSLayoutConstraint!

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        isAccessibilityElement = false
        spinner.color = Theme.text3
        spinner.hidesWhenStopped = false
        spinner.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
        for view in [dot, spinner] as [UIView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
            NSLayoutConstraint.activate([view.centerXAnchor.constraint(equalTo: centerXAnchor), view.centerYAnchor.constraint(equalTo: centerYAnchor)])
        }
        width = widthAnchor.constraint(equalToConstant: 7)
        NSLayoutConstraint.activate([width, heightAnchor.constraint(equalToConstant: 12)])
        show(.none)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(_ kind: Kind) {
        if isHidden != (kind == .none) { isHidden = kind == .none }
        switch kind {
        case .none:
            spinner.stopAnimating()
            spinner.alpha = 0
            dot.alpha = 0
            width.constant = 0
        case .spinner:
            spinner.alpha = 1
            spinner.startAnimating()
            dot.alpha = 0
            width.constant = 12
        case .dot(let style):
            spinner.stopAnimating()
            spinner.alpha = 0
            dot.style = style
            dot.alpha = 1
            width.constant = 7
        }
    }
}
