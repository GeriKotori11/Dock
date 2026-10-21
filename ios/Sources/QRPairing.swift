import Foundation

/// A parsed `windock://pair?...` link (docs/design/HOST-CONTROL-PAGE.md, section 9.1).
/// It carries a one-time PIN: never log it, persist it or put it in a crash message.
struct PairingLink: Equatable {
    /// Canonical lowercase host UUID.
    let hostId: String
    /// `https://{ip}:{port}` built from `addr`.
    let endpoint: URL
    /// `addr` exactly as validated, `{ip}:{port}`.
    let address: String
    /// Lowercase hex SHA-256 of the host's leaf certificate (64 characters).
    let fingerprint: String
    let pin: String
    /// Display only: percent-decoded, control characters removed. May be empty.
    let name: String

    var host: String { endpoint.host ?? "" }
    var securityCode: String { CertificatePin.securityCode(fingerprint) ?? "" }
    var displayName: String { Computer.displayName(nickname: nil, hostName: name) }
}

/// What a `windock:` URL asks the app to do.
enum PairingLinkRoute: Equatable {
    case pair(PairingLink)
    /// Not a WinDock pairing code (wrong host, missing or malformed field, duplicate key).
    case invalid
    /// `v` is newer than this app understands.
    case newer
    /// Not a `windock:` URL at all; ignored.
    case notALink
}

/// Strict parser for the QR payload. Fields in any order, unknown keys ignored, duplicate
/// known keys rejected, every security-relevant field validated before anything else happens.
enum PairingLinkParser {
    static let scheme = "windock"
    static let knownKeys: Set<String> = ["v", "id", "addr", "fp", "pin", "name"]
    static let supportedVersion = 1

    static func route(_ url: URL) -> PairingLinkRoute {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == scheme else { return .notALink }
        guard parts.host?.lowercased() == "pair", parts.user == nil, parts.password == nil, parts.port == nil,
              parts.path.isEmpty || parts.path == "/", parts.fragment == nil,
              let query = parts.percentEncodedQuery, query.utf8.count <= 1024 else { return .invalid }
        var fields: [String: String] = [:]
        for segment in query.split(separator: "&", omittingEmptySubsequences: true) {
            let pair = segment.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let key = String(pair[0])
            guard knownKeys.contains(key) else { continue }
            guard fields[key] == nil else { return .invalid }
            fields[key] = pair.count > 1 ? String(pair[1]) : ""
        }
        guard let version = fields["v"], !version.isEmpty, version.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return .invalid }
        // Any all-digit version above 1 (even one too long for Int) is a newer format.
        guard version.utf8.count <= 9, let number = Int(version) else { return .newer }
        if number > supportedVersion { return .newer }
        guard number == supportedVersion, version == String(number) else { return .invalid }

        guard let idBytes = base64urlDecode(fields["id"] ?? "", byteCount: 16),
              let hostId = uuidString(idBytes), PinStore.isValidHostId(hostId),
              let (address, endpoint) = parseAddress(fields["addr"] ?? ""),
              let fpBytes = base64urlDecode(fields["fp"] ?? "", byteCount: 32),
              let pin = fields["pin"], isValidPin(pin) else { return .invalid }
        let fingerprint = fpBytes.map { String(format: "%02x", $0) }.joined()
        guard CertificatePin.isValid(fingerprint) else { return .invalid }
        var name = ""
        if let raw = fields["name"] {
            guard let decoded = raw.removingPercentEncoding else { return .invalid }
            name = String(Computer.cleanHostName(decoded).prefix(Computer.displayLimit))
        }
        return .pair(PairingLink(hostId: hostId, endpoint: endpoint, address: address,
                                 fingerprint: fingerprint, pin: pin, name: name))
    }

    static func route(_ text: String) -> PairingLinkRoute {
        guard let url = URL(string: text) else {
            return text.lowercased().hasPrefix(scheme + ":") ? .invalid : .notALink
        }
        return route(url)
    }

    /// Six ASCII digits, nothing else (`^\d{6}$` without Unicode digits).
    static func isValidPin(_ pin: String) -> Bool {
        pin.utf8.count == 6 && pin.utf8.allSatisfy { $0 >= 48 && $0 <= 57 }
    }

    /// `{private dotted IPv4}:{port 1–65535}`, the same host rule as Add by address
    /// (`EndpointPolicy`), but never a host name and always with an explicit port.
    static func parseAddress(_ raw: String) -> (String, URL)? {
        let parts = raw.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let host = String(parts[0]), portText = String(parts[1])
        guard host != "localhost", host.split(separator: ".", omittingEmptySubsequences: false).count == 4,
              EndpointPolicy.isPrivateHost(host),
              (1...5).contains(portText.utf8.count), portText.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              let port = Int(portText), (1...65535).contains(port), String(port) == portText,
              let endpoint = EndpointPolicy.normalize("https://\(host):\(port)") else { return nil }
        return ("\(host):\(port)", endpoint)
    }

    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
    private static let lookup: [UInt8: UInt32] = {
        var table: [UInt8: UInt32] = [:]
        for (index, character) in alphabet.enumerated() { table[character] = UInt32(index) }
        return table
    }()

    /// Unpadded base64url of exactly `byteCount` bytes. Rejects padding, the standard alphabet's
    /// `+` and `/`, wrong lengths and non-zero trailing bits (so every value has one spelling).
    static func base64urlDecode(_ text: String, byteCount: Int) -> Data? {
        let characters = Array(text.utf8)
        guard characters.count == (byteCount * 8 + 5) / 6 else { return nil }
        var buffer: UInt32 = 0
        var bits = 0
        var output = Data(capacity: byteCount)
        for character in characters {
            guard let value = lookup[character] else { return nil }
            buffer = (buffer << 6) | value
            bits += 6
            if bits >= 8 {
                bits -= 8
                output.append(UInt8((buffer >> UInt32(bits)) & 0xff))
            }
            buffer &= (1 << UInt32(bits)) - 1
        }
        guard buffer == 0, output.count == byteCount else { return nil }
        return output
    }

    static func uuidString(_ bytes: Data) -> String? {
        guard bytes.count == 16 else { return nil }
        let uuid = bytes.withUnsafeBytes { NSUUID(uuidBytes: $0.bindMemory(to: UInt8.self).baseAddress) as UUID }
        return uuid.uuidString.lowercased()
    }
}

/// Pure decisions for QR pairing. Trust comes from the certificate the TLS handshake presents
/// and the saved pin; `/health` only identifies the host once that certificate matched.
enum QRPairingRules {
    enum Plan: Equatable {
        /// Q5 "Pair with {name}?" (`again`: "Pair {name} again?", a revoked or pin-less pairing).
        case confirm(again: Bool)
        /// Already paired with this certificate and a session: Pair opens the dock without the PIN.
        case openPaired
        /// Known host ID, different certificate: Q11, never a silent re-pin.
        case securityChanged(saved: String, scanned: String)
    }

    /// Decided locally before any network traffic.
    static func plan(link: PairingLink, saved: Computer?, pinned: String?, sessionValid: Bool) -> Plan {
        guard let saved, saved.hostId == link.hostId else { return .confirm(again: false) }
        guard let pinned else { return .confirm(again: true) }
        guard CertificatePin.matches(pinned, link.fingerprint) else {
            return .securityChanged(saved: pinned, scanned: link.fingerprint)
        }
        return sessionValid ? .openPaired : .confirm(again: true)
    }

    enum Verdict: Equatable {
        /// The scanned certificate answered as the scanned host.
        case verified(pairingOpen: Bool)
        /// A different certificate answered at this address (never trusted, even if `/health` agrees).
        case otherCertificate
        /// The scanned certificate answered, but `/health` names another host ID.
        case otherHost
        case noAnswer(ProbeFailure)
    }

    static func verdict(link: PairingLink, result: ProbeResult) -> Verdict {
        if let presented = result.presentedFingerprint, !CertificatePin.matches(presented, link.fingerprint) {
            return .otherCertificate
        }
        guard let info = result.info else { return .noAnswer(result.failure ?? .other) }
        guard result.endpoint?.scheme == "https", let presented = result.presentedFingerprint,
              CertificatePin.matches(presented, link.fingerprint) else { return .noAnswer(.tls) }
        guard info.hostId?.lowercased() == link.hostId else { return .otherHost }
        return .verified(pairingOpen: info.pairingOpen ?? true)
    }
}

/// The network half of "Pair" (section 10.6): find the host by its certificate, then send the
/// PIN over a connection pinned to the scanned fingerprint. Nothing is stored here.
final class QRPairingSession {
    struct Found: Equatable {
        let endpoint: URL
        let info: HealthInfo
    }

    enum Located: Equatable {
        case found(Found)
        case notFound(otherDevice: Bool, failure: ProbeFailure?)
    }

    let link: PairingLink
    private weak var coordinator: ConnectionCoordinator?
    private var probes: [ObjectIdentifier: HealthProbe] = [:]
    private var client: PinnedClient?
    private var generation = 0
    private(set) var sawOtherDevice = false

    init(link: PairingLink, coordinator: ConnectionCoordinator) {
        self.link = link
        self.coordinator = coordinator
    }

    deinit { cancel() }

    /// Stops every probe and request; late answers are dropped.
    func cancel() {
        generation += 1
        probes.values.forEach { $0.cancel() }
        probes = [:]
        client?.cancel()
        client = nil
    }

    /// The handshake must present the scanned fingerprint before `/health` is even requested.
    private func probe(_ endpoint: URL, timeout: TimeInterval, completion: @escaping (ProbeResult) -> Void) {
        let probe = HealthProbe()
        let id = ObjectIdentifier(probe)
        probes[id] = probe
        probe.start(endpoint: endpoint, pinned: link.fingerprint, timeout: timeout) { [weak self] result in
            self?.probes[id] = nil
            completion(result)
        }
    }

    /// Step 1: `addr` (4 s). Step 2, if nothing or another certificate answered there: Bonjour
    /// results for up to `discoveryWait` seconds, each accepted only after its own pinned probe.
    func locate(discoveryWait: TimeInterval, completion: @escaping (Located) -> Void) {
        let token = generation
        probe(link.endpoint, timeout: 4) { [weak self] result in
            guard let self, self.generation == token else { return }
            switch QRPairingRules.verdict(link: self.link, result: result) {
            case .verified:
                completion(.found(Found(endpoint: result.endpoint ?? self.link.endpoint, info: result.info!)))
            case .otherCertificate, .otherHost:
                self.sawOtherDevice = true
                self.searchByIdentity(token: token, wait: discoveryWait, failure: nil, completion: completion)
            case .noAnswer(let failure):
                self.searchByIdentity(token: token, wait: discoveryWait, failure: failure, completion: completion)
            }
        }
    }

    private func searchByIdentity(token: Int, wait: TimeInterval, failure: ProbeFailure?,
                                  completion: @escaping (Located) -> Void) {
        coordinator?.startDiscovery()
        let deadline = Date().addingTimeInterval(wait)
        var tried: Set<URL> = [link.endpoint]
        func check() {
            guard generation == token else { return }
            if let host = coordinator?.verified[link.hostId], host.goneSince == nil, host.endpoint.scheme == "https",
               CertificatePin.matches(host.presented, link.fingerprint), !tried.contains(host.endpoint) {
                tried.insert(host.endpoint)
                probe(host.endpoint, timeout: 4) { [weak self] result in
                    guard let self, self.generation == token else { return }
                    if case .verified = QRPairingRules.verdict(link: self.link, result: result), let info = result.info {
                        completion(.found(Found(endpoint: result.endpoint ?? host.endpoint, info: info)))
                    } else {
                        check()
                    }
                }
                return
            }
            guard Date() < deadline else {
                completion(.notFound(otherDevice: sawOtherDevice, failure: failure))
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { check() }
        }
        check()
    }

    /// `/health.pairingOpen` over the pinned identity (nil: no trusted answer).
    func pollPairingOpen(at endpoint: URL, completion: @escaping (Bool?) -> Void) {
        let token = generation
        probe(endpoint, timeout: 2.5) { [weak self] result in
            guard let self, self.generation == token else { return }
            if case .verified(let open) = QRPairingRules.verdict(link: self.link, result: result) {
                completion(open)
            } else {
                completion(nil)
            }
        }
    }

    /// Step 3: `POST /api/auth {pin, deviceName}`; `PinnedClient` refuses any other certificate.
    func authenticate(at endpoint: URL, deviceName: String, completion: @escaping (AuthOutcome) -> Void) {
        let token = generation
        client?.cancel()
        let client = PinnedClient(endpoint: endpoint, fingerprint: link.fingerprint)
        self.client = client
        PairingAPI.authenticate(client: client, pin: link.pin, deviceName: deviceName) { [weak self] outcome in
            guard let self, self.generation == token else { return }
            self.client = nil
            completion(outcome)
        }
    }
}
