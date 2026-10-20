import Foundation
import Network
import Darwin

/// The `_windock._tcp` TXT record (docs/PROTOCOL.md). A hint only: anything here is verified
/// over pinned HTTPS `/health` before the phone trusts or shows it as online.
struct BonjourTXT: Equatable {
    var id: String?
    var api: String?
    var tls: Bool?
    var addr: String?
    var name: String?
    var os: String?

    init(id: String? = nil, api: String? = nil, tls: Bool? = nil, addr: String? = nil, name: String? = nil, os: String? = nil) {
        self.id = id; self.api = api; self.tls = tls; self.addr = addr; self.name = name; self.os = os
    }

    init(_ entries: [String: String]) {
        var lowered: [String: String] = [:]
        for (key, value) in entries { lowered[key.lowercased()] = value }
        if let id = lowered["id"], PinStore.isValidHostId(id) { self.id = id.lowercased() }
        if let api = lowered["api"], !api.isEmpty, api.count <= 8, api.allSatisfy(\.isNumber) { self.api = api }
        switch lowered["tls"] { case "1": tls = true; case "0": tls = false; default: tls = nil }
        if let addr = lowered["addr"], addr != "localhost", EndpointPolicy.isPrivateHost(addr) { self.addr = addr }
        if let raw = lowered["name"] {
            let cleaned = String(raw.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty { name = String(cleaned.prefix(Computer.displayLimit)) }
        }
        let os = Computer.normalizedPlatform(lowered["os"])
        self.os = os.isEmpty ? nil : os
    }
}

/// One browse result, before it is resolved and verified.
struct DiscoveredService: Equatable {
    let key: String
    let serviceName: String
    let txt: BonjourTXT
    let endpoint: NWEndpoint
}

enum DiscoveryState: Equatable { case idle, browsing, denied, failed }

protocol DiscoverySource: AnyObject {
    var onResults: (([DiscoveredService]) -> Void)? { get set }
    var onState: ((DiscoveryState) -> Void)? { get set }
    func start()
    func stop()
    /// Resolves a service to a base URL `http://<private IPv4>:<port>` (the scheme is chosen by the probe).
    func resolve(_ service: DiscoveredService, completion: @escaping (URL?) -> Void)
}

/// Bonjour browsing with `NWBrowser` (TXT records included).
final class BonjourDiscovery: DiscoverySource {
    var onResults: (([DiscoveredService]) -> Void)?
    var onState: ((DiscoveryState) -> Void)?
    private var browser: NWBrowser?
    private var resolvers: [ObjectIdentifier: ServiceResolver] = [:]

    func start() {
        stop()
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = false
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_windock._tcp", domain: nil), using: parameters)
        self.browser = browser
        browser.stateUpdateHandler = { [weak self, weak browser] state in
            guard let self, let browser, browser === self.browser else { return }
            switch state {
            case .ready: self.onState?(.browsing)
            case .waiting(let error), .failed(let error):
                self.onState?(Self.isPolicyDenied(error) ? .denied : .failed)
                if case .failed = state {
                    // Restart after a failure (for example a network change) so discovery keeps running.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                        guard let self, self.browser === browser else { return }
                        self.start()
                    }
                }
            case .cancelled, .setup: break
            @unknown default: break
            }
        }
        browser.browseResultsChangedHandler = { [weak self, weak browser] results, _ in
            guard let self, let browser, browser === self.browser else { return }
            self.onResults?(results.compactMap(Self.service))
        }
        browser.start(queue: .main)
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }

    /// TN3179: a denied Local Network permission shows up as the DNS-SD error
    /// `kDNSServiceErr_PolicyDenied` (-65570).
    static func isPolicyDenied(_ error: NWError) -> Bool {
        if case .dns(let code) = error { return code == -65570 }
        return false
    }

    static func service(_ result: NWBrowser.Result) -> DiscoveredService? {
        guard case let .service(name, type, domain, _) = result.endpoint else { return nil }
        var entries: [String: String] = [:]
        if case let .bonjour(record) = result.metadata { entries = record.dictionary }
        return DiscoveredService(key: "\(name).\(type).\(domain)".lowercased(), serviceName: name,
                                 txt: BonjourTXT(entries), endpoint: result.endpoint)
    }

    func resolve(_ service: DiscoveredService, completion: @escaping (URL?) -> Void) {
        let resolver = ServiceResolver()
        let id = ObjectIdentifier(resolver)
        resolvers[id] = resolver
        resolver.resolve(service) { [weak self] url in
            self?.resolvers[id] = nil
            completion(url)
        }
    }
}

/// Finds the service's port (and its IPv4 address when TXT `addr` is absent) by opening a short
/// IPv4 TCP connection to it and reading the remote endpoint.
final class ServiceResolver {
    private var connection: NWConnection?
    private var done = false

    func resolve(_ service: DiscoveredService, timeout: TimeInterval = 4, completion: @escaping (URL?) -> Void) {
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let connection = NWConnection(to: service.endpoint, using: parameters)
        self.connection = connection
        let finish: (URL?) -> Void = { [weak self] url in
            guard let self, !self.done else { return }
            self.done = true
            self.connection?.cancel()
            self.connection = nil
            completion(url)
        }
        connection.stateUpdateHandler = { [weak connection] state in
            switch state {
            case .ready:
                guard let remote = connection?.currentPath?.remoteEndpoint,
                      case let .hostPort(host, port) = remote else { finish(nil); return }
                var address: String?
                if case let .ipv4(ip) = host { address = Self.string(ip) }
                // Prefer the address the host advertises; the port comes from the service itself.
                let chosen = service.txt.addr ?? address
                guard let chosen, let url = EndpointPolicy.normalize("http://\(chosen):\(port.rawValue)") else { finish(nil); return }
                finish(url)
            case .failed, .cancelled: finish(nil)
            case .waiting: break
            default: break
            }
        }
        connection.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(nil) }
    }

    static func string(_ ip: IPv4Address) -> String {
        ip.rawValue.map { String($0) }.joined(separator: ".")
    }
}

/// Wi-Fi / Ethernet availability and this phone's IPv4 subnet (no location permission needed).
final class NetworkStatus {
    private let monitor = NWPathMonitor()
    private(set) var hasLocalLink = true
    var onChange: ((Bool) -> Void)?

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                let usable = path.status == .satisfied && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
                self.hasLocalLink = usable
                self.onChange?(usable)
            }
        }
        monitor.start(queue: DispatchQueue(label: "windock.path"))
    }

    deinit { monitor.cancel() }

    struct Interface: Equatable { let address: String; let netmask: String }

    /// The phone's Wi-Fi IPv4 address and netmask (`en0` first, then any other private interface).
    static func localIPv4() -> Interface? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return nil }
        defer { freeifaddrs(head) }
        var candidates: [(name: String, interface: Interface)] = []
        var pointer: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = pointer {
            defer { pointer = entry.pointee.ifa_next }
            let flags = Int32(entry.pointee.ifa_flags)
            guard let addr = entry.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
                  flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0, let mask = entry.pointee.ifa_netmask else { continue }
            let name = String(cString: entry.pointee.ifa_name)
            guard let address = numericHost(addr), let netmask = numericHost(mask),
                  EndpointPolicy.isPrivateHost(address), !address.hasPrefix("127.") else { continue }
            candidates.append((name, Interface(address: address, netmask: netmask)))
        }
        return candidates.first { $0.name == "en0" }?.interface ?? candidates.first?.interface
    }

    private static func numericHost(_ addr: UnsafeMutablePointer<sockaddr>) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
        return String(cString: buffer)
    }

    /// Whether `host` lies in the subnet of `interface` (both dotted IPv4).
    static func sameSubnet(_ interface: Interface, _ host: String) -> Bool? {
        guard let a = ipv4(interface.address), let m = ipv4(interface.netmask), let h = ipv4(host) else { return nil }
        return a & m == h & m
    }

    static func ipv4(_ text: String) -> UInt32? {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var value: UInt32 = 0
        for part in parts {
            guard let octet = UInt8(part) else { return nil }
            value = value << 8 | UInt32(octet)
        }
        return value
    }
}
