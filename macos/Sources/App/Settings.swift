// User defaults for dev.gerikotori.windock.menu. All optional:
//
//   port             Int     host port (default 8620)
//   repoPath         String  checkout that holds server.js (default: Info.plist WDRepoPath,
//                            the folder the app was built from)
//   nodePath         String  Node binary to use before searching
//   hostEnvironment  Dict    extra WINDOCK_* variables for a spawned host, for tests,
//                            e.g. WINDOCK_CONFIG=/tmp/x/config.json to use a temporary data dir
//
//   defaults write dev.gerikotori.windock.menu port -int 18780
import Foundation

struct AppSettings {
    static let defaultPort = 8620

    var port: Int
    var repoPath: String
    var nodePathOverride: String?
    var hostEnvironment: [String: String]

    /// Keys the app sets itself: never taken from `hostEnvironment`.
    static let reservedKeys: Set<String> = ["WINDOCK_SHELL", "WINDOCK_HIDE_PIN", "PORT"]

    static func load(defaults: UserDefaults = .standard, bundle: Bundle = .main) -> AppSettings {
        let rawPort = defaults.integer(forKey: "port")
        let port = HostHealth.isValidPort(rawPort) ? rawPort : defaultPort

        var repo = (defaults.string(forKey: "repoPath")).flatMap { $0.isEmpty ? nil : $0 }
            ?? (bundle.object(forInfoDictionaryKey: "WDRepoPath") as? String) ?? ""
        if repo.hasPrefix("~") { repo = (repo as NSString).expandingTildeInPath }
        repo = (repo as NSString).standardizingPath

        let node = defaults.string(forKey: "nodePath").flatMap { $0.isEmpty ? nil : ($0 as NSString).expandingTildeInPath }

        var env: [String: String] = [:]
        if let dict = defaults.dictionary(forKey: "hostEnvironment") {
            for (key, value) in dict {
                guard key.hasPrefix("WINDOCK_"), !reservedKeys.contains(key),
                      key.range(of: "^[A-Z0-9_]+$", options: .regularExpression) != nil,
                      let text = value as? String else { continue }
                env[key] = text
            }
        }
        return AppSettings(port: port, repoPath: repo, nodePathOverride: node, hostEnvironment: env)
    }

    var serverPath: String { (repoPath as NSString).appendingPathComponent("server.js") }

    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }
}
