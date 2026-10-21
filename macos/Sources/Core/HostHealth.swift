// Attach-or-spawn decision (HOST-CONTROL-PAGE.md 5.8, decision D7): before
// spawning, the app asks GET /health on its port. A WinDock host that already
// answers (Terminal `npm start`, the LaunchAgent) is attached to, not replaced.
import Foundation

enum HealthVerdict: Equatable {
    /// A WinDock host answered: `{ ok: true, app: "windock" }`.
    case windock
    /// Something answered, but not WinDock.
    case other
    /// Nothing answered.
    case none
}

enum StartDecision: Equatable {
    case attach
    case spawn
    /// Something else answers on 127.0.0.1:{port}: don't spawn.
    case portInUse
}

enum HostHealth {
    /// The phone apps reject /health bodies over 4096 bytes; so does this.
    static let maxBodyBytes = 4096

    static func verdict(statusCode: Int?, body: Data?) -> HealthVerdict {
        guard let statusCode else { return .none }
        guard statusCode == 200, let body, body.count <= maxBodyBytes,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return .other }
        let ok = (object["ok"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
        return ok && (object["app"] as? String) == "windock" ? .windock : .other
    }

    static func decide(_ verdict: HealthVerdict) -> StartDecision {
        switch verdict {
        case .windock: return .attach
        case .other: return .portInUse
        case .none: return .spawn
        }
    }

    static func healthURL(port: Int) -> URL { URL(string: "http://127.0.0.1:\(port)/health")! }
    static func statusURL(port: Int) -> URL { URL(string: "http://127.0.0.1:\(port)/api/host/status")! }
    static func pageURL(port: Int) -> URL { URL(string: "http://127.0.0.1:\(port)/host")! }

    static func isValidPort(_ port: Int) -> Bool { (1...65535).contains(port) }
}

/// The parts of /api/host/status the native menu uses (13.2).
struct HostStatusSummary: Equatable {
    var address: String?
    var firewall: String?

    static func parse(_ data: Data) -> HostStatusSummary? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (object["app"] as? String) == "windock" else { return nil }
        let network = object["network"] as? [String: Any]
        let address = (network?["address"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return HostStatusSummary(address: address, firewall: object["firewall"] as? String)
    }
}
