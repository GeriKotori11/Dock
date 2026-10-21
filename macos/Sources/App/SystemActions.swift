// Native actions behind bridge messages: login item, logs folder, Firewall
// settings, Node.js download page.
import AppKit
import ServiceManagement

enum LoginItem {
    /// The page's states: "on" | "off" | "requiresApproval" | "unavailable".
    static func state() -> String {
        switch SMAppService.mainApp.status {
        case .enabled: return "on"
        case .requiresApproval: return "requiresApproval"
        case .notRegistered, .notFound: return "off"
        @unknown default: return "unavailable"
        }
    }

    /// Registers or unregisters the app as a login item; returns the error, if any.
    @discardableResult
    static func set(enabled: Bool) -> Error? {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return nil
        } catch {
            return error
        }
    }

    static func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}

enum SystemActions {
    /// System Settings → Network → Firewall. The first URL is the Ventura and
    /// later Network pane anchor; the second is the pre-Ventura Security pane,
    /// which current macOS redirects; last resort opens System Settings itself.
    static let firewallURLs = [
        "x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall",
        "x-apple.systempreferences:com.apple.preference.security?Firewall",
    ]
    static let nodeDownloadURL = URL(string: "https://nodejs.org/en/download")!

    static func openFirewallSettings() {
        for text in firewallURLs {
            if let url = URL(string: text), NSWorkspace.shared.open(url) { return }
        }
        if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.systempreferences") {
            NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    /// Reveals ~/Library/Logs/WinDock in Finder (host.log selected when it exists).
    static func revealLogs(in directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let logFile = directory.appendingPathComponent("host.log")
        if FileManager.default.fileExists(atPath: logFile.path) {
            NSWorkspace.shared.activateFileViewerSelecting([logFile])
        } else {
            NSWorkspace.shared.open(directory)
        }
    }

    static func openNodeDownload() { NSWorkspace.shared.open(nodeDownloadURL) }
}
