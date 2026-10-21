// The detached window (HOST-CONTROL-PAGE.md 3.1): opens 380 × the popover's
// height, resizable, min 360 × 420, remembers its frame. Transparent title
// bar with a full-size content view; the page adds a 28 px top inset for the
// traffic lights (WinDockShell.container = "window").
import AppKit

final class HostWindowController: NSWindowController, NSWindowDelegate {
    static let autosaveName = "WinDockHostWindow"
    let pane: WebPane
    var onClose: (() -> Void)?

    init(port: Int, height: CGFloat, paneDelegate: WebPaneDelegate) {
        pane = WebPane(container: .window, port: port)
        pane.delegate = paneDelegate
        let size = NSSize(width: PopoverLayout.width, height: max(420, height))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = "WinDock"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.backgroundColor = NSColor(srgbRed: 0x09 / 255, green: 0x0E / 255, blue: 0x10 / 255, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentViewController = pane
        window.contentMinSize = NSSize(width: 360, height: 420)
        window.setContentSize(size)
        window.center()
        // Restores the saved frame when there is one.
        window.setFrameAutosaveName(Self.autosaveName)
        super.init(window: window)
        window.delegate = self
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func present() {
        NSApp.activateCompat()
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(pane.webView)
        pane.send(["type": "visibility", "visible": true])
    }

    var isVisible: Bool { window?.isVisible == true && window?.isMiniaturized == false }

    func windowDidMiniaturize(_ notification: Notification) { pane.send(["type": "visibility", "visible": false]) }
    func windowDidDeminiaturize(_ notification: Notification) { pane.send(["type": "visibility", "visible": true]) }

    func windowWillClose(_ notification: Notification) {
        pane.send(["type": "visibility", "visible": false])
        onClose?()
    }
}

extension NSApplication {
    func activateCompat() {
        if #available(macOS 14.0, *) { activate() } else { activate(ignoringOtherApps: true) }
    }
}
