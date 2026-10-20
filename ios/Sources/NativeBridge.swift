import Foundation
import WebKit

/// Messages the shared web dock sends to the native shell (spec section 11).
enum BridgeMessage: Equatable {
    /// The drawer's connection row was tapped: show the Switch computer sheet.
    case switchComputer
    /// The page is up; `switcher` says it draws the drawer switch row itself.
    case ready(switcher: Bool)
    /// The host no longer accepts this phone's session: ask for a new PIN natively.
    case unauthorized
}

enum NativeBridge {
    static let handlerName = "windock"

    /// Injected at document start in the main frame only.
    static func userScriptSource(computerName: String) -> String {
        let payload: [String: Any] = ["platform": "ios", "switcher": true, "computerName": computerName]
        let json = (try? JSONSerialization.data(withJSONObject: payload)).flatMap { String(data: $0, encoding: .utf8) }
            ?? #"{"platform":"ios","switcher":true}"#
        return """
            (function () {
              window.WinDockNative = \(json);
              window.dispatchEvent(new Event("windock-native-ready"));
            })();
            """
    }

    /// Unknown or malformed messages are ignored (nil).
    static func parse(_ body: Any) -> BridgeMessage? {
        guard let object = body as? [String: Any], let type = object["type"] as? String else { return nil }
        switch type {
        case "switch": return .switchComputer
        case "ready": return .ready(switcher: object["switcher"] as? Bool == true)
        case "unauthorized": return .unauthorized
        default: return nil
        }
    }

    /// Accept a message only from the main frame of the selected computer's exact origin.
    static func originMatches(scheme: String, host: String, port: Int, endpoint: URL) -> Bool {
        guard let endpointScheme = endpoint.scheme?.lowercased(), let endpointHost = endpoint.host?.lowercased() else { return false }
        let effective = port == 0 ? (scheme.lowercased() == "https" ? 443 : 80) : port
        return scheme.lowercased() == endpointScheme && host.lowercased() == endpointHost &&
            effective == EndpointPolicy.effectivePort(endpoint)
    }

    static func accept(_ message: WKScriptMessage, endpoint: URL?) -> BridgeMessage? {
        guard let endpoint, message.name == handlerName, message.frameInfo.isMainFrame else { return nil }
        let origin = message.frameInfo.securityOrigin
        guard originMatches(scheme: origin.protocol, host: origin.host, port: origin.port, endpoint: endpoint) else { return nil }
        return parse(message.body)
    }
}

/// Breaks the WKUserContentController → handler retain cycle.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
