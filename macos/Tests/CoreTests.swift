import XCTest

final class NodeLocatorTests: XCTestCase {
    func locator(_ executables: Set<String>, shell: String? = nil, shellCalls: UnsafeMutablePointer<Int>? = nil) -> NodeLocator {
        NodeLocator(isExecutable: { executables.contains($0) },
                    loginShellLookup: { shellCalls?.pointee += 1; return shell })
    }

    func testOverrideWinsWhenExecutable() {
        let l = locator(["/custom/node", "/opt/homebrew/bin/node"])
        XCTAssertEqual(l.locate(override: "/custom/node"), "/custom/node")
    }

    func testOverrideIgnoredWhenMissingOrRelative() {
        let l = locator(["/opt/homebrew/bin/node", "node"])
        XCTAssertEqual(l.locate(override: "/missing/node"), "/opt/homebrew/bin/node")
        XCTAssertEqual(l.locate(override: "node"), "/opt/homebrew/bin/node")
    }

    func testHomebrewBeforeUsrLocalBeforeShell() {
        var calls = 0
        withUnsafeMutablePointer(to: &calls) { ptr in
            XCTAssertEqual(locator(["/opt/homebrew/bin/node", "/usr/local/bin/node", "/x/node"], shell: "/x/node", shellCalls: ptr)
                .locate(override: nil), "/opt/homebrew/bin/node")
            XCTAssertEqual(locator(["/usr/local/bin/node", "/x/node"], shell: "/x/node", shellCalls: ptr)
                .locate(override: nil), "/usr/local/bin/node")
        }
        XCTAssertEqual(calls, 0, "the login shell is only asked when nothing else matched")
    }

    func testLoginShellFallback() {
        XCTAssertEqual(locator(["/Users/a/.nvm/versions/node/v22.1.0/bin/node"],
                               shell: "Welcome!\n/Users/a/.nvm/versions/node/v22.1.0/bin/node\n").locate(override: nil),
                       "/Users/a/.nvm/versions/node/v22.1.0/bin/node")
        XCTAssertNil(locator([], shell: "/nope/node").locate(override: nil), "shell answer must be executable")
        XCTAssertNil(locator([], shell: "node: aliased to foo").locate(override: nil))
        XCTAssertNil(locator([], shell: nil).locate(override: nil))
    }

    func testParseShellOutput() {
        XCTAssertEqual(NodeLocator.parseShellOutput("  /usr/bin/node  \n"), "/usr/bin/node")
        XCTAssertNil(NodeLocator.parseShellOutput(""))
        XCTAssertNil(NodeLocator.parseShellOutput("node"))
    }

    func testVersion() {
        XCTAssertEqual(NodeLocator.majorVersion("v26.8.1\n"), 26)
        XCTAssertTrue(NodeLocator.meetsMinimum("v20.0.0"))
        XCTAssertFalse(NodeLocator.meetsMinimum("v18.19.1"))
        XCTAssertFalse(NodeLocator.meetsMinimum("garbage"))
    }
}

final class HostLogTests: XCTestCase {
    var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("windock-log-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testWritesTimestampedLines() throws {
        let log = HostLog(directory: dir)
        log.writeSync(stream: "out", line: "WinDock host ready")
        log.close()
        let text = try String(contentsOf: dir.appendingPathComponent("host.log"), encoding: .utf8)
        XCTAssertTrue(text.hasSuffix(" [out] WinDock host ready\n"), text)
        XCTAssertNotNil(text.range(of: #"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} "#, options: .regularExpression))
    }

    func testRotatesAndKeepsThreeFiles() throws {
        let log = HostLog(directory: dir, maxBytes: 100, keep: 3)
        let line = String(repeating: "x", count: 60)
        for i in 0..<10 { log.writeSync(stream: "err", line: "\(i) \(line)") }
        log.close()
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted()
        XCTAssertEqual(names, ["host.1.log", "host.2.log", "host.log"])
        // Each file holds at most one line past the limit; the newest is in host.log.
        let newest = try String(contentsOf: dir.appendingPathComponent("host.log"), encoding: .utf8)
        XCTAssertTrue(newest.contains("9 xxx"), newest)
        let older = try String(contentsOf: dir.appendingPathComponent("host.1.log"), encoding: .utf8)
        XCTAssertTrue(older.contains("7 xxx") || older.contains("8 xxx"), older)
        for name in names {
            let size = try FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(name).path)[.size] as! UInt64
            XCTAssertLessThan(size, 100 + 120)
        }
    }

    func testAppendsToExistingLog() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "old\n".write(to: dir.appendingPathComponent("host.log"), atomically: true, encoding: .utf8)
        let log = HostLog(directory: dir)
        log.writeSync(stream: "app", line: "new")
        log.close()
        let text = try String(contentsOf: dir.appendingPathComponent("host.log"), encoding: .utf8)
        XCTAssertTrue(text.hasPrefix("old\n"))
        XCTAssertTrue(text.contains("[app] new"))
    }

    func testLineSplitter() {
        var s = LineSplitter()
        XCTAssertEqual(s.feed(Data("a\nb".utf8)), ["a"])
        XCTAssertEqual(s.feed(Data("c\r\n\n".utf8)), ["bc", ""])
        XCTAssertEqual(s.feed(Data("tail".utf8)), [])
        XCTAssertEqual(s.finish(), "tail")
        XCTAssertNil(s.finish())
    }

    func testErrorLine() {
        XCTAssertFalse(HostErrorLine.isMeaningful("Node.js v26.0.0"))
        XCTAssertFalse(HostErrorLine.isMeaningful("   "))
        let line = "WinDock failed to start: listen EADDRINUSE: address already in use :::8620"
        XCTAssertTrue(HostErrorLine.isMeaningful(line))
        XCTAssertTrue(HostErrorLine.isPortInUse(line))
        XCTAssertEqual(HostErrorLine.detail(line), "listen EADDRINUSE: address already in use :::8620")
    }
}

final class HostHealthTests: XCTestCase {
    func body(_ json: String) -> Data { Data(json.utf8) }

    func testWindockHostIsAttached() {
        let verdict = HostHealth.verdict(statusCode: 200, body: body(#"{"ok":true,"app":"windock","platform":"macos","api":1}"#))
        XCTAssertEqual(verdict, .windock)
        XCTAssertEqual(HostHealth.decide(verdict), .attach)
    }

    func testOtherAnswersMeanPortInUse() {
        for (code, json) in [(200, #"{"ok":true,"app":"other"}"#), (200, #"{"ok":1,"app":"windock"}"#),
                             (200, #"{"ok":"true","app":"windock"}"#), (200, "not json"), (200, "[1]"),
                             (404, #"{"ok":true,"app":"windock"}"#), (500, "")] {
            let verdict = HostHealth.verdict(statusCode: code, body: body(json))
            XCTAssertEqual(verdict, .other, json)
            XCTAssertEqual(HostHealth.decide(verdict), .portInUse)
        }
    }

    func testOversizedBodyIsNotWindock() {
        let padding = String(repeating: " ", count: 5000)
        XCTAssertEqual(HostHealth.verdict(statusCode: 200, body: body(#"{"ok":true,"app":"windock"}"# + padding)), .other)
    }

    func testNoAnswerSpawns() {
        XCTAssertEqual(HostHealth.verdict(statusCode: nil, body: nil), .none)
        XCTAssertEqual(HostHealth.decide(.none), .spawn)
    }

    func testStatusSummary() {
        let s = HostStatusSummary.parse(body(#"{"app":"windock","network":{"address":"192.168.1.34","port":8620},"firewall":"unknown"}"#))
        XCTAssertEqual(s, HostStatusSummary(address: "192.168.1.34", firewall: "unknown"))
        XCTAssertEqual(HostStatusSummary.parse(body(#"{"app":"windock","network":{"address":null}}"#))?.address, nil)
        XCTAssertNil(HostStatusSummary.parse(body(#"{"error":"not found"}"#)))
    }
}

final class BridgeTests: XCTestCase {
    let rules = BridgeRules(port: 8620)
    let host = FrameOrigin(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 8620)
    let offline = FrameOrigin(isMainFrame: true, scheme: "windock-offline", host: "offline", port: 0)

    func testOriginCheck() {
        XCTAssertEqual(rules.source(of: host), .host)
        XCTAssertEqual(rules.source(of: offline), .offline)
        var sub = host; sub.isMainFrame = false
        XCTAssertNil(rules.source(of: sub), "subframes are never trusted")
        XCTAssertNil(rules.source(of: FrameOrigin(isMainFrame: true, scheme: "http", host: "localhost", port: 8620)))
        XCTAssertNil(rules.source(of: FrameOrigin(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 8621)))
        XCTAssertNil(rules.source(of: FrameOrigin(isMainFrame: true, scheme: "https", host: "127.0.0.1", port: 8620)))
        XCTAssertNil(rules.source(of: FrameOrigin(isMainFrame: true, scheme: "http", host: "192.168.1.34", port: 8620)))
        XCTAssertNil(rules.source(of: FrameOrigin(isMainFrame: true, scheme: "https", host: "example.com", port: 443)))
    }

    func testMessages() {
        XCTAssertEqual(rules.message(["type": "ready"], from: host)?.1, .ready)
        XCTAssertEqual(rules.message(["type": "resize", "height": 512.4], from: host)?.1, .resize(height: 512.4))
        XCTAssertEqual(rules.message(["type": "loginItem.set", "enabled": true], from: host)?.1, .loginItemSet(enabled: true))
        XCTAssertEqual(rules.message(["type": "loginItem.set", "enabled": false], from: host)?.1, .loginItemSet(enabled: false))
        XCTAssertEqual(rules.message(["type": "loginItem.openSettings"], from: host)?.1, .loginItemOpenSettings)
        XCTAssertEqual(rules.message(["type": "openFirewallSettings"], from: host)?.1, .openFirewallSettings)
        XCTAssertEqual(rules.message(["type": "quit"], from: host)?.1, .quit)
        XCTAssertEqual(rules.message(["type": "restart"], from: host)?.1, .restart)
        XCTAssertEqual(rules.message(["type": "openWindow"], from: host)?.1, .openWindow)
        XCTAssertEqual(rules.message(["type": "openLogs"], from: host)?.1, .openLogs)
        XCTAssertEqual(rules.message(["type": "close"], from: host)?.1, .close)
    }

    func testMalformedMessagesAreDropped() {
        XCTAssertNil(rules.message("ready", from: host))
        XCTAssertNil(rules.message(["kind": "ready"], from: host))
        XCTAssertNil(rules.message(["type": "checkUpdates"], from: host), "macOS has no updates yet")
        XCTAssertNil(rules.message(["type": "openUrl", "url": "file:///etc/passwd"], from: host))
        XCTAssertNil(rules.message(["type": "resize"], from: host))
        XCTAssertNil(rules.message(["type": "resize", "height": "400"], from: host))
        XCTAssertNil(rules.message(["type": "resize", "height": -1], from: host))
        XCTAssertNil(rules.message(["type": "resize", "height": Double.nan], from: host))
        XCTAssertNil(rules.message(["type": "resize", "height": true], from: host))
        XCTAssertNil(rules.message(["type": "loginItem.set", "enabled": 1], from: host), "1 is not a boolean")
        XCTAssertNil(rules.message(["type": "loginItem.set", "enabled": "true"], from: host))
        XCTAssertNil(rules.message(["type": "getNode"], from: host), "getNode is the offline page's")
    }

    func testOfflinePageGetsOnlyItsActions() {
        for type in ["ready", "close", "openLogs", "restart", "quit", "getNode"] {
            XCTAssertNotNil(rules.message(["type": type], from: offline), type)
        }
        XCTAssertNotNil(rules.message(["type": "resize", "height": 300], from: offline))
        for type in ["openWindow", "openFirewallSettings", "loginItem.openSettings"] {
            XCTAssertNil(rules.message(["type": type], from: offline), type)
        }
        XCTAssertNil(rules.message(["type": "loginItem.set", "enabled": true], from: offline))
    }

    func testMessagesFromForeignFramesAreDropped() {
        let evil = FrameOrigin(isMainFrame: true, scheme: "https", host: "evil.example", port: 443)
        XCTAssertNil(rules.message(["type": "quit"], from: evil))
        var sub = host; sub.isMainFrame = false
        XCTAssertNil(rules.message(["type": "quit"], from: sub))
    }

    func testNavigation() {
        let u = { (s: String) in URL(string: s)! }
        XCTAssertEqual(rules.navigation(to: u("http://127.0.0.1:8620/host"), userInitiated: false), .allow)
        XCTAssertEqual(rules.navigation(to: u("http://127.0.0.1:8620/host/"), userInitiated: false), .allow)
        XCTAssertEqual(rules.navigation(to: u("http://127.0.0.1:8620/host/x?y=1#z"), userInitiated: false), .allow)
        XCTAssertEqual(rules.navigation(to: u("windock-offline://offline/?r=2"), userInitiated: false), .allow)
        XCTAssertEqual(rules.navigation(to: u("windock-offline://other/"), userInitiated: false), .block)
        XCTAssertEqual(rules.navigation(to: u("http://127.0.0.1:8620/hostile"), userInitiated: false), .block)
        XCTAssertEqual(rules.navigation(to: u("http://127.0.0.1:8620/api/host/status"), userInitiated: false), .block)
        XCTAssertEqual(rules.navigation(to: u("http://127.0.0.1:8620/host/../api"), userInitiated: false), .block)
        XCTAssertEqual(rules.navigation(to: u("http://localhost:8620/host"), userInitiated: false), .block)
        XCTAssertEqual(rules.navigation(to: u("http://user:pw@127.0.0.1:8620/host"), userInitiated: false), .block)
        XCTAssertEqual(rules.navigation(to: u("https://nodejs.org/"), userInitiated: true), .openExternally(u("https://nodejs.org/")))
        XCTAssertEqual(rules.navigation(to: u("https://nodejs.org/"), userInitiated: false), .block, "no redirects into the browser")
        XCTAssertEqual(rules.navigation(to: u("file:///etc/passwd"), userInitiated: true), .block)
        XCTAssertEqual(rules.navigation(to: u("mailto:a@b.c"), userInitiated: true), .block)
        XCTAssertEqual(rules.navigation(to: u("about:blank"), userInitiated: false), .block)
        XCTAssertEqual(rules.navigation(to: nil, userInitiated: true), .block)
    }

    func testShellScript() throws {
        let script = rules.shellScript(container: .popover, version: "0.2.2", capabilities: .init(restart: true))
        XCTAssertTrue(script.contains("l.host==='127.0.0.1:8620'"))
        XCTAssertTrue(script.contains("windock-offline:"))
        let json = try XCTUnwrap(script.range(of: #"var s=(\{.*?\});Object"#, options: .regularExpression)).lowerBound
        let start = script.index(json, offsetBy: 6)
        let end = try XCTUnwrap(script.range(of: ";Object.freeze(s.capabilities)")).lowerBound
        let object = try JSONSerialization.jsonObject(with: Data(script[start..<end].utf8)) as! [String: Any]
        XCTAssertEqual(object["os"] as? String, "macos")
        XCTAssertEqual(object["container"] as? String, "popover")
        XCTAssertEqual(object["version"] as? String, "0.2.2")
        let caps = object["capabilities"] as! [String: Bool]
        XCTAssertEqual(caps, ["loginItem": true, "quit": true, "restart": true, "logs": true, "updates": false,
                              "openWindow": true, "firewallSettings": true])
        let attached = rules.shellScript(container: .window, version: "1", capabilities: .init(restart: false))
        XCTAssertTrue(attached.contains(#""restart":false"#))
        XCTAssertTrue(attached.contains(#""container":"window""#))
    }

    func testEventScript() {
        XCTAssertEqual(BridgeRules.eventScript(["type": "visibility", "visible": true]),
                       #"window.dispatchEvent(new CustomEvent('windockshell',{detail:{"type":"visibility","visible":true}}));"#)
        // Quotes and script terminators are JSON-escaped.
        let script = BridgeRules.eventScript(["type": "x", "v": "</script>'\""])!
        XCTAssertTrue(script.contains(#"<\/script>'\""#), script)
    }

    func testPopoverHeightClamp() {
        XCTAssertEqual(PopoverLayout.height(requested: 100, visibleHeight: 1000), 320)
        XCTAssertEqual(PopoverLayout.height(requested: 512.2, visibleHeight: 1000), 513)
        XCTAssertEqual(PopoverLayout.height(requested: 2000, visibleHeight: 1000), 680)
        XCTAssertEqual(PopoverLayout.height(requested: 2000, visibleHeight: 600), 560)
        XCTAssertEqual(PopoverLayout.height(requested: 100, visibleHeight: 300), 260, "tiny screens: the screen wins")
    }
}

final class FirewallAndOfflineTests: XCTestCase {
    func testFirewall() {
        XCTAssertEqual(Firewall.evaluate(globalState: "Firewall is disabled. (State = 0)", blockAll: nil, appBlocked: nil), .ok)
        let on = "Firewall is enabled. (State = 1)"
        XCTAssertEqual(Firewall.evaluate(globalState: on, blockAll: "Firewall has block all state set to disabled.",
                                         appBlocked: "Incoming connection to /opt/homebrew/Cellar/node/26.0.0/bin/node is permitted."), .ok)
        XCTAssertEqual(Firewall.evaluate(globalState: on, blockAll: "Firewall has block all state set to enabled.",
                                         appBlocked: "Incoming connection to /x/node is permitted."), .blocked)
        XCTAssertEqual(Firewall.evaluate(globalState: on, blockAll: "Firewall has block all state set to disabled.",
                                         appBlocked: "Incoming connection to /x/node is blocked."), .blocked)
        XCTAssertEqual(Firewall.evaluate(globalState: on, blockAll: "Firewall has block all state set to disabled.",
                                         appBlocked: "The application is not part of the firewall"), .unknown)
        XCTAssertEqual(Firewall.evaluate(globalState: "Firewall is blocking all non-essential incoming connections. (State = 2)",
                                         blockAll: nil, appBlocked: nil), .blocked)
        XCTAssertEqual(Firewall.evaluate(globalState: nil, blockAll: nil, appBlocked: nil), .unknown)
        XCTAssertEqual(Firewall.evaluate(globalState: on, blockAll: nil, appBlocked: nil), .unknown)
    }

    func testOfflinePageVariants() {
        let port = OfflinePage.render(.portInUse, port: 8620, detail: "listen EADDRINUSE <x>", container: .popover)
        XCTAssertTrue(port.contains("Port 8620 is in use"))
        XCTAssertTrue(port.contains("listen EADDRINUSE &lt;x&gt;"), "detail is escaped")
        XCTAssertTrue(port.contains(#"data-msg="restart">Try again"#))
        XCTAssertTrue(port.contains("Phones can’t connect until WinDock is running."))
        let node = OfflinePage.render(.nodeMissing, port: 8620, detail: "", container: .window)
        XCTAssertTrue(node.contains("Node.js isn’t installed"))
        XCTAssertTrue(node.contains(#"data-msg="getNode">Get Node.js"#))
        XCTAssertTrue(node.contains(#"data-container="window""#))
        let starting = OfflinePage.render(.starting, port: 8620, detail: "ignored", container: .popover)
        XCTAssertTrue(starting.contains("Starting WinDock…"))
        XCTAssertFalse(starting.contains("ignored"))
        XCTAssertFalse(starting.contains("Phones can’t connect"))
        let exited = OfflinePage.render(.exited, port: 8620, detail: "boom", container: .popover)
        XCTAssertTrue(exited.contains("WinDock stopped unexpectedly"))
        XCTAssertTrue(exited.contains(#"data-msg="restart">Restart"#))
    }
}
