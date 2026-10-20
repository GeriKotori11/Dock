import XCTest
@testable import WinDock

/// Coordinator decisions: match, mismatch, a new host ID at an old address, and an IP change.
final class ConnectionRulesTests: XCTestCase {
    private let hostA = "3f2a9c01-b7e4-4d5e-8a10-0123456789ab"
    private let hostB = "9b1d7e22-0c4f-4a6b-9e3d-abcdefabcdef"
    private let pinned = String(repeating: "a", count: 64)
    private let other = String(repeating: "b", count: 64)
    private let suite = "WinDockRulesTests"
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() { defaults.removePersistentDomain(forName: suite) }

    private var studio: Computer {
        Computer(hostId: hostA, hostName: "DESKTOP-7H2KQ9L", nickname: "Studio PC", platform: "windows",
                 endpoint: URL(string: "https://192.168.1.20:8620")!, lastConnectedAt: nil, addedAt: Date(), localId: nil)
    }

    private func answer(_ hostId: String?, presented: String?, at endpoint: String = "https://192.168.1.20:8620",
                        tls: String? = nil) -> ProbeResult {
        ProbeResult(info: HealthInfo(hostId: hostId, hostName: "DESKTOP-7H2KQ9L", tlsFingerprint: tls ?? presented, platform: "windows", pairingOpen: true),
                    presentedFingerprint: presented, failure: nil, endpoint: URL(string: endpoint)!)
    }

    func testPinnedCertificateAndSameHostIdIsAccepted() {
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: answer(hostA, presented: pinned)),
                       .accept(fingerprint: pinned))
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: answer(hostA.uppercased(), presented: pinned)),
                       .accept(fingerprint: pinned), "Host IDs compare case-insensitively")
    }

    func testKnownHostIdWithDifferentCertificateIsAMismatchNeverATrust() {
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: answer(hostA, presented: other)),
                       .mismatch(presented: other))
        // Even when /health claims the pinned fingerprint, the handshake decides.
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: answer(hostA, presented: other, tls: pinned)),
                       .mismatch(presented: other))
    }

    func testNewHostIdAtTheOldAddressIsAnotherComputer() {
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: answer(hostB, presented: other)),
                       .otherComputer(hostId: hostB))
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: answer(hostB, presented: pinned)),
                       .otherComputer(hostId: hostB), "The same certificate under another host ID is not this computer")
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: answer(nil, presented: other)),
                       .otherComputer(hostId: nil))
    }

    func testSavedComputerWithoutPinNeedsPairingNotTrust() {
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: nil, result: answer(hostA, presented: other)),
                       .needsPairing(presented: other))
    }

    func testNoAnswerKeepsTheFailureKind() {
        let refused = ProbeResult(info: nil, presentedFingerprint: nil, failure: .refused, endpoint: studio.endpoint)
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: refused), .noAnswer(.refused))
    }

    func testPinnedHostIsNeverAcceptedOverPlainHttp() {
        let plain = answer(hostA, presented: nil, at: "http://192.168.1.20:8620", tls: nil)
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: plain), .noAnswer(.tls))
        var noTls = studio
        noTls.endpoint = URL(string: "http://192.168.1.20:8620")!
        XCTAssertEqual(ConnectionRules.evaluate(noTls, pinned: nil, result: plain), .accept(fingerprint: nil),
                       "A host that never offered TLS and was never pinned works over http")
        let claimsTls = ProbeResult(info: HealthInfo(hostId: hostA, hostName: "", tlsFingerprint: pinned), presentedFingerprint: nil,
                                    failure: nil, endpoint: URL(string: "http://192.168.1.20:8620")!)
        XCTAssertEqual(ConnectionRules.evaluate(noTls, pinned: nil, result: claimsTls), .noAnswer(.tls))
    }

    func testLegacyHostWithoutIdIsRecognisedOnlyWithoutTls() {
        var legacy = studio
        legacy.localId = true
        legacy.endpoint = URL(string: "http://192.168.1.20:8620")!
        XCTAssertEqual(ConnectionRules.evaluate(legacy, pinned: nil, result: answer(nil, presented: nil, at: "http://192.168.1.20:8620")),
                       .accept(fingerprint: nil))
        XCTAssertEqual(ConnectionRules.evaluate(legacy, pinned: nil, result: answer(hostB, presented: nil, at: "http://192.168.1.20:8620")),
                       .otherComputer(hostId: hostB))
    }

    func testIpChangeIsDetectedByAddressOrPort() {
        XCTAssertTrue(ConnectionRules.moved(studio, to: URL(string: "https://192.168.1.47:8620")!))
        XCTAssertTrue(ConnectionRules.moved(studio, to: URL(string: "https://192.168.1.20:8621")!))
        XCTAssertFalse(ConnectionRules.moved(studio, to: URL(string: "https://192.168.1.20:8620")!))
        // Found by identity at the new address with the pinned certificate: accepted (then relocated).
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: answer(hostA, presented: pinned, at: "https://192.168.1.47:8620")),
                       .accept(fingerprint: pinned))
        // Found by identity at a new address with another certificate: S10, never relocated.
        XCTAssertEqual(ConnectionRules.evaluate(studio, pinned: pinned, result: answer(hostA, presented: other, at: "https://192.168.1.47:8620")),
                       .mismatch(presented: other))
    }

    func testArrivalOpensWarnsOrPairs() {
        let store = ComputerStore(defaults: defaults)
        let pins = PinStore(defaults: defaults)
        store.upsert(studio)
        pins.setPin(pinned, for: hostA)
        let moved = answer(hostA, presented: pinned, at: "https://192.168.1.47:8620")
        XCTAssertEqual(ConnectionRules.arrival(store: store, pins: pins, result: moved),
                       .openPaired(hostId: hostA, endpoint: URL(string: "https://192.168.1.47:8620")!, fingerprint: pinned))
        XCTAssertEqual(ConnectionRules.arrival(store: store, pins: pins, result: answer(hostA, presented: other)),
                       .mismatch(hostId: hostA, presented: other))
        XCTAssertEqual(ConnectionRules.arrival(store: store, pins: pins, result: answer(hostB, presented: other)), .pairNew)
        XCTAssertEqual(ConnectionRules.arrival(store: store, pins: pins, result: answer(nil, presented: nil, at: "http://192.168.1.9:8620")), .pairNew)
        pins.removePin(for: hostA)
        XCTAssertEqual(ConnectionRules.arrival(store: store, pins: pins, result: answer(hostA, presented: other)), .repair(hostId: hostA))
    }

    func testCantReachChecksAreOrderedByWhatThePhoneDetected() {
        let phone = NetworkStatus.Interface(address: "10.0.4.17", netmask: "255.255.255.0")
        let differentNetwork = ConnectionRules.checks(phone: phone, hostIp: "192.168.1.20", platform: "windows", lastFailure: .timeout, discoverySawAny: true)
        XCTAssertEqual(differentNetwork.checks, [.differentNetwork(phoneIp: "10.0.4.17", hostIp: "192.168.1.20"), .notRunning, .isolation])
        XCTAssertEqual(differentNetwork.likely, 0)
        let home = NetworkStatus.Interface(address: "192.168.1.5", netmask: "255.255.255.0")
        let refused = ConnectionRules.checks(phone: home, hostIp: "192.168.1.20", platform: "windows", lastFailure: .refused, discoverySawAny: true)
        XCTAssertEqual(refused.checks, [.notRunning, .isolation])
        XCTAssertEqual(refused.likely, 0)
        let isolated = ConnectionRules.checks(phone: home, hostIp: "192.168.1.20", platform: "macos", lastFailure: .timeout, discoverySawAny: false)
        XCTAssertEqual(isolated.checks, [.isolation, .notRunning, .macFirewall])
        XCTAssertEqual(isolated.likely, 0)
        let unsure = ConnectionRules.checks(phone: nil, hostIp: "192.168.1.20", platform: "windows", lastFailure: .timeout, discoverySawAny: true)
        XCTAssertEqual(unsure.checks, [.notRunning, .isolation])
        XCTAssertNil(unsure.likely, "No tag when nothing points to one cause")
    }

    func testRetryBackoff() {
        XCTAssertEqual((0..<6).map(ConnectionRules.retryDelay), [3, 5, 10, 15, 15, 15])
    }

    func testSubnetMath() {
        let phone = NetworkStatus.Interface(address: "172.20.10.2", netmask: "255.255.255.240")
        XCTAssertEqual(NetworkStatus.sameSubnet(phone, "172.20.10.14"), true)
        XCTAssertEqual(NetworkStatus.sameSubnet(phone, "172.20.10.17"), false)
        XCTAssertNil(NetworkStatus.sameSubnet(phone, "not-an-ip"))
    }
}
