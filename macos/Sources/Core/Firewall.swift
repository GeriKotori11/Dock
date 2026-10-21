// Application Firewall check (HOST-CONTROL-PAGE.md 13.6). The three
// socketfilterfw "get" operations run without admin rights (checked on macOS 27).
import Foundation

enum FirewallState: String {
    case ok
    case blocked
    case unknown
}

enum Firewall {
    static let tool = "/usr/libexec/ApplicationFirewall/socketfilterfw"

    /// Combines the outputs of `--getglobalstate`, `--getblockall` and
    /// `--getappblocked <node>`. Firewall off → ok. Firewall on and blocking
    /// everything, or blocking node → blocked. Anything unreadable → unknown.
    static func evaluate(globalState: String?, blockAll: String?, appBlocked: String?) -> FirewallState {
        guard let global = globalState?.lowercased() else { return .unknown }
        if global.contains("state = 0") || global.contains("is disabled") { return .ok }
        // "State = 2" is "Block all incoming connections".
        if global.contains("state = 2") { return .blocked }
        guard global.contains("state = 1") || global.contains("is enabled") else { return .unknown }
        if let all = blockAll?.lowercased() {
            if all.contains("set to enabled") || (all.contains("block all") && all.contains("enabled") && !all.contains("disabled")) {
                return .blocked
            }
        }
        guard let app = appBlocked?.lowercased() else { return .unknown }
        if app.contains("is blocked") { return .blocked }
        if app.contains("is permitted") { return .ok }
        return .unknown
    }

    /// Runs the check for one node binary (resolved through symlinks, since the
    /// firewall lists the real file). Blocking: call off the main thread.
    static func check(nodePath: String?) -> FirewallState {
        func get(_ args: [String]) -> String? {
            guard let out = ProcessRunner.run(tool, args, timeout: 5), out.status == 0 else { return nil }
            return out.stdout
        }
        let global = get(["--getglobalstate"])
        let all = get(["--getblockall"])
        var app: String?
        if let nodePath {
            let real = URL(fileURLWithPath: nodePath).resolvingSymlinksInPath().path
            app = get(["--getappblocked", real])
        }
        return evaluate(globalState: global, blockAll: all, appBlocked: app)
    }
}
