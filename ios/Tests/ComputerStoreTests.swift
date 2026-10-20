import XCTest
@testable import WinDock

final class ComputerStoreTests: XCTestCase {
    private let suite = "WinDockComputerStoreTests"
    private var defaults: UserDefaults!
    private let hostA = "3f2a9c01-b7e4-4d5e-8a10-0123456789ab"
    private let hostB = "9b1d7e22-0c4f-4a6b-9e3d-abcdefabcdef"
    private let fingerprint = "d14004840beedfec0e17d92c54d86df5e9daf224bf966c026ac90ba44b9eb775"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() { defaults.removePersistentDomain(forName: suite) }

    private func computer(_ hostId: String, name: String = "DESKTOP-7H2KQ9L", endpoint: String = "https://192.168.1.20:8620",
                          last: TimeInterval? = nil, added: TimeInterval = 0) -> Computer {
        Computer(hostId: hostId, hostName: name, nickname: nil, platform: "windows", endpoint: URL(string: endpoint)!,
                 lastConnectedAt: last.map { Date(timeIntervalSince1970: $0) }, addedAt: Date(timeIntervalSince1970: added), localId: nil)
    }

    func testRoundTripSurvivesANewStore() {
        let store = ComputerStore(defaults: defaults)
        var studio = computer(hostA.uppercased(), last: 100)
        studio.nickname = "Studio PC"
        store.upsert(studio)
        store.upsert(computer(hostB, name: "Geris-MacBook-Air.local", endpoint: "https://192.168.1.34:8620", last: 50))
        let reloaded = ComputerStore(defaults: defaults)
        XCTAssertEqual(reloaded.computers.count, 2)
        let saved = try? XCTUnwrap(reloaded.computer(hostA))
        XCTAssertEqual(saved?.hostId, hostA, "Host IDs are stored lowercase")
        XCTAssertEqual(saved?.nickname, "Studio PC")
        XCTAssertEqual(saved?.endpoint.absoluteString, "https://192.168.1.20:8620")
        XCTAssertEqual(saved?.lastConnectedAt, Date(timeIntervalSince1970: 100))
        XCTAssertEqual(reloaded.computer(hostB.uppercased())?.displayName, "Geris-MacBook-Air")
    }

    func testUpdateRemoveAndOrdering() {
        let store = ComputerStore(defaults: defaults)
        store.upsert(computer(hostA, last: nil, added: 10))
        store.upsert(computer(hostB, endpoint: "https://192.168.1.34:8620", last: 5))
        XCTAssertEqual(store.last?.hostId, hostB, "A computer that connected beats one that never did")
        store.update(hostA) { $0.lastConnectedAt = Date(timeIntervalSince1970: 20) }
        XCTAssertEqual(store.byLastConnected.map(\.hostId), [hostA, hostB])
        store.upsert(computer(hostA, name: "Renamed", last: 20))
        XCTAssertEqual(store.computers.count, 2, "Upsert replaces by host ID")
        store.remove(hostA.uppercased())
        XCTAssertEqual(ComputerStore(defaults: defaults).computers.map(\.hostId), [hostB])
    }

    func testInvalidRecordsAreDropped() throws {
        let bad = [computer("not-a-uuid"), computer(hostA, endpoint: "https://example.com"), computer(hostB), computer(hostB)]
        defaults.set(try JSONEncoder.windock.encode(bad), forKey: ComputerStore.key)
        let store = ComputerStore(defaults: defaults)
        XCTAssertEqual(store.computers.map(\.hostId), [hostB], "Invalid IDs, public endpoints and duplicates never load")
        defaults.set(Data("garbage".utf8), forKey: ComputerStore.key)
        XCTAssertTrue(ComputerStore(defaults: defaults).isEmpty)
    }

    // MARK: Migration from the single remembered address

    func testMigrationFromRememberedHttpsAddressAndOnePinNeedsNoNetwork() {
        let pins = PinStore(defaults: defaults)
        pins.setPin(fingerprint, for: hostA)
        defaults.set("https://192.168.1.20:8620", forKey: ComputerStore.legacyAddressKey)
        let store = ComputerStore(defaults: defaults)
        guard case .immediate(let migrated) = store.migrationPlan(pins: pins) else { return XCTFail("Expected local migration") }
        XCTAssertEqual(migrated.hostId, hostA)
        XCTAssertEqual(migrated.endpoint.absoluteString, "https://192.168.1.20:8620")
        XCTAssertNotNil(migrated.lastConnectedAt, "The migrated computer is the one launch opens")
        store.completeMigration(with: migrated)
        XCTAssertNil(defaults.string(forKey: ComputerStore.legacyAddressKey), "The single address is retired")
        XCTAssertEqual(store.last?.hostId, hostA)
        XCTAssertEqual(pins.pin(for: hostA), fingerprint, "The existing pin survives: no PIN, no prompt")
        XCTAssertEqual(store.migrationPlan(pins: pins), .none, "Migration runs once")
    }

    func testMigrationNeedsAProbeForPlainOrAmbiguousAddresses() {
        let pins = PinStore(defaults: defaults)
        defaults.set("http://192.168.1.20:8620", forKey: ComputerStore.legacyAddressKey)
        XCTAssertEqual(ComputerStore(defaults: defaults).migrationPlan(pins: pins), .probe(URL(string: "http://192.168.1.20:8620")!))
        defaults.set("https://192.168.1.20:8620", forKey: ComputerStore.legacyAddressKey)
        pins.setPin(fingerprint, for: hostA)
        pins.setPin(fingerprint, for: hostB)
        XCTAssertEqual(ComputerStore(defaults: defaults).migrationPlan(pins: pins), .probe(URL(string: "https://192.168.1.20:8620")!),
                       "Two pins: the host ID must come from the computer")
    }

    func testMigrationIgnoresMissingOrUnsafeAddresses() {
        let pins = PinStore(defaults: defaults)
        XCTAssertEqual(ComputerStore(defaults: defaults).migrationPlan(pins: pins), .none)
        defaults.set("https://example.com", forKey: ComputerStore.legacyAddressKey)
        XCTAssertEqual(ComputerStore(defaults: defaults).migrationPlan(pins: pins), .none)
        XCTAssertNil(defaults.string(forKey: ComputerStore.legacyAddressKey))
        let store = ComputerStore(defaults: defaults)
        store.upsert(computer(hostA))
        defaults.set("https://192.168.1.20:8620", forKey: ComputerStore.legacyAddressKey)
        XCTAssertEqual(store.migrationPlan(pins: pins), .none, "Never migrates over an existing list")
    }

    // MARK: Display names

    func testDisplayNameRules() {
        XCTAssertEqual(Computer.displayName(nickname: "Studio PC", hostName: "DESKTOP-7H2KQ9L"), "Studio PC")
        XCTAssertEqual(Computer.displayName(nickname: "   ", hostName: "DESKTOP-7H2KQ9L"), "DESKTOP-7H2KQ9L", "Empty nickname restores the host name")
        XCTAssertEqual(Computer.displayName(nickname: nil, hostName: "Geris-MacBook-Air.local"), "Geris-MacBook-Air")
        XCTAssertEqual(Computer.displayName(nickname: nil, hostName: "Geris-MacBook-Air.LOCAL."), "Geris-MacBook-Air")
        XCTAssertEqual(Computer.displayName(nickname: nil, hostName: ""), "your computer")
        XCTAssertEqual(Computer.displayName(nickname: nil, hostName: "a\u{0007}b\n"), "ab")
        XCTAssertEqual(Computer.displayName(nickname: nil, hostName: String(repeating: "x", count: 90)).count, 60)
        XCTAssertEqual(Computer.sanitizeNickname(String(repeating: "n", count: 50))?.count, 40, "Nicknames are at most 40 characters")
        XCTAssertNil(Computer.sanitizeNickname("\n\t "))
        XCTAssertEqual(Computer.platformWord("windows"), "Windows")
        XCTAssertEqual(Computer.platformWord("macos"), "macOS")
        XCTAssertNil(Computer.platformWord("beos"))
    }

    func testDeviceNameForAuth() {
        XCTAssertEqual(PairingAPI.deviceName(isPad: false), "iPhone")
        XCTAssertEqual(PairingAPI.deviceName(isPad: true), "iPad")
    }
}
