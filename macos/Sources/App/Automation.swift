// Debug builds only: drive the app from a script for live verification, where
// clicking the menu-bar item isn't possible (no Accessibility access).
//
//   osascript -l JavaScript -e 'ObjC.import("Foundation");
//     $.NSDistributedNotificationCenter.defaultCenter
//       .postNotificationNameObjectUserInfoDeliverImmediately(
//         "dev.gerikotori.windock.menu.automation", "open", $(), true)'
//
// Commands (the notification's object string, fields separated by "|"):
//   open | close | toggle | pair | window | closeWindow | menu | quit
//   snapshot|popover|<png path>     snapshot|window|<png path>
//   js|popover|<script>             runs page JS (e.g. to click a control)
//   state|<json path>               writes the app's state
#if DEBUG
import AppKit

enum Automation {
    static let name = Notification.Name("dev.gerikotori.windock.menu.automation")
    private static var token: NSObjectProtocol?

    static func install(_ app: AppDelegate) {
        token = DistributedNotificationCenter.default().addObserver(
            forName: name, object: nil, queue: .main
        ) { [weak app] note in
            guard let app, let command = note.object as? String else { return }
            run(command, app: app)
        }
    }

    private static func run(_ command: String, app: AppDelegate) {
        let parts = command.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        switch parts.first ?? "" {
        case "open": app.showPopover()
        case "close": app.popover.performClose(nil)
        case "toggle": app.togglePopover()
        case "pair": app.pairNewPhone(nil)
        case "window": app.openWindow()
        case "closeWindow": app.windowController?.close()
        case "menu":
            // The menu runs a modal tracking loop; close it again after 2 s.
            let timer = Timer(timeInterval: 2, repeats: false) { [weak app] _ in app?.statusMenu.cancelTracking() }
            RunLoop.main.add(timer, forMode: .common)
            RunLoop.main.add(timer, forMode: .eventTracking)
            app.showStatusMenu()
        case "quit": NSApp.terminate(nil)
        case "snapshot" where parts.count == 3:
            let pane = parts[1] == "window" ? app.windowController?.pane : app.popoverPane
            pane?.snapshot(to: URL(fileURLWithPath: parts[2])) { _ in }
        case "js" where parts.count == 3:
            let pane = parts[1] == "window" ? app.windowController?.pane : app.popoverPane
            pane?.webView.evaluateJavaScript(parts[2], completionHandler: nil)
        case "state" where parts.count == 2:
            writeState(app, to: URL(fileURLWithPath: parts[1]))
        default: break
        }
    }

    private static func writeState(_ app: AppDelegate, to url: URL) {
        let phase: String
        switch app.host.phase {
        case .probing: phase = "probing"
        case let .starting(slow): phase = slow ? "starting-slow" : "starting"
        case .running: phase = "running"
        case let .problem(variant, detail): phase = "problem:\(variant):\(detail)"
        }
        let content: String
        switch app.content {
        case .nothing: content = "nothing"
        case let .host(restart): content = "host(restart: \(restart))"
        case let .offline(variant, detail): content = "offline(\(variant), \(detail))"
        }
        var state: [String: Any] = [
            "mode": app.host.mode.rawValue,
            "phase": phase,
            "content": content,
            "port": app.settings.port,
            "repoPath": app.settings.repoPath,
            "nodePath": app.host.nodePath ?? NSNull(),
            "popoverShown": app.popover.isShown,
            "popoverSize": [app.popover.contentSize.width, app.popover.contentSize.height],
            "popoverURL": app.popoverPane.webView.url?.absoluteString ?? NSNull(),
            "popoverPageReady": app.popoverPane.pageReady,
            "windowOpen": app.windowController != nil,
            "loginItem": LoginItem.state(),
            "firewall": app.firewall.rawValue,
            "tooltip": app.statusItem.button?.toolTip ?? NSNull(),
            "statusLine": app.statusLineText(),
            "menu": app.statusMenu.items.map { $0.isSeparatorItem ? "—" : $0.title + ($0.keyEquivalent.isEmpty ? "" : " ⌘" + $0.keyEquivalent.uppercased()) + ($0.isEnabled ? "" : " (disabled)") },
            "statusIconIsTemplate": app.statusItem.button?.image?.isTemplate ?? false,
        ]
        if let window = app.windowController?.window {
            state["windowFrame"] = [window.frame.width, window.frame.height]
            state["windowURL"] = app.windowController?.pane.webView.url?.absoluteString ?? NSNull()
        }
        if let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: url)
        }
    }
}
#endif
