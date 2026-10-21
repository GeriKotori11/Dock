import XCTest
import UIKit
import WebKit
@testable import WinDock

/// `windock://pair` routing in the app (cold start, running, malformed, newer, known host with a
/// different pin) and, against the real Node host (ios/scripts/smoke-host.mjs), QR pairing end to
/// end: the scanned fingerprint replaces the security-code step, and a different certificate at
/// the address is never sent the PIN.
@MainActor
final class QRLinkTests: XCTestCase {
    private var root: RootViewController!
    private var coordinator: ConnectionCoordinator!
    private var defaults: UserDefaults!
    private let suite = "WinDockQRLinkTests"
    private let sample = "windock://pair?v=1&id=Ww6POixBTX6aFnPCvk2R8A&addr=192.168.1.34:8620&fp=biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9qE&pin=482913&name=Geris-MacBook-Air"
    private let sampleHost = "5b0e8f3a-2c41-4d7e-9a16-73c2be4d91f0"

    override func setUp() async throws {
        defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defaults.set(true, forKey: ComputerStore.primedKey)
        let store = WKWebsiteDataStore.default()
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        coordinator = ConnectionCoordinator(store: ComputerStore(defaults: defaults), pins: PinStore(defaults: defaults), discovery: FakeDiscovery())
        root = RootViewController(coordinator: coordinator, autoStart: false)
        let window = appWindow()
        window.rootViewController = root
        window.makeKeyAndVisible()
        root.loadViewIfNeeded()
    }

    override func tearDown() async throws {
        root.dismissModals(animated: false)
        coordinator.showHub(overDock: false)
        try await Task.sleep(nanoseconds: 300_000_000)
        defaults.removePersistentDomain(forName: suite)
    }

    private func appWindow() -> UIWindow {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
        return (scene.delegate as! SceneDelegate).window!
    }

    private func waitUntil(_ description: String, seconds: Double = 20, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTFail("Timed out: \(description)")
        throw NSError(domain: "QRLinkTests", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
    }

    private var qr: QRPairingViewController? { root.topModal as? QRPairingViewController }
    private var alert: UIAlertController? { root.topModal as? UIAlertController }

    private func launch() async throws {
        coordinator.start()
        try await waitUntil("Launch finished") { [self] in coordinator.launched && root.currentScreen != nil }
    }

    private func screenshot(_ name: String) async throws {
        try await Task.sleep(nanoseconds: 400_000_000)
        let window = appWindow()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    // MARK: Routing

    func testColdStartLinkWaitsForLaunchThenAsksBeforeAnything() async throws {
        coordinator.handleOpenURL(URL(string: sample)!)
        XCTAssertNil(root.topModal, "Nothing happens before launch finishes")
        guard case .pair(let link)? = coordinator.pendingLinkRoute else { return XCTFail("The link is held until launch") }
        XCTAssertEqual(link.hostId, sampleHost)
        try await launch()
        try await waitUntil("Q5 over the hub") { [self] in qr?.isBeingPresented == false }
        let screen = try XCTUnwrap(qr)
        XCTAssertEqual(screen.screen, .confirm)
        XCTAssertEqual(screen.phase, .idle, "Nothing touches the network before Pair")
        XCTAssertEqual(screen.titleLabel.text, "Pair with Geris-MacBook-Air?")
        XCTAssertTrue(root.currentScreen is ComputersViewController)
        XCTAssertNil(coordinator.pendingLinkRoute)
        try await screenshot("qr-05-confirm")
        screen.secondaryButton?.sendActions(for: .touchUpInside)
        try await waitUntil("Cancel returns to the hub") { [self] in root.topModal == nil }
        XCTAssertTrue(root.currentScreen is ComputersViewController)
        XCTAssertTrue(coordinator.store.isEmpty, "Nothing was saved")
    }

    func testMalformedAndNewerLinksExplainThemselves() async throws {
        try await launch()
        coordinator.handleOpenURL(URL(string: sample.replacingOccurrences(of: "pin=482913", with: "pin=48291"))!)
        try await waitUntil("Malformed alert") { [self] in alert?.isBeingPresented == false }
        XCTAssertEqual(alert?.title, "This isn't a WinDock pairing code")
        alert?.dismiss(animated: false)
        try await waitUntil("Alert gone") { [self] in root.topModal == nil }

        coordinator.handleOpenURL(URL(string: sample.replacingOccurrences(of: "v=1", with: "v=2"))!)
        try await waitUntil("Newer alert") { [self] in alert?.isBeingPresented == false }
        XCTAssertEqual(alert?.title, "This code needs a newer WinDock app. Update the app, or pair with the PIN instead.")
        alert?.dismiss(animated: false)
        try await waitUntil("Alert gone") { [self] in root.topModal == nil }

        coordinator.handleOpenURL(URL(string: "https://192.168.1.34:8620/")!)
        coordinator.handleOpenURL(URL(string: "windock://other?v=1")!)
        try await waitUntil("Wrong host alert") { [self] in alert?.isBeingPresented == false }
        XCTAssertEqual(alert?.title, "This isn't a WinDock pairing code", "Only host `pair` is accepted")
    }

    func testKnownHostWithAnotherPinShowsSecurityChangedAndKeepsThePin() async throws {
        let old = String(repeating: "a", count: 64)
        coordinator.store.upsert(Computer(hostId: sampleHost, hostName: "Geris-MacBook-Air", nickname: "Studio", platform: "macos",
                                          endpoint: URL(string: "https://192.168.1.10:8620")!, lastConnectedAt: nil, addedAt: Date(), localId: nil))
        coordinator.pins.setPin(old, for: sampleHost)
        coordinator.handleOpenURL(URL(string: sample)!)
        try await launch()
        try await waitUntil("Q11") { [self] in qr?.isBeingPresented == false }
        let screen = try XCTUnwrap(qr)
        XCTAssertEqual(screen.screen, .securityChanged)
        XCTAssertEqual(screen.titleLabel.text, "Studio has a new security code")
        XCTAssertEqual(coordinator.pins.pin(for: sampleHost), old, "Never a silent re-pin")
        try await screenshot("qr-11-security-changed")
        screen.secondaryButton?.sendActions(for: .touchUpInside)
        try await waitUntil("Not now closes it") { [self] in root.topModal == nil }
        XCTAssertEqual(coordinator.pins.pin(for: sampleHost), old)
    }

    func testANewLinkReplacesTheOneBeingConfirmed() async throws {
        try await launch()
        coordinator.handleOpenURL(URL(string: sample)!)
        try await waitUntil("First Q5") { [self] in qr?.isBeingPresented == false }
        let first = qr
        let second = sample.replacingOccurrences(of: "name=Geris-MacBook-Air", with: "name=Other")
        coordinator.handleOpenURL(URL(string: second)!)
        try await waitUntil("Replaced") { [self] in qr != nil && qr !== first && qr?.isBeingPresented == false }
        XCTAssertEqual(qr?.titleLabel.text, "Pair with Other?")
    }

    // MARK: Against the fixture host

    private struct HostHealth { let hostId: String; let fingerprint: String }

    private func hostHealth() async throws -> HostHealth {
        let (body, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:18622/health")!)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let tls = try XCTUnwrap(object["tls"] as? [String: Any], "Fixture host must serve TLS")
        return HostHealth(hostId: try XCTUnwrap(object["hostId"] as? String), fingerprint: try XCTUnwrap(tls["fingerprint"] as? String))
    }

    /// The fixture host listens on loopback only, which a scanned `addr` may never be
    /// (QRPairingTests covers that), so the parsed link is built directly.
    private func fixtureLink(fingerprint: String, health: HostHealth) -> PairingLink {
        PairingLink(hostId: health.hostId.lowercased(), endpoint: URL(string: "https://127.0.0.1:18622")!, address: "127.0.0.1:18622",
                    fingerprint: fingerprint.lowercased(), pin: "864200", name: "Fixture PC")
    }

    func testScannedCodePairsWithoutTheSecurityCodeStep() async throws {
        let health = try await hostHealth()
        try await launch()
        coordinator.presentPairingLink(fixtureLink(fingerprint: health.fingerprint, health: health))
        try await waitUntil("Q5") { [self] in qr?.isBeingPresented == false }
        let screen = try XCTUnwrap(qr)
        XCTAssertEqual(screen.titleLabel.text, "Pair with Fixture PC?")
        screen.primaryButton?.sendActions(for: .touchUpInside)
        XCTAssertEqual(screen.phase, .pairing)
        try await waitUntil("Q7 Paired", seconds: 30) { screen.phase == .paired }
        try await screenshot("qr-07-paired")
        try await waitUntil("Dock after QR pairing", seconds: 60) { [self] in root.topModal == nil && root.isShowingDock && root.dock?.isReady == true }
        XCTAssertEqual(coordinator.pins.pin(for: health.hostId), health.fingerprint, "The scanned fingerprint is pinned")
        XCTAssertEqual(coordinator.store.computer(health.hostId)?.endpoint.absoluteString, "https://127.0.0.1:18622")
        XCTAssertEqual(coordinator.current?.hostId, health.hostId)
    }

    func testDifferentCertificateAtTheAddressIsNeverSentThePin() async throws {
        let health = try await hostHealth()
        let wrong = String(repeating: "0", count: 63) + "1"
        try await launch()
        coordinator.presentPairingLink(fixtureLink(fingerprint: wrong, health: health))
        try await waitUntil("Q5") { [self] in qr?.isBeingPresented == false }
        let screen = try XCTUnwrap(qr)
        screen.primaryButton?.sendActions(for: .touchUpInside)
        try await waitUntil("Q10 after the identity search", seconds: 30) { screen.screen == .cantReach }
        XCTAssertTrue(screen.otherDevice, "\"A different device answered at …\"")
        XCTAssertNil(coordinator.store.computer(health.hostId), "Nothing saved")
        XCTAssertNil(coordinator.pins.pin(for: health.hostId), "Nothing pinned")
        try await screenshot("qr-10-other-device")
    }
}
