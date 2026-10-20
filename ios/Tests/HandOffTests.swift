import XCTest
import WebKit
@testable import WinDock

/// Set-Cookie → HTTPCookie hand-off, `/api/auth` outcomes, TXT parsing and bridge validation.
final class HandOffTests: XCTestCase {
    private let url = URL(string: "https://192.168.1.20:8620/api/auth")!

    // MARK: Session cookie

    func testHostSessionCookieKeepsEveryAttributeAndTheExactHost() throws {
        // As the host's sessionCookie() writes it over HTTPS.
        let header = "windock_session=abc%2Fdef; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000; Secure"
        let cookies = SessionCookies.cookies(fromHeaders: ["Set-Cookie": header], url: url)
        let cookie = try XCTUnwrap(cookies.first)
        XCTAssertEqual(cookies.count, 1)
        XCTAssertEqual(cookie.name, "windock_session")
        XCTAssertEqual(cookie.value, "abc%2Fdef")
        XCTAssertEqual(cookie.domain, "192.168.1.20", "Host-only: the exact address, never a wider domain")
        XCTAssertEqual(cookie.path, "/")
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertTrue(cookie.isSecure)
        XCTAssertEqual(cookie.sameSitePolicy, .sameSiteLax)
        let expires = try XCTUnwrap(cookie.expiresDate)
        XCTAssertEqual(expires.timeIntervalSinceNow, 15_552_000, accuracy: 60, "Max-Age=180 days becomes an expiry date")
        XCTAssertFalse(cookie.isSessionOnly, "Survives relaunching the app")
    }

    func testPlainHttpCookieIsNotSecureAndHeaderCaseDoesNotMatter() throws {
        let plain = URL(string: "http://10.0.0.5:8620/api/auth")!
        let cookies = SessionCookies.cookies(fromHeaders: ["set-cookie": "windock_session=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=60"], url: plain)
        let cookie = try XCTUnwrap(cookies.first)
        XCTAssertFalse(cookie.isSecure)
        XCTAssertEqual(cookie.domain, "10.0.0.5")
    }

    func testOnlyTheSessionCookieIsTaken() {
        XCTAssertTrue(SessionCookies.cookies(fromHeaders: ["Set-Cookie": "tracker=1; Path=/"], url: url).isEmpty)
        XCTAssertTrue(SessionCookies.cookies(fromHeaders: [:], url: url).isEmpty)
    }

    func testMovingTheSessionToANewAddressKeepsAttributes() throws {
        let original = try XCTUnwrap(SessionCookies.cookies(fromHeaders: ["Set-Cookie": "windock_session=v; Path=/; HttpOnly; Max-Age=600; Secure"], url: url).first)
        let moved = try XCTUnwrap(SessionCookies.scoped(original, toHost: "192.168.1.47"))
        XCTAssertEqual(moved.domain, "192.168.1.47")
        XCTAssertEqual(moved.value, "v")
        XCTAssertTrue(moved.isHTTPOnly)
        XCTAssertTrue(moved.isSecure)
        XCTAssertEqual(moved.expiresDate, original.expiresDate)
        XCTAssertTrue(SessionCookies.matches(moved, host: "192.168.1.47"))
        XCTAssertFalse(SessionCookies.matches(moved, host: "192.168.1.20"))
    }

    func testAuthOutcomes() {
        let ok = PairingAPI.classify(status: 200, body: Data(#"{"ok":true}"#.utf8),
                                     headers: ["Set-Cookie": "windock_session=t; Path=/; HttpOnly; Max-Age=60; Secure"], url: url)
        guard case .paired(let cookies) = ok else { return XCTFail("Expected paired, got \(ok)") }
        XCTAssertEqual(cookies.first?.value, "t")
        XCTAssertEqual(PairingAPI.classify(status: 200, body: Data(), headers: [:], url: url), .failed, "200 without a session cookie is not paired")
        XCTAssertEqual(PairingAPI.classify(status: 401, body: Data(#"{"error":"wrong pin","locked":false}"#.utf8), headers: [:], url: url), .wrongPin)
        XCTAssertEqual(PairingAPI.classify(status: 429, body: Data(#"{"error":"locked","retryInMs":48000}"#.utf8), headers: [:], url: url),
                       .locked(retryInMs: 48000))
        XCTAssertEqual(PairingAPI.classify(status: 429, body: Data(), headers: [:], url: url), .locked(retryInMs: 60000))
        XCTAssertEqual(PairingAPI.classify(status: 403, body: Data(#"{"error":"pairing closed"}"#.utf8), headers: [:], url: url), .closed)
        XCTAssertEqual(PairingAPI.classify(status: 403, body: Data(#"{"error":"bad origin"}"#.utf8), headers: [:], url: url), .failed)
        XCTAssertEqual(PairingAPI.classify(status: 400, body: Data(#"{"error":"invalid pin"}"#.utf8), headers: [:], url: url), .invalid)
        XCTAssertEqual(PairingAPI.classify(status: 500, body: Data(), headers: [:], url: url), .failed)
    }

    func testPinnedClientRefusesHttpsWithoutAPin() {
        let client = PinnedClient(endpoint: URL(string: "https://192.168.1.20:8620")!, fingerprint: nil)
        let done = expectation(description: "refused")
        client.send(method: "POST", path: "api/auth", json: ["pin": "123456"]) { result in
            if case .failure(.untrusted) = result { done.fulfill() }
        }
        wait(for: [done], timeout: 1)
    }

    // MARK: Bonjour TXT

    func testTxtRecordParsing() {
        let txt = BonjourTXT(["id": "3F2A9C01-B7E4-4D5E-8A10-0123456789AB", "api": "1", "tls": "1", "addr": "192.168.1.20",
                              "name": "DESKTOP-7H2KQ9L", "os": "windows"])
        XCTAssertEqual(txt, BonjourTXT(id: "3f2a9c01-b7e4-4d5e-8a10-0123456789ab", api: "1", tls: true, addr: "192.168.1.20",
                                       name: "DESKTOP-7H2KQ9L", os: "windows"))
        XCTAssertEqual(BonjourTXT(["OS": "macos", "TLS": "0"]).os, "macos", "Keys are case-insensitive")
        XCTAssertEqual(BonjourTXT(["tls": "0"]).tls, false)
    }

    func testTxtRecordRejectsUnsafeHints() {
        let txt = BonjourTXT(["id": "../etc", "api": "one", "tls": "yes", "addr": "8.8.8.8", "name": "\u{0007}  ", "os": "beos"])
        XCTAssertEqual(txt, BonjourTXT())
        XCTAssertNil(BonjourTXT(["addr": "localhost"]).addr)
        XCTAssertNil(BonjourTXT(["addr": "192.168.1.300"]).addr)
        XCTAssertEqual(BonjourTXT(["name": String(repeating: "n", count: 80)]).name?.count, 60)
        XCTAssertEqual(BonjourTXT(["addr": "10.0.0.7"]).addr, "10.0.0.7")
    }

    func testPolicyDeniedIsDetected() {
        XCTAssertTrue(BonjourDiscovery.isPolicyDenied(.dns(-65570)))
        XCTAssertFalse(BonjourDiscovery.isPolicyDenied(.dns(-65537)))
        XCTAssertFalse(BonjourDiscovery.isPolicyDenied(.posix(.ECONNREFUSED)))
    }

    // MARK: Bridge

    func testBridgeMessages() {
        XCTAssertEqual(NativeBridge.parse(["type": "switch"]), .switchComputer)
        XCTAssertEqual(NativeBridge.parse(["type": "ready", "switcher": true]), .ready(switcher: true))
        XCTAssertEqual(NativeBridge.parse(["type": "ready"]), .ready(switcher: false))
        XCTAssertEqual(NativeBridge.parse(["type": "unauthorized"]), .unauthorized)
        XCTAssertNil(NativeBridge.parse(["type": "launch", "id": "x"]), "Unknown types are ignored")
        XCTAssertNil(NativeBridge.parse("switch"))
        XCTAssertNil(NativeBridge.parse(["kind": "switch"]))
        XCTAssertNil(NativeBridge.parse(["type": 1]))
    }

    func testBridgeOriginMustBeTheSelectedEndpoint() {
        let endpoint = URL(string: "https://192.168.1.20:8620")!
        XCTAssertTrue(NativeBridge.originMatches(scheme: "https", host: "192.168.1.20", port: 8620, endpoint: endpoint))
        XCTAssertFalse(NativeBridge.originMatches(scheme: "http", host: "192.168.1.20", port: 8620, endpoint: endpoint))
        XCTAssertFalse(NativeBridge.originMatches(scheme: "https", host: "192.168.1.21", port: 8620, endpoint: endpoint))
        XCTAssertFalse(NativeBridge.originMatches(scheme: "https", host: "192.168.1.20", port: 8621, endpoint: endpoint))
        let standard = URL(string: "https://192.168.1.20")!
        XCTAssertTrue(NativeBridge.originMatches(scheme: "https", host: "192.168.1.20", port: 0, endpoint: standard), "Port 0 means the default port")
    }

    func testUserScriptCarriesTheNameAsJson() throws {
        let source = NativeBridge.userScriptSource(computerName: #"Studio "PC" </script>"#)
        XCTAssertTrue(source.contains(#""platform":"ios""#))
        XCTAssertTrue(source.contains(#""switcher":true"#))
        XCTAssertTrue(source.contains(#"Studio \"PC\""#), "The name is JSON-escaped, never spliced raw")
        XCTAssertTrue(source.contains(#"new Event("windock-native-ready")"#))
    }

    @MainActor
    func testUserScriptRunsInAWebView() async throws {
        let config = WKWebViewConfiguration()
        config.userContentController.addUserScript(WKUserScript(source: NativeBridge.userScriptSource(computerName: "Studio PC"),
                                                                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let web = WKWebView(frame: .zero, configuration: config)
        let loaded = expectation(description: "loaded")
        let delegate = LoadDelegate { loaded.fulfill() }
        web.navigationDelegate = delegate
        web.loadHTMLString("<script>window.sawReady = !!window.WinDockNative;</script>", baseURL: URL(string: "https://192.168.1.20:8620/"))
        await fulfillment(of: [loaded], timeout: 10)
        let name = try await web.evaluateJavaScript("window.WinDockNative.computerName + '|' + window.WinDockNative.platform + '|' + window.sawReady")
        XCTAssertEqual(name as? String, "Studio PC|ios|true")
        _ = delegate
    }
}

@MainActor
private final class LoadDelegate: NSObject, WKNavigationDelegate {
    let done: () -> Void
    init(_ done: @escaping () -> Void) { self.done = done }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done() }
}
