// Shell ⇄ page bridge rules (HOST-CONTROL-PAGE.md 13.5): which frames may talk
// to the app, which messages exist, where the web view may navigate, and the
// `window.WinDockShell` object injected at document start.
import Foundation

/// The bundled offline page is served under this scheme by the app itself.
enum OfflineOrigin {
    static let scheme = "windock-offline"
    static let host = "offline"
    static func url(revision: Int) -> URL { URL(string: "\(scheme)://\(host)/?r=\(revision)")! }
}

/// The security origin of the frame that sent a message.
struct FrameOrigin: Equatable {
    var isMainFrame: Bool
    var scheme: String
    var host: String
    var port: Int
}

enum BridgeSource: Equatable {
    case host
    case offline
}

enum BridgeMessage: Equatable {
    case ready
    case resize(height: Double)
    case close
    case openWindow
    case loginItemSet(enabled: Bool)
    case loginItemOpenSettings
    case openLogs
    case restart
    case quit
    case openFirewallSettings
    /// Offline page only: "Get Node.js" (opens nodejs.org; no URL comes from the page).
    case getNode
}

enum ShellContainer: String {
    case popover
    case window
}

struct BridgeRules {
    let port: Int

    /// Messages are accepted only from the main frame at exactly
    /// http://127.0.0.1:{port}, or from the app's own offline page.
    func source(of origin: FrameOrigin) -> BridgeSource? {
        guard origin.isMainFrame else { return nil }
        if origin.scheme == "http", origin.host == "127.0.0.1", origin.port == port { return .host }
        if origin.scheme == OfflineOrigin.scheme, origin.host == OfflineOrigin.host { return .offline }
        return nil
    }

    /// Parses a posted message. Unknown types, wrong payload types and actions
    /// the offline page doesn't show are dropped.
    func message(_ body: Any, from origin: FrameOrigin) -> (BridgeSource, BridgeMessage)? {
        guard let source = source(of: origin),
              let object = body as? [String: Any],
              let type = object["type"] as? String else { return nil }
        let message: BridgeMessage
        switch type {
        case "ready": message = .ready
        case "resize":
            guard let height = Self.number(object["height"]), height.isFinite, height > 0 else { return nil }
            message = .resize(height: height)
        case "close": message = .close
        case "openWindow": message = .openWindow
        case "loginItem.set":
            guard let enabled = Self.boolean(object["enabled"]) else { return nil }
            message = .loginItemSet(enabled: enabled)
        case "loginItem.openSettings": message = .loginItemOpenSettings
        case "openLogs": message = .openLogs
        case "restart": message = .restart
        case "quit": message = .quit
        case "openFirewallSettings": message = .openFirewallSettings
        case "getNode": message = .getNode
        default: return nil
        }
        switch (source, message) {
        case (.offline, .ready), (.offline, .resize), (.offline, .close), (.offline, .openLogs),
             (.offline, .restart), (.offline, .quit), (.offline, .getNode):
            return (source, message)
        case (.offline, _):
            return nil
        case (.host, .getNode):
            return nil
        case (.host, _):
            return (source, message)
        }
    }

    /// A JS boolean arrives as a CFBoolean NSNumber; 0 and 1 are not booleans.
    static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return number.doubleValue
    }

    // ---- navigation ----

    enum Navigation: Equatable {
        case allow
        case openExternally(URL)
        case block
    }

    /// Only /host* on the host origin and the offline page load in the web
    /// view. A link the person clicked to any other http(s) address opens in the
    /// default browser; everything else is blocked.
    func navigation(to url: URL?, userInitiated: Bool) -> Navigation {
        guard let url, let scheme = url.scheme?.lowercased() else { return .block }
        if scheme == OfflineOrigin.scheme { return url.host == OfflineOrigin.host ? .allow : .block }
        if isHostPage(url) { return .allow }
        if (scheme == "http" || scheme == "https"), url.host != nil, userInitiated {
            if scheme == "http", url.host == "127.0.0.1", url.port == port { return .block }
            return .openExternally(url)
        }
        return .block
    }

    func isHostOrigin(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme?.lowercased() == "http" && url.host == "127.0.0.1" && url.port == port
            && url.user == nil && url.password == nil
    }

    func isHostPage(_ url: URL) -> Bool {
        guard isHostOrigin(url) else { return false }
        let path = url.path
        if path.split(separator: "/").contains("..") { return false }
        return path == "/host" || path.hasPrefix("/host/")
    }

    // ---- injected script ----

    struct Capabilities: Equatable {
        var restart: Bool
    }

    /// `window.WinDockShell`, frozen, defined only on the host origin and the
    /// offline page (the user script is main-frame only as well).
    func shellScript(container: ShellContainer, version: String, capabilities: Capabilities) -> String {
        let shell: [String: Any] = [
            "os": "macos",
            "container": container.rawValue,
            "version": version,
            "capabilities": [
                "loginItem": true,
                "quit": true,
                "restart": capabilities.restart,
                "logs": true,
                "updates": false,
                "openWindow": true,
                "firewallSettings": true,
            ],
        ]
        let data = (try? JSONSerialization.data(withJSONObject: shell, options: [.sortedKeys])) ?? Data("{}".utf8)
        let json = String(decoding: data, as: UTF8.self)
        return "(function(){var l=window.location;"
            + "if(!((l.protocol==='http:'&&l.host==='127.0.0.1:\(port)')||l.protocol==='\(OfflineOrigin.scheme):'))return;"
            + "var s=\(json);Object.freeze(s.capabilities);"
            + "Object.defineProperty(window,'WinDockShell',{value:Object.freeze(s),writable:false,configurable:false,enumerable:true});})();"
    }

    /// JS that dispatches one `windockshell` event with `detail`.
    static func eventScript(_ detail: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(detail),
              let data = try? JSONSerialization.data(withJSONObject: detail, options: [.sortedKeys]) else { return nil }
        let json = String(decoding: data, as: UTF8.self)
        return "window.dispatchEvent(new CustomEvent('windockshell',{detail:\(json)}));"
    }
}

/// Popover height from the page's `resize` message (3.1): min 320, max
/// min(680, visibleFrame.height − 40), then the page scrolls.
enum PopoverLayout {
    static let width: CGFloat = 380
    static let minHeight: CGFloat = 320
    static let maxHeight: CGFloat = 680
    static let initialHeight: CGFloat = 480

    static func height(requested: Double, visibleHeight: CGFloat) -> CGFloat {
        let ceiling = min(maxHeight, visibleHeight - 40)
        let wanted = max(minHeight, CGFloat(requested.rounded(.up)))
        return max(min(wanted, ceiling), min(minHeight, ceiling))
    }
}
