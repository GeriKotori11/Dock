import XCTest
@testable import WinDock

/// The `windock://pair` parser (HOST-CONTROL-PAGE section 9.1) and the pure QR pairing decisions.
final class QRPairingTests: XCTestCase {
    // Section 9.7 samples.
    private let sample1 = "windock://pair?v=1&id=Ww6POixBTX6aFnPCvk2R8A&addr=192.168.1.34:8620&fp=biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9qE&pin=482913&name=Geris-MacBook-Air"
    private let sample2 = "windock://pair?v=1&id=0FvYxz2KR1yUq3nE8iWbPg&addr=192.168.1.20:8620&fp=o_BcHojSSRew5sNa8o0ed0C5xqXSH4Pgm0xX1qIefAk&pin=315780&name=DESKTOP-7H2KQ9L"
    private let host1 = "5b0e8f3a-2c41-4d7e-9a16-73c2be4d91f0"
    private let fp1 = "6e21b4f093ad5f0c7a12e9d4b386f1a0c25e7d9b4f63018a2ce57b94d3e0f6a1"
    private let fields: [(String, String)] = [
        ("v", "1"), ("id", "Ww6POixBTX6aFnPCvk2R8A"), ("addr", "192.168.1.34:8620"),
        ("fp", "biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9qE"), ("pin", "482913"), ("name", "Geris-MacBook-Air")
    ]

    private func route(_ text: String) -> PairingLinkRoute { PairingLinkParser.route(text) }

    private func link(_ text: String, file: StaticString = #filePath, line: UInt = #line) throws -> PairingLink {
        guard case .pair(let link) = route(text) else {
            XCTFail("Expected a valid link", file: file, line: line)
            throw NSError(domain: "QRPairingTests", code: 1)
        }
        return link
    }

    /// The sample with one field replaced (or removed when `value` is nil).
    private func variant(_ key: String, _ value: String?) -> String {
        "windock://pair?" + fields.compactMap { field in
            guard field.0 == key else { return "\(field.0)=\(field.1)" }
            return value.map { "\(key)=\($0)" }
        }.joined(separator: "&")
    }

    // MARK: Valid

    func testSectionNineSevenSamplesParse() throws {
        let first = try link(sample1)
        XCTAssertEqual(first.hostId, host1)
        XCTAssertEqual(first.address, "192.168.1.34:8620")
        XCTAssertEqual(first.endpoint, URL(string: "https://192.168.1.34:8620"))
        XCTAssertEqual(first.fingerprint, fp1)
        XCTAssertEqual(first.securityCode, "6E21-B4F0-93AD", "Matches the code shown on the computer")
        XCTAssertEqual(first.pin, "482913")
        XCTAssertEqual(first.name, "Geris-MacBook-Air")

        let second = try link(sample2)
        XCTAssertEqual(second.hostId, "d05bd8c7-3d8a-475c-94ab-79c4f2259b3e")
        XCTAssertEqual(second.fingerprint, "a3f05c1e88d24917b0e6c35af28d1e7740b9c6a5d21f83e09b4c57d6a21e7c09")
        XCTAssertEqual(second.securityCode, "A3F0-5C1E-88D2")
        XCTAssertEqual(second.endpoint, URL(string: "https://192.168.1.20:8620"))
        XCTAssertEqual(second.displayName, "DESKTOP-7H2KQ9L")
    }

    func testFieldsInAnyOrderAndUnknownKeysIgnored() throws {
        let reversed = "windock://pair?" + fields.reversed().map { "\($0.0)=\($0.1)" }.joined(separator: "&")
        XCTAssertEqual(try link(reversed), try link(sample1))
        let extra = sample1 + "&future=abc&x&V=9&PIN=000000"
        XCTAssertEqual(try link(extra), try link(sample1), "Unknown keys (keys are case-sensitive) are ignored")
        XCTAssertEqual(try link(sample1.replacingOccurrences(of: "WINDOCK", with: "windock").replacingOccurrences(of: "windock://pair", with: "WinDock://PAIR")),
                       try link(sample1), "Scheme and host are case-insensitive")
    }

    func testNameIsPercentDecodedCleanedAndOptional() throws {
        let encoded = try link(variant("name", "Geri%E2%80%99s%20Mac%0A%07.local"))
        XCTAssertEqual(encoded.name, "Geri\u{2019}s Mac", "Percent-decoded, control characters and .local removed")
        let missing = try link(variant("name", nil))
        XCTAssertEqual(missing.name, "")
        XCTAssertEqual(missing.displayName, "your computer")
        XCTAssertEqual(route(variant("name", "%E2%80")), .invalid, "Malformed percent-encoding")
        let long = try link(variant("name", String(repeating: "a", count: 200)))
        XCTAssertEqual(long.name.count, Computer.displayLimit)
    }

    func testLoopbackAndEveryPrivateRangeAreAllowed() throws {
        for address in ["10.0.0.5:8620", "172.16.0.1:1", "172.31.255.254:65535", "192.168.0.1:443", "127.0.0.1:18622"] {
            XCTAssertEqual(try link(variant("addr", address)).address, address)
        }
    }

    // MARK: Version

    func testNewerVersionAsksForAnUpdate() {
        XCTAssertEqual(route(variant("v", "2")), .newer)
        XCTAssertEqual(route(variant("v", "17")), .newer)
        XCTAssertEqual(route(variant("v", "99999999999999999999")), .newer)
        // A newer format may change other fields: still "newer", not "invalid".
        XCTAssertEqual(route("windock://pair?v=2&something=else"), .newer)
    }

    func testBadVersionIsInvalid() {
        for value in ["0", "", "1.0", "01", "-1", "one", "%31"] {
            XCTAssertEqual(route(variant("v", value)), .invalid, "v=\(value)")
        }
        XCTAssertEqual(route(variant("v", nil)), .invalid, "v is required")
    }

    // MARK: Invalid fields

    func testEachRequiredFieldIsRequired() {
        for key in ["id", "addr", "fp", "pin"] {
            XCTAssertEqual(route(variant(key, nil)), .invalid, "missing \(key)")
            XCTAssertEqual(route(variant(key, "")), .invalid, "empty \(key)")
        }
    }

    func testDuplicateKnownKeysAreRejected() {
        for (key, value) in fields {
            XCTAssertEqual(route(sample1 + "&\(key)=\(value)"), .invalid, "duplicate \(key), same value")
        }
        XCTAssertEqual(route(sample1 + "&pin=000000"), .invalid)
        XCTAssertEqual(route(sample1 + "&addr=10.0.0.1:8620"), .invalid)
        XCTAssertEqual(route(sample1 + "&v=2"), .invalid, "A duplicate v is rejected before the version check")
    }

    func testBadHostIdIsRejected() {
        for value in [
            "Ww6POixBTX6aFnPCvk2R8",        // 21 characters
            "Ww6POixBTX6aFnPCvk2R8AA",      // 23
            "Ww6POixBTX6aFnPCvk2R8A==",     // padding
            "Ww6POixBTX6aFnPCvk2R8B",       // non-zero trailing bits
            "Ww6POixBTX6aFnPCvk2R+A",       // standard alphabet
            "Ww6POixBTX6aFnPCvk2R/A",
            "Ww6POixBTX6aFnPCvk2R%41",      // percent-encoded
            "5b0e8f3a-2c41-4d7e-9a16-73c2be4d91f0"  // a plain UUID is not the format
        ] {
            XCTAssertEqual(route(variant("id", value)), .invalid, "id=\(value)")
        }
    }

    func testBadFingerprintIsRejected() {
        for value in [
            "biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9q",     // 42
            "biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9qEA",   // 44
            "biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9qF",    // non-zero trailing bits
            "biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9q=",
            "biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9q!",
            "6e21b4f093ad5f0c7a12e9d4b386f1a0c25e7d9b4f63018a2ce57b94d3e0f6a1"  // hex is not the format
        ] {
            XCTAssertEqual(route(variant("fp", value)), .invalid, "fp=\(value)")
        }
    }

    func testBadPinIsRejected() {
        for value in ["48291", "4829130", "48291a", "48 913", "+48291", "%34%38%32%39%31%33", "٤٨٢٩١٣", "４８２９１３"] {
            XCTAssertEqual(route(variant("pin", value)), .invalid, "pin=\(value)")
        }
    }

    func testPublicAndMalformedAddressesAreRejected() {
        for value in [
            "8.8.8.8:8620", "1.1.1.1:443", "172.32.0.1:8620", "192.169.1.1:8620", "11.0.0.1:8620",  // public
            "localhost:8620", "windock.local:8620", "[::1]:8620", "fe80::1",                    // not dotted IPv4
            "192.168.1.34", "192.168.1.34:", ":8620", "192.168.1.34:0", "192.168.1.34:65536",
            "192.168.1.34:08620", "192.168.1.34:+80", "192.168.1.034:8620", "192.168.1:8620",
            "192.168.1.34:8620:1", "user@192.168.1.34:8620", "192.168.1.34:8620/path", "192.168.1.34%3A8620"
        ] {
            XCTAssertEqual(route(variant("addr", value)), .invalid, "addr=\(value)")
        }
    }

    func testOnlyThePairHostOfTheWinDockSchemeIsALink() {
        XCTAssertEqual(route("https://192.168.1.34:8620/"), .notALink)
        XCTAssertEqual(route("windockx://pair?v=1"), .notALink)
        XCTAssertEqual(route(sample1.replacingOccurrences(of: "://pair?", with: "://open?")), .invalid)
        XCTAssertEqual(route(sample1.replacingOccurrences(of: "://pair?", with: "://pair/x?")), .invalid)
        XCTAssertEqual(route(sample1.replacingOccurrences(of: "://pair?", with: "://user@pair?")), .invalid)
        XCTAssertEqual(route(sample1.replacingOccurrences(of: "://pair?", with: "://pair:1?")), .invalid)
        XCTAssertEqual(route(sample1 + "#fragment"), .invalid)
        XCTAssertEqual(route("windock://pair"), .invalid, "No fields at all")
        XCTAssertEqual(route("windock:pair?v=1"), .invalid)
    }

    func testBase64urlDecoderIsStrict() {
        XCTAssertEqual(PairingLinkParser.base64urlDecode("AAAAAAAAAAAAAAAAAAAAAA", byteCount: 16), Data(count: 16))
        XCTAssertEqual(PairingLinkParser.base64urlDecode("_____________________w", byteCount: 16), Data(repeating: 0xff, count: 16))
        XCTAssertNil(PairingLinkParser.base64urlDecode("_____________________-", byteCount: 16), "Trailing bits must be zero")
        XCTAssertNil(PairingLinkParser.base64urlDecode("AAAAAAAAAAAAAAAAAAAAAA", byteCount: 32))
        XCTAssertNil(PairingLinkParser.base64urlDecode("AAAAAAAAAAAAAAAAAAAAA.", byteCount: 16))
    }

    // MARK: Fingerprint comparison

    func testConstantTimeFingerprintComparison() {
        XCTAssertTrue(CertificatePin.matches(fp1, fp1))
        XCTAssertFalse(CertificatePin.matches(fp1, String(fp1.dropLast()) + "0"))
        XCTAssertFalse(CertificatePin.matches(fp1, String(fp1.dropLast())))
        XCTAssertFalse(CertificatePin.matches(fp1, nil))
        XCTAssertFalse(CertificatePin.matches(nil, nil))
        XCTAssertFalse(CertificatePin.matches("", ""))
    }

    // MARK: Plan (decided before any network traffic)

    private func scanned() throws -> PairingLink { try link(sample1) }

    private func saved(_ hostId: String) -> Computer {
        Computer(hostId: hostId, hostName: "Geris-MacBook-Air", nickname: "Studio", platform: "macos",
                 endpoint: URL(string: "https://192.168.1.10:8620")!, lastConnectedAt: nil, addedAt: Date(), localId: nil)
    }

    func testNewComputerAsksToPair() throws {
        XCTAssertEqual(QRPairingRules.plan(link: try scanned(), saved: nil, pinned: nil, sessionValid: false), .confirm(again: false))
    }

    func testSavedPinMatchingTheScannedFingerprint() throws {
        let link = try scanned()
        XCTAssertEqual(QRPairingRules.plan(link: link, saved: saved(host1), pinned: fp1, sessionValid: true), .openPaired,
                       "Same host ID, same certificate, live session: the dock, no PIN spent")
        XCTAssertEqual(QRPairingRules.plan(link: link, saved: saved(host1), pinned: fp1, sessionValid: false), .confirm(again: true),
                       "Session revoked: \"Pair {name} again?\"")
        XCTAssertEqual(QRPairingRules.plan(link: link, saved: saved(host1), pinned: nil, sessionValid: false), .confirm(again: true),
                       "Saved without a pin: pair again")
    }

    func testSavedPinDifferingFromTheScannedFingerprintIsNeverASilentRepin() throws {
        let link = try scanned()
        let old = String(repeating: "a", count: 64)
        XCTAssertEqual(QRPairingRules.plan(link: link, saved: saved(host1), pinned: old, sessionValid: true),
                       .securityChanged(saved: old, scanned: fp1))
        XCTAssertEqual(QRPairingRules.plan(link: link, saved: saved(host1), pinned: old, sessionValid: false),
                       .securityChanged(saved: old, scanned: fp1))
    }

    func testAnotherSavedComputerDoesNotMatter() throws {
        let other = "9b1d7e22-0c4f-4a6b-9e3d-abcdefabcdef"
        XCTAssertEqual(QRPairingRules.plan(link: try scanned(), saved: saved(other), pinned: String(repeating: "a", count: 64), sessionValid: true),
                       .confirm(again: false))
    }

    // MARK: Verdict on what answered at the address

    private func answer(presented: String?, hostId: String?, open: Bool? = true, tls: String? = nil,
                        scheme: String = "https", failure: ProbeFailure? = nil) -> ProbeResult {
        let info = hostId.map { HealthInfo(hostId: $0, hostName: "Geris-MacBook-Air", tlsFingerprint: tls ?? presented, platform: "macos", pairingOpen: open) }
        return ProbeResult(info: info, presentedFingerprint: presented, failure: info == nil ? (failure ?? .other) : nil,
                           endpoint: URL(string: "\(scheme)://192.168.1.34:8620"))
    }

    func testScannedCertificateAndHostIdAreRequired() throws {
        let link = try scanned()
        XCTAssertEqual(QRPairingRules.verdict(link: link, result: answer(presented: fp1, hostId: host1)), .verified(pairingOpen: true))
        XCTAssertEqual(QRPairingRules.verdict(link: link, result: answer(presented: fp1, hostId: host1.uppercased(), open: false)),
                       .verified(pairingOpen: false))
        XCTAssertEqual(QRPairingRules.verdict(link: link, result: answer(presented: fp1, hostId: host1, open: nil)),
                       .verified(pairingOpen: true), "An older host without pairingOpen: the PIN request decides")
    }

    func testADifferentCertificateIsNeverTrustedEvenIfHealthAgrees() throws {
        let link = try scanned()
        let other = String(repeating: "b", count: 64)
        XCTAssertEqual(QRPairingRules.verdict(link: link, result: answer(presented: other, hostId: host1, tls: fp1)), .otherCertificate)
        // The probe refuses the handshake when the pin differs: no body, but the presented certificate.
        XCTAssertEqual(QRPairingRules.verdict(link: link, result: answer(presented: other, hostId: nil, failure: .tls)), .otherCertificate)
    }

    func testAnotherHostIdBehindTheScannedCertificateIsNotTheComputer() throws {
        XCTAssertEqual(QRPairingRules.verdict(link: try scanned(), result: answer(presented: fp1, hostId: "9b1d7e22-0c4f-4a6b-9e3d-abcdefabcdef")),
                       .otherHost)
    }

    func testNoAnswerOrPlainHttpIsNotVerified() throws {
        let link = try scanned()
        XCTAssertEqual(QRPairingRules.verdict(link: link, result: answer(presented: nil, hostId: nil, failure: .timeout)), .noAnswer(.timeout))
        XCTAssertEqual(QRPairingRules.verdict(link: link, result: answer(presented: nil, hostId: host1, tls: fp1, scheme: "http")),
                       .noAnswer(.tls), "Plain http never satisfies the scanned fingerprint")
    }

    // MARK: Health

    func testHealthReportsHostUi() {
        let body = #"{"ok":true,"app":"windock","hostId":"5b0e8f3a-2c41-4d7e-9a16-73c2be4d91f0","hostName":"Mac","hostUi":true,"pairingOpen":true}"#
        XCTAssertEqual(HealthProbe.parse(Data(body.utf8))?.hostUi, true)
        XCTAssertNil(HealthProbe.parse(Data(#"{"ok":true,"app":"windock"}"#.utf8))?.hostUi, "Older hosts: missing means false")
    }
}
