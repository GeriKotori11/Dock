import CryptoKit
import Foundation
import Security

/// The host's self-signed certificate is pinned by the SHA-256 of its DER (trust on first use).
/// Every trust decision uses the certificate presented in the TLS handshake, never `/health`.
enum CertificatePin {
    /// Lowercase hex SHA-256 of a certificate's DER, without separators.
    static func fingerprint(der: Data) -> String {
        SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }

    /// The leaf (first) certificate of the handshake's chain.
    static func leafFingerprint(_ trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        return fingerprint(der: SecCertificateCopyData(leaf) as Data)
    }

    static func isValid(_ fingerprint: String) -> Bool {
        fingerprint.count == 64 && fingerprint.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    /// The human-comparable code: the first 6 bytes as uppercase hex, `XXXX-XXXX-XXXX`.
    static func securityCode(_ fingerprint: String) -> String? {
        guard isValid(fingerprint) else { return nil }
        let head = Array(fingerprint.prefix(12).uppercased())
        return [head[0..<4], head[4..<8], head[8..<12]].map { String($0) }.joined(separator: "-")
    }
}

enum PinDecision: Equatable {
    case trust, confirm, mismatch

    static func decide(pinned: String?, presented: String) -> PinDecision {
        guard let pinned else { return .confirm }
        return pinned == presented ? .trust : .mismatch
    }
}

/// One pinned fingerprint per host, keyed by the host's stable UUID.
struct PinStore {
    static let keyPrefix = "windock.pin."
    let defaults: UserDefaults

    static func isValidHostId(_ hostId: String?) -> Bool {
        guard let hostId, hostId.count == 36, let uuid = UUID(uuidString: hostId) else { return false }
        return uuid.uuidString.lowercased() == hostId.lowercased()
    }

    private func key(_ hostId: String) -> String? {
        Self.isValidHostId(hostId) ? Self.keyPrefix + hostId.lowercased() : nil
    }

    func pin(for hostId: String) -> String? {
        guard let key = key(hostId), let value = defaults.string(forKey: key), CertificatePin.isValid(value) else { return nil }
        return value
    }

    @discardableResult
    func setPin(_ fingerprint: String, for hostId: String) -> Bool {
        guard let key = key(hostId), CertificatePin.isValid(fingerprint) else { return false }
        defaults.set(fingerprint, forKey: key)
        return true
    }

    func removePin(for hostId: String) {
        guard let key = key(hostId) else { return }
        defaults.removeObject(forKey: key)
    }
}
