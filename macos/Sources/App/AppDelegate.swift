// The menu-bar app (HOST-CONTROL-PAGE.md 6.1, 13.5, 13.6): status item, popover,
// detached window, native menu, and the glue between the host lifecycle and
// the pages.
import AppKit
import os

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate, NSMenuDelegate,
                         HostControllerDelegate, WebPaneDelegate {
    /// What the panes show.
    enum PaneContent: Equatable {
        case nothing
        case host(restart: Bool)
        case offline(OfflineVariant, detail: String)
    }

    static let startingDelay: TimeInterval = 0.4

    private(set) var settings: AppSettings!
    private(set) var host: HostController!
    private let log = HostLog()
    private let logger = Logger(subsystem: "dev.gerikotori.windock.menu", category: "app")

    private(set) var statusItem: NSStatusItem!
    private(set) var popover: NSPopover!
    private(set) var popoverPane: WebPane!
    private(set) var windowController: HostWindowController?
    private(set) var statusMenu: NSMenu!
    private var statusLine: NSMenuItem!
    private(set) var content: PaneContent = .nothing
    private var startingWork: DispatchWorkItem?
    private(set) var firewall: FirewallState = .unknown
    private var firewallChecking = false
    private var lastPopoverHeight: CGFloat = PopoverLayout.initialHeight
    private var signalSources: [DispatchSourceSignal] = []

    // ---- launch --------------------------------------------------------

    func applicationDidFinishLaunching(_ notification: Notification) {
        settings = AppSettings.load()
        host = HostController(settings: settings, log: log)
        host.delegate = self
        installMainMenu()
        installStatusItem()
        installPopover()
        installSignalHandlers()
        #if DEBUG
        Automation.install(self)
        #endif
        logger.info("WinDock menu-bar app on port \(self.settings.port), repo \(self.settings.repoPath, privacy: .public)")
        host.start()
    }

    /// Quit stops the host this app spawned (SIGTERM, SIGKILL after 3 s), then
    /// exits. Synchronous on purpose: terminate can be called from inside a
    /// main-queue block (signal handler), where an asynchronous wait for the
    /// host's exit would never be delivered. Node exits on SIGTERM in milliseconds.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        host?.stopNow()
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        host?.stopNow()
        log.close()
    }

    /// SIGTERM / SIGINT / SIGHUP quit like the Quit item, so the owned host stops too.
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
    }

    /// Hidden for an LSUIElement app, but gives the web views ⌘C/⌘V/⌘A/⌘Z and ⌘Q.
    private func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "WinDock")
        appMenu.addItem(withTitle: "Quit WinDock", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
    }

    // ---- status item and native menu (6.1) ------------------------------

    private func installStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.autosaveName = "WinDockStatusItem"
        if let button = statusItem.button {
            button.image = StatusIcon.image(problem: false)
            button.target = self
            button.action = #selector(statusItemClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.setAccessibilityTitle("WinDock")
        }
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Open WinDock", action: #selector(openPopoverFromMenu(_:)), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        let pair = NSMenuItem(title: "Pair a new phone…", action: #selector(pairNewPhone(_:)), keyEquivalent: "")
        pair.target = self
        menu.addItem(pair)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit WinDock", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.target = NSApp
        menu.addItem(quit)
        statusMenu = menu
        updateStatusItem()
    }

    @objc private func statusItemClicked(_ sender: Any?) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            showStatusMenu()
        } else {
            togglePopover()
        }
    }

    func showStatusMenu() {
        if popover.isShown { popover.performClose(nil) }
        statusLine.title = statusLineText()
        statusItem.menu = statusMenu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    func menuWillOpen(_ menu: NSMenu) {
        statusLine.title = statusLineText()
        host.refreshStatus()
    }

    @objc func openPopoverFromMenu(_ sender: Any?) { showPopover() }

    /// "Pair a new phone…": opens the popover in the Pair view.
    @objc func pairNewPhone(_ sender: Any?) {
        showPopover()
        popoverPane.requestPair()
    }

    func statusLineText() -> String {
        switch host.phase {
        case .running:
            guard host.statusKnown else { return "Running" }
            if let address = host.status?.address { return "Running on \(address)" }
            return "Not connected to a network"
        case .probing, .starting: return "Starting…"
        case .problem: return "Stopped"
        }
    }

    var needsAttention: Bool {
        guard host.phase == .running else { return false }
        return firewall == .blocked || (host.statusKnown && host.status?.address == nil)
    }

    var tooltipText: String {
        switch host.phase {
        case .running: return needsAttention ? "WinDock · Needs attention" : "WinDock · Running"
        case .probing, .starting: return "WinDock · Starting"
        case .problem: return "WinDock · Stopped"
        }
    }

    private func updateStatusItem() {
        guard let button = statusItem?.button, let host else { return }
        var problem = needsAttention
        if case .problem = host.phase { problem = true }
        button.image = StatusIcon.image(problem: problem)
        button.toolTip = tooltipText
        statusLine?.title = statusLineText()
    }

    // ---- popover (3.1) -------------------------------------------------

    private func installPopover() {
        popover = NSPopover()
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
        popover.appearance = NSAppearance(named: .darkAqua)
        popoverPane = WebPane(container: .popover, port: settings.port)
        popoverPane.delegate = self
        popover.contentViewController = popoverPane
        popover.contentSize = NSSize(width: PopoverLayout.width, height: PopoverLayout.initialHeight)
        _ = popoverPane.view // load the web view now so the first open is instant
    }

    func togglePopover() {
        if popover.isShown { popover.performClose(nil) } else { showPopover() }
    }

    func showPopover() {
        guard let button = statusItem.button else { return }
        if !popover.isShown {
            NSApp.activateCompat()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
        popover.contentViewController?.view.window?.makeKey()
        popover.contentViewController?.view.window?.makeFirstResponder(popoverPane.webView)
    }

    func popoverDidShow(_ notification: Notification) {
        popoverPane.send(["type": "visibility", "visible": true])
        checkFirewall()
        host.refreshStatus()
    }

    func popoverDidClose(_ notification: Notification) {
        popoverPane.send(["type": "visibility", "visible": false])
    }

    func popoverShouldDetach(_ popover: NSPopover) -> Bool { true }

    /// Dragging the popover off detaches it into the window.
    func detachableWindow(for popover: NSPopover) -> NSWindow? {
        let controller = ensureWindow()
        return controller.window
    }

    private func visibleHeight() -> CGFloat {
        let screen = statusItem.button?.window?.screen ?? NSScreen.main
        return screen?.visibleFrame.height ?? 800
    }

    // ---- window (3.1) --------------------------------------------------

    @discardableResult
    private func ensureWindow() -> HostWindowController {
        if let windowController { return windowController }
        let controller = HostWindowController(port: settings.port, height: lastPopoverHeight, paneDelegate: self)
        controller.onClose = { [weak self, weak controller] in
            guard let self, let controller, self.windowController === controller else { return }
            DispatchQueue.main.async { self.windowController = nil }
        }
        windowController = controller
        apply(content, to: controller.pane)
        return controller
    }

    func openWindow() {
        if popover.isShown { popover.performClose(nil) }
        ensureWindow().present()
    }

    // ---- host → panes --------------------------------------------------

    func hostControllerDidChange(_ controller: HostController) {
        updateStatusItem()
        switch controller.phase {
        case .running:
            startingWork?.cancel()
            setContent(.host(restart: controller.mode == .owned))
            checkFirewall()
        case .probing, .starting(slow: false):
            // "Starting" appears only after 400 ms, so a quick start never flashes it.
            startingWork?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                switch self.host.phase {
                case .probing, .starting(slow: false): self.setContent(.offline(.starting, detail: ""))
                default: break
                }
            }
            startingWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.startingDelay, execute: work)
        case .starting(slow: true):
            setContent(.offline(.slow, detail: ""))
        case let .problem(variant, detail):
            startingWork?.cancel()
            setContent(.offline(variant, detail: detail))
        }
    }

    func hostControllerStatusDidChange(_ controller: HostController) {
        updateStatusItem()
        if firewall == .unknown { checkFirewall() }
    }

    private func setContent(_ next: PaneContent) {
        guard next != content else { return }
        content = next
        for pane in panes() { apply(next, to: pane) }
    }

    private func apply(_ content: PaneContent, to pane: WebPane) {
        switch content {
        case .nothing: break
        case let .host(restart): pane.load(hostRunning: true, capabilities: .init(restart: restart))
        case .offline: pane.load(hostRunning: false, capabilities: .init(restart: false))
        }
    }

    private func panes() -> [WebPane] {
        var list: [WebPane] = [popoverPane]
        if let windowController { list.append(windowController.pane) }
        return list
    }

    private func broadcast(_ detail: [String: Any]) {
        for pane in panes() { pane.send(detail) }
    }

    // ---- firewall (13.6) -----------------------------------------------

    func checkFirewall() {
        guard !firewallChecking else { return }
        firewallChecking = true
        let node = host.nodePath
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let state = Firewall.check(nodePath: node)
            DispatchQueue.main.async {
                guard let self else { return }
                self.firewallChecking = false
                guard state != self.firewall else { return }
                self.firewall = state
                self.logger.info("firewall: \(state.rawValue, privacy: .public)")
                self.broadcast(["type": "firewall", "state": state.rawValue])
                self.updateStatusItem()
            }
        }
    }

    // ---- page → native (13.5) ------------------------------------------

    func offlineContent(for pane: WebPane) -> (variant: OfflineVariant, detail: String) {
        if case let .offline(variant, detail) = content { return (variant, detail) }
        return (.starting, "")
    }

    func webPane(_ pane: WebPane, received message: BridgeMessage, from source: BridgeSource) {
        switch message {
        case .ready:
            guard source == .host else { break }
            pane.send(["type": "loginItem", "state": LoginItem.state()])
            pane.send(["type": "visibility", "visible": isVisible(pane)])
            pane.send(["type": "firewall", "state": firewall.rawValue])
        case let .resize(height):
            guard pane.container == .popover else { break }
            let clamped = PopoverLayout.height(requested: height, visibleHeight: visibleHeight())
            lastPopoverHeight = clamped
            if abs(popover.contentSize.height - clamped) >= 1 {
                popover.contentSize = NSSize(width: PopoverLayout.width, height: clamped)
            }
        case .close:
            if pane.container == .popover { popover.performClose(nil) } else { windowController?.close() }
        case .openWindow:
            openWindow()
        case let .loginItemSet(enabled):
            if let error = LoginItem.set(enabled: enabled) {
                logger.error("login item \(enabled ? "register" : "unregister", privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            }
            broadcast(["type": "loginItem", "state": LoginItem.state()])
        case .loginItemOpenSettings:
            LoginItem.openSettings()
        case .openLogs:
            SystemActions.revealLogs(in: log.directory)
        case .restart:
            // Attached hosts can't be restarted from here (5.8); the host page
            // doesn't offer it then (capabilities.restart is false).
            if source == .host && host.mode != .owned { break }
            host.restart()
        case .quit:
            NSApp.terminate(nil)
        case .openFirewallSettings:
            SystemActions.openFirewallSettings()
        case .getNode:
            SystemActions.openNodeDownload()
        }
    }

    private func isVisible(_ pane: WebPane) -> Bool {
        if pane === popoverPane { return popover.isShown }
        return windowController?.isVisible ?? false
    }
}
