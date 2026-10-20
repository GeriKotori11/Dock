import Foundation

/// Pure trust decisions the coordinator acts on. Trust always comes from the certificate the TLS
/// handshake presented and the saved pin, never from `/health` or a TXT record alone.
enum ConnectionRules {
    /// What one probe of a saved computer's endpoint (or of an address where it might be) means.
    enum Answer: Equatable {
        /// The pinned certificate answered as this host: open its dock here.
        case accept(fingerprint: String?)
        /// This host ID answered with a different certificate (security code changed, S10).
        case mismatch(presented: String)
        /// This host ID answered, but this phone holds no pin for it yet: pair (step 1).
        case needsPairing(presented: String)
        /// Another computer answers here now; the saved one is not at this address.
        case otherComputer(hostId: String?)
        /// Nothing (or nothing WinDock) answered.
        case noAnswer(ProbeFailure)
    }

    static func evaluate(_ computer: Computer, pinned: String?, result: ProbeResult) -> Answer {
        guard let info = result.info else { return .noAnswer(result.failure ?? .other) }
        let claimed = info.hostId?.lowercased()
        let isHttps = result.endpoint?.scheme == "https" || result.presentedFingerprint != nil
        if computer.isLegacy {
            // A very old host has neither an ID nor TLS; it is recognised by its address only.
            guard claimed == nil, !isHttps, info.tlsFingerprint == nil, pinned == nil else {
                return .otherComputer(hostId: claimed)
            }
            return .accept(fingerprint: nil)
        }
        guard claimed == computer.hostId.lowercased() else { return .otherComputer(hostId: claimed) }
        if isHttps {
            guard let presented = result.presentedFingerprint else { return .noAnswer(.tls) }
            switch PinDecision.decide(pinned: pinned, presented: presented) {
            case .trust: return .accept(fingerprint: presented)
            case .mismatch: return .mismatch(presented: presented)
            case .confirm: return .needsPairing(presented: presented)
            }
        }
        // Plain http: only for a host that has never offered TLS and was never pinned.
        guard pinned == nil, info.tlsFingerprint == nil else { return .noAnswer(.tls) }
        return .accept(fingerprint: nil)
    }

    /// A host that answered at an address the person typed, or that discovery found.
    enum Arrival: Equatable {
        /// Already paired and the pin matches: open it (and update its endpoint).
        case openPaired(hostId: String, endpoint: URL, fingerprint: String?)
        /// Already paired, but the certificate differs: S10, never pairing.
        case mismatch(hostId: String, presented: String)
        /// Paired earlier but the phone has no pin (forgot and paired again, not finished): pairing.
        case repair(hostId: String)
        /// A new computer: pairing step 1 (or step 2 only over plain http).
        case pairNew
    }

    static func arrival(store: ComputerStore, pins: PinStore, result: ProbeResult) -> Arrival? {
        guard let info = result.info, let endpoint = result.endpoint else { return nil }
        guard let hostId = info.hostId?.lowercased(), PinStore.isValidHostId(hostId),
              let saved = store.computer(hostId) else { return .pairNew }
        let pinned = pins.pin(for: hostId)
        switch evaluate(saved, pinned: pinned, result: result) {
        case .accept(let fingerprint): return .openPaired(hostId: hostId, endpoint: endpoint, fingerprint: fingerprint)
        case .mismatch(let presented): return .mismatch(hostId: hostId, presented: presented)
        case .needsPairing: return .repair(hostId: hostId)
        case .otherComputer, .noAnswer: return nil
        }
    }

    /// Whether a computer found by identity at `candidate` means it moved (S1 "Found it at a new address").
    static func moved(_ computer: Computer, to candidate: URL) -> Bool {
        candidate.host?.lowercased() != computer.endpoint.host?.lowercased() ||
            EndpointPolicy.effectivePort(candidate) != EndpointPolicy.effectivePort(computer.endpoint)
    }

    // MARK: Can't reach (S8)

    enum Check: Equatable { case differentNetwork(phoneIp: String, hostIp: String), notRunning, isolation, macFirewall }

    struct CheckList: Equatable {
        let checks: [Check]
        /// Index of the "Likely" check (always the first one when present).
        let likely: Int?
    }

    /// Orders the checks by what the phone could detect (section 4.10 / 5.8). Hints, never gates.
    static func checks(phone: NetworkStatus.Interface?, hostIp: String?, platform: String,
                       lastFailure: ProbeFailure?, discoverySawAny: Bool) -> CheckList {
        var subnetMismatch: Check?
        if let phone, let hostIp, NetworkStatus.sameSubnet(phone, hostIp) == false {
            subnetMismatch = .differentNetwork(phoneIp: phone.address, hostIp: hostIp)
        }
        var ordered: [Check] = []
        var likely: Int?
        if let subnetMismatch {
            ordered = [subnetMismatch, .notRunning, .isolation]
            likely = 0
        } else if lastFailure == .refused {
            ordered = [.notRunning, .isolation]
            likely = 0
        } else if lastFailure == .timeout, !discoverySawAny {
            ordered = [.isolation, .notRunning]
            likely = 0
        } else {
            ordered = [.notRunning, .isolation]
        }
        if platform == "macos", ordered.count < 3 { ordered.append(.macFirewall) }
        return CheckList(checks: Array(ordered.prefix(3)), likely: likely)
    }

    /// Backoff for the direct probe while "Can't reach" is open: 3, 5, 10, then 15 s.
    static func retryDelay(attempt: Int) -> TimeInterval {
        [3, 5, 10, 15][min(max(attempt, 0), 3)]
    }
}
