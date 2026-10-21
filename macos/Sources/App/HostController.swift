// Host lifecycle (HOST-CONTROL-PAGE.md 5.8, 13.6, decision D7). Probes /health
// first and attaches to a WinDock host that already answers; otherwise spawns
// `node server.js` from the checkout, logs its output, waits for /health, and
// restarts or stops it on request. Main thread only.
import Foundation
import os

enum HostMode: String {
    case none
    /// This app spawned the host and may restart or stop it.
    case owned
    /// A host started elsewhere (Terminal, LaunchAgent) answered first.
    case attached
}

enum HostPhase: Equatable {
    case probing
    case starting(slow: Bool)
    case running
    case problem(OfflineVariant, detail: String)
}

protocol HostControllerDelegate: AnyObject {
    func hostControllerDidChange(_ controller: HostController)
    func hostControllerStatusDidChange(_ controller: HostController)
}

final class HostController {
    static let probeInterval: TimeInterval = 0.25
    static let slowAfter: TimeInterval = 15
    static let monitorInterval: TimeInterval = 5
    static let killAfter: TimeInterval = 3

    let settings: AppSettings
    let log: HostLog
    weak var delegate: HostControllerDelegate?

    private(set) var mode: HostMode = .none
    private(set) var phase: HostPhase = .probing
    private(set) var nodePath: String?
    private(set) var status: HostStatusSummary?
    /// True once /api/host/status answered at least once for the current host.
    private(set) var statusKnown = false

    private var process: Process?
    private var generation = 0
    private var lastError = ""
    private var stopCompletions: [() -> Void] = []
    private var monitorTimer: Timer?
    private var slowWork: DispatchWorkItem?
    private var attachedMisses = 0
    private let logger = Logger(subsystem: "dev.gerikotori.windock.menu", category: "host")
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 3
        config.waitsForConnectivity = false
        config.httpMaximumConnectionsPerHost = 2
        return URLSession(configuration: config)
    }()

    init(settings: AppSettings, log: HostLog) {
        self.settings = settings
        self.log = log
    }

    var port: Int { settings.port }
    var isOwnedProcessRunning: Bool { process?.isRunning ?? false }

    // ---- start ---------------------------------------------------------

    /// Probe, then attach or spawn. Also "Try again" / "Restart" on the offline page.
    func start() {
        generation += 1
        let gen = generation
        cancelTimers()
        mode = .none
        phase = .probing
        status = nil
        statusKnown = false
        attachedMisses = 0
        notify()
        fetch(HostHealth.healthURL(port: port), timeout: 1.5) { [weak self] code, body in
            guard let self, gen == self.generation else { return }
            switch HostHealth.decide(HostHealth.verdict(statusCode: code, body: body)) {
            case .attach: self.attach()
            case .spawn: self.spawn(gen)
            case .portInUse:
                // Something other than WinDock answers on 127.0.0.1:{port}. A
                // spawned host could still bind the wildcard address, but this
                // app could never reach it, so say the port is taken.
                self.log.mark("port \(self.port) answers, but not as WinDock")
                self.phase = .problem(.portInUse, detail: "")
                self.notify()
            }
        }
    }

    private func attach() {
        mode = .attached
        phase = .running
        logger.info("attached to the WinDock host already running on port \(self.port)")
        locateNodeForFirewall()
        notify()
        startMonitor()
    }

    private func spawn(_ gen: Int) {
        mode = .owned
        let settings = self.settings
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let node = NodeLocator.live().locate(override: settings.nodePathOverride)
            var versionOK = false
            if let node, let out = ProcessRunner.run(node, ["--version"], timeout: 5) {
                versionOK = out.status == 0 && NodeLocator.meetsMinimum(out.stdout)
            }
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                self.nodePath = node
                guard let node, versionOK else {
                    self.log.mark(node == nil ? "Node.js not found" : "Node.js at \(node ?? "") is older than 20")
                    self.phase = .problem(.nodeMissing, detail: "")
                    self.notify()
                    return
                }
                guard FileManager.default.fileExists(atPath: settings.serverPath) else {
                    self.log.mark("server.js not found in \(settings.repoPath)")
                    self.phase = .problem(.exited, detail: "server.js not found in \(settings.repoPath)")
                    self.notify()
                    return
                }
                self.launch(node: node, gen: gen)
            }
        }
    }

    private func launch(node: String, gen: Int) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [settings.serverPath]
        process.currentDirectoryURL = URL(fileURLWithPath: settings.repoPath, isDirectory: true)
        process.environment = environment(node: node)
        process.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err

        // The exit is handled once both pipes are drained, so the last stderr
        // line is known by then.
        let drained = DispatchGroup()
        read(out, stream: "out", process: process, group: drained)
        read(err, stream: "err", process: process, group: drained)
        drained.enter()
        process.terminationHandler = { _ in drained.leave() }

        lastError = ""
        do {
            try process.run()
        } catch {
            out.fileHandleForReading.readabilityHandler = nil
            err.fileHandleForReading.readabilityHandler = nil
            log.mark("host failed to start: \(error.localizedDescription)")
            phase = .problem(.exited, detail: error.localizedDescription)
            notify()
            return
        }
        self.process = process
        drained.notify(queue: .main) { [weak self] in self?.processDidExit(process) }
        log.mark("starting host: \(node) server.js on port \(port) (pid \(process.processIdentifier))")
        phase = .starting(slow: false)
        notify()

        let slow = DispatchWorkItem { [weak self] in
            guard let self, gen == self.generation, self.phase == .starting(slow: false) else { return }
            self.phase = .starting(slow: true)
            self.notify()
        }
        slowWork = slow
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.slowAfter, execute: slow)
        waitForHealth(gen: gen, process: process)
    }

    private func environment(node: String) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        for key in env.keys where key.hasPrefix("WINDOCK_") || key == "PORT" { env.removeValue(forKey: key) }
        let nodeDir = (node as NSString).deletingLastPathComponent
        env["PATH"] = nodeDir + ":" + (env["PATH"].flatMap { $0.isEmpty ? nil : $0 } ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        env["WINDOCK_SHELL"] = "macos-menubar"
        env["WINDOCK_HIDE_PIN"] = "1"
        env["PORT"] = String(port)
        for (key, value) in settings.hostEnvironment { env[key] = value }
        return env
    }

    private final class SplitterBox { var splitter = LineSplitter() }

    private func read(_ pipe: Pipe, stream: String, process: Process, group: DispatchGroup) {
        group.enter()
        let box = SplitterBox()
        let log = self.log
        let handleLine: (String) -> Void = { [weak self] line in
            log.write(stream: stream, line: line)
            guard stream == "err", HostErrorLine.isMeaningful(line) else { return }
            DispatchQueue.main.async {
                guard let self, self.process === process || self.process == nil else { return }
                self.lastError = line
            }
        }
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                if let rest = box.splitter.finish() { handleLine(rest) }
                group.leave()
                return
            }
            for line in box.splitter.feed(data) { handleLine(line) }
        }
    }

    private func waitForHealth(gen: Int, process: Process) {
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.probeInterval) { [weak self] in
            guard let self, gen == self.generation, self.process === process, process.isRunning else { return }
            self.fetch(HostHealth.healthURL(port: self.port), timeout: 1) { [weak self] code, body in
                guard let self, gen == self.generation, self.process === process, process.isRunning else { return }
                if HostHealth.verdict(statusCode: code, body: body) == .windock {
                    self.slowWork?.cancel()
                    self.phase = .running
                    self.log.mark("host is answering on port \(self.port)")
                    self.notify()
                    self.startMonitor()
                } else {
                    self.waitForHealth(gen: gen, process: process)
                }
            }
        }
    }

    private func processDidExit(_ exited: Process) {
        let code = exited.terminationStatus
        log.mark("host exited with code \(code)")
        guard process === exited else { return }
        process = nil
        if !stopCompletions.isEmpty {
            let completions = stopCompletions
            stopCompletions = []
            completions.forEach { $0() }
            return
        }
        cancelTimers()
        let variant: OfflineVariant = HostErrorLine.isPortInUse(lastError) ? .portInUse : .exited
        phase = .problem(variant, detail: HostErrorLine.detail(lastError))
        status = nil
        statusKnown = false
        notify()
    }

    // ---- restart / stop ------------------------------------------------

    /// Restart: only for a host this app owns (or none yet). Attached hosts are
    /// left alone (5.8 attach mode).
    func restart() {
        guard mode != .attached else { return }
        log.mark("restart requested")
        stop { [weak self] in self?.start() }
    }

    /// SIGTERM, then SIGKILL after 3 s. Calls back on the main thread once the
    /// owned host is gone (at once when there is none).
    func stop(_ completion: @escaping () -> Void) {
        guard let process, process.isRunning else {
            self.process = nil
            completion()
            return
        }
        generation += 1 // health polls and slow timers for this host stop here
        cancelTimers()
        stopCompletions.append(completion)
        guard stopCompletions.count == 1 else { return }
        log.mark("stopping host (pid \(process.processIdentifier))")
        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.killAfter) {
            guard process.isRunning else { return }
            kill(pid, SIGKILL)
        }
    }

    /// Synchronous stop for quitting: SIGTERM, wait up to 3 s, then SIGKILL.
    func stopNow() {
        guard let process else { return }
        self.process = nil // its exit callback is ignored from here on
        generation += 1
        cancelTimers()
        guard process.isRunning else { return }
        let pid = process.processIdentifier
        log.mark("stopping host (pid \(pid))")
        process.terminate()
        let deadline = Date().addingTimeInterval(Self.killAfter)
        while process.isRunning && Date() < deadline { usleep(20_000) }
        if process.isRunning {
            kill(pid, SIGKILL)
            log.mark("host did not stop within \(Int(Self.killAfter)) s: killed")
        } else {
            log.mark("host stopped")
        }
        log.flush()
    }

    // ---- monitoring ----------------------------------------------------

    private func startMonitor() {
        monitorTimer?.invalidate()
        refreshStatus()
        let timer = Timer(timeInterval: Self.monitorInterval, repeats: true) { [weak self] _ in self?.monitorTick() }
        timer.tolerance = 1
        RunLoop.main.add(timer, forMode: .common)
        monitorTimer = timer
    }

    private func monitorTick() {
        refreshStatus()
        guard mode == .attached, phase == .running else { return }
        let gen = generation
        fetch(HostHealth.healthURL(port: port), timeout: 1.5) { [weak self] code, body in
            guard let self, gen == self.generation, self.mode == .attached else { return }
            if HostHealth.verdict(statusCode: code, body: body) == .windock {
                self.attachedMisses = 0
                return
            }
            self.attachedMisses += 1
            guard self.attachedMisses >= 2 else { return }
            // The host this app attached to went away: offer Restart, which
            // starts a host this app owns.
            self.cancelTimers()
            self.mode = .none
            self.phase = .problem(.exited, detail: "")
            self.status = nil
            self.statusKnown = false
            self.notify()
        }
    }

    /// Refreshes the address for the native menu and tooltip.
    func refreshStatus() {
        guard phase == .running else { return }
        let gen = generation
        fetch(HostHealth.statusURL(port: port), timeout: 1.5) { [weak self] code, body in
            guard let self, gen == self.generation, self.phase == .running else { return }
            let summary = code == 200 ? body.flatMap(HostStatusSummary.parse) : nil
            let known = summary != nil
            guard summary != self.status || known != self.statusKnown else { return }
            self.status = summary
            self.statusKnown = known
            self.delegate?.hostControllerStatusDidChange(self)
        }
    }

    private func locateNodeForFirewall() {
        guard nodePath == nil else { return }
        let override = settings.nodePathOverride
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let node = NodeLocator.live().locate(override: override)
            DispatchQueue.main.async {
                guard let self, self.nodePath == nil else { return }
                self.nodePath = node
                self.delegate?.hostControllerStatusDidChange(self)
            }
        }
    }

    private func cancelTimers() {
        monitorTimer?.invalidate()
        monitorTimer = nil
        slowWork?.cancel()
        slowWork = nil
    }

    private func notify() { delegate?.hostControllerDidChange(self) }

    private func fetch(_ url: URL, timeout: TimeInterval, completion: @escaping (Int?, Data?) -> Void) {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        session.dataTask(with: request) { data, response, _ in
            let code = (response as? HTTPURLResponse)?.statusCode
            DispatchQueue.main.async { completion(code, data) }
        }.resume()
    }
}
