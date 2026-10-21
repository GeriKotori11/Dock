import Foundation

/// A paired computer (spec section 12, shared model). No secrets: the pin stays in `PinStore`
/// and the session cookie in the WebView cookie store.
struct Computer: Codable, Equatable {
    var hostId: String
    var hostName: String
    var nickname: String?
    var platform: String
    /// The last endpoint that passed the pin (https), or plain http for hosts without TLS.
    var endpoint: URL
    var lastConnectedAt: Date?
    var addedAt: Date
    /// A very old host whose `/health` has no `hostId`; the key was generated on this phone.
    var localId: Bool?
    /// The host reported `/health.hostUi` on the last verified contact (picks instructions only).
    var hostUi: Bool? = nil

    static let nicknameLimit = 40
    static let displayLimit = 60

    var displayName: String { Self.displayName(nickname: nickname, hostName: hostName) }
    var isLegacy: Bool { localId == true }
    /// The host part of the endpoint (an IPv4 address), shown small and muted in rows.
    var address: String { endpoint.host ?? "" }

    /// nickname ?? host name without a trailing `.local`, at most 60 characters.
    static func displayName(nickname: String?, hostName: String) -> String {
        if let nickname = sanitizeNickname(nickname) { return String(nickname.prefix(displayLimit)) }
        let name = cleanHostName(hostName)
        let shown = name.isEmpty ? "your computer" : name
        return String(shown.prefix(displayLimit))
    }

    static func cleanHostName(_ hostName: String) -> String {
        var name = String(hostName.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while name.hasSuffix(".") { name.removeLast() }
        if name.lowercased().hasSuffix(".local") { name = String(name.dropLast(6)) }
        return name
    }

    /// Trimmed, control characters removed, at most 40 characters; empty means "no nickname".
    static func sanitizeNickname(_ input: String?) -> String? {
        guard let input else { return nil }
        let cleaned = String(input.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        return String(cleaned.prefix(nicknameLimit))
    }

    /// The platform word used in rows and instructions.
    static func platformWord(_ platform: String) -> String? {
        switch platform.lowercased() {
        case "windows": return "Windows"
        case "macos", "darwin": return "macOS"
        case "linux": return "Linux"
        default: return nil
        }
    }

    static func normalizedPlatform(_ platform: String?) -> String {
        switch platform?.lowercased() {
        case "windows", "win32": return "windows"
        case "macos", "darwin", "mac": return "macos"
        case "linux": return "linux"
        default: return ""
        }
    }
}

/// Paired computers as JSON in UserDefaults, keyed by lowercase host ID.
final class ComputerStore {
    static let key = "windock.computers.v1"
    /// The single remembered address of the earlier one-computer app.
    static let legacyAddressKey = "windock.pcAddress"
    static let primedKey = "windock.localNetworkPrimed"

    let defaults: UserDefaults
    private(set) var computers: [Computer] = []

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        load()
    }

    private func load() {
        guard let data = defaults.data(forKey: Self.key),
              let decoded = try? JSONDecoder.windock.decode([Computer].self, from: data) else { computers = []; return }
        var seen = Set<String>()
        computers = decoded.compactMap { computer in
            var computer = computer
            computer.hostId = computer.hostId.lowercased()
            guard PinStore.isValidHostId(computer.hostId), !seen.contains(computer.hostId),
                  EndpointPolicy.normalize(computer.endpoint.absoluteString) != nil else { return nil }
            seen.insert(computer.hostId)
            return computer
        }
    }

    private func save() {
        guard let data = try? JSONEncoder.windock.encode(computers) else { return }
        defaults.set(data, forKey: Self.key)
    }

    var isEmpty: Bool { computers.isEmpty }

    func computer(_ hostId: String?) -> Computer? {
        guard let hostId = hostId?.lowercased() else { return nil }
        return computers.first { $0.hostId == hostId }
    }

    func upsert(_ computer: Computer) {
        var computer = computer
        computer.hostId = computer.hostId.lowercased()
        guard PinStore.isValidHostId(computer.hostId) else { return }
        if let index = computers.firstIndex(where: { $0.hostId == computer.hostId }) {
            computers[index] = computer
        } else {
            computers.append(computer)
        }
        save()
    }

    func update(_ hostId: String, _ change: (inout Computer) -> Void) {
        guard let index = computers.firstIndex(where: { $0.hostId == hostId.lowercased() }) else { return }
        change(&computers[index])
        save()
    }

    func remove(_ hostId: String) {
        computers.removeAll { $0.hostId == hostId.lowercased() }
        save()
    }

    /// Paired computers, latest `lastConnectedAt` first (never-connected ones by `addedAt`).
    var byLastConnected: [Computer] {
        computers.sorted { ($0.lastConnectedAt ?? .distantPast, $0.addedAt) > ($1.lastConnectedAt ?? .distantPast, $1.addedAt) }
    }

    /// The computer launch opens: the latest `lastConnectedAt`.
    var last: Computer? { byLastConnected.first }

    var localNetworkPrimed: Bool {
        get { defaults.bool(forKey: Self.primedKey) }
        set { defaults.set(newValue, forKey: Self.primedKey) }
    }

    // MARK: Migration from the single remembered address

    enum Migration: Equatable {
        case none
        /// Built from local data alone: the remembered https address and the only stored pin.
        case immediate(Computer)
        /// Needs one `/health` probe of the remembered address to learn the host ID.
        case probe(URL)
    }

    func migrationPlan(pins: PinStore, now: Date = Date()) -> Migration {
        guard computers.isEmpty, let remembered = defaults.string(forKey: Self.legacyAddressKey) else { return .none }
        guard let endpoint = EndpointPolicy.normalize(remembered) else {
            defaults.removeObject(forKey: Self.legacyAddressKey)
            return .none
        }
        let pinned = defaults.dictionaryRepresentation().keys
            .filter { $0.hasPrefix(PinStore.keyPrefix) }
            .map { String($0.dropFirst(PinStore.keyPrefix.count)) }
            .filter { pins.pin(for: $0) != nil }
        if endpoint.scheme == "https", pinned.count == 1, let hostId = pinned.first {
            return .immediate(Computer(hostId: hostId.lowercased(), hostName: "", nickname: nil, platform: "",
                                       endpoint: endpoint, lastConnectedAt: now, addedAt: now, localId: nil))
        }
        return .probe(endpoint)
    }

    /// Records a migrated computer and retires the single remembered address.
    func completeMigration(with computer: Computer?) {
        if let computer { upsert(computer) }
        defaults.removeObject(forKey: Self.legacyAddressKey)
    }
}

extension JSONEncoder {
    static var windock: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return encoder
    }
}

extension JSONDecoder {
    static var windock: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }
}
