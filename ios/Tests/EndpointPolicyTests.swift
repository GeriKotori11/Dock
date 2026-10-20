import XCTest
@testable import WinDock

final class EndpointPolicyTests: XCTestCase {
    func testLocalAddressesAndDefaultPorts() {
        let valid = [
            "192.168.1.20": "http://192.168.1.20:8620",
            " 10.2.3.4:9000 ": "http://10.2.3.4:9000",
            "172.16.0.1": "http://172.16.0.1:8620",
            "172.31.255.254": "http://172.31.255.254:8620",
            "http://192.168.1.20/": "http://192.168.1.20",
            "https://192.168.1.20:9443": "https://192.168.1.20:9443",
            "localhost": "http://localhost:8620",
            "127.0.0.1:18622": "http://127.0.0.1:18622"
        ]
        for (input, expected) in valid { XCTAssertEqual(EndpointPolicy.normalize(input)?.absoluteString, expected, input) }
    }

    func testRejectsAmbiguousOrPublicAddresses() {
        let invalid = ["", "example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1",
                       "256.1.1.1", "192.168.001.1", "0xc0a80101", "3232235777", "192.168.1",
                       "http://user@192.168.1.1", "http://192.168.1.1.evil.com", "http://[::1]",
                       "file:///tmp/test", "javascript:alert(1)", "ftp://192.168.1.1",
                       "192.168.1.1/path", "192.168.1.1?x=1", "192.168.1.1#foo", "192.168.1.1:0",
                       "192.168.1.1:65536", "192.168.1.1:", "http://192.168.1.1:",
                       "http://192.168.1.1\\@evil.com", "http://%31%32%37.0.0.1", "http://192.168.1.1\n/",
                       String(repeating: "a", count: 201)]
        XCTAssertNil(EndpointPolicy.normalize(nil))
        for input in invalid { XCTAssertNil(EndpointPolicy.normalize(input), input) }
    }

    func testNavigationStaysOnSelectedOrigin() throws {
        let endpoint = try XCTUnwrap(EndpointPolicy.normalize("192.168.1.20"))
        XCTAssertTrue(EndpointPolicy.allows(URL(string: "http://192.168.1.20:8620/api/apps/icon?id=a"), endpoint: endpoint))
        for input in ["http://192.168.1.21:8620/", "https://192.168.1.20:8620/", "http://192.168.1.20/",
                      "http://user@192.168.1.20:8620/", "file:///tmp/a", "javascript:alert(1)", "data:text/html,hello"] {
            XCTAssertFalse(EndpointPolicy.allows(URL(string: input), endpoint: endpoint), input)
        }
        let standard = try XCTUnwrap(EndpointPolicy.normalize("http://localhost"))
        XCTAssertTrue(EndpointPolicy.allows(URL(string: "http://localhost:80/a"), endpoint: standard))
        XCTAssertFalse(EndpointPolicy.allows(nil, endpoint: endpoint))
    }

    func testSecureOriginAllowsHttpsAndWssOnly() throws {
        let plain = try XCTUnwrap(EndpointPolicy.normalize("192.168.1.20"))
        let secure = try XCTUnwrap(EndpointPolicy.with(scheme: "https", plain))
        XCTAssertEqual(secure.absoluteString, "https://192.168.1.20:8620")
        XCTAssertEqual(EndpointPolicy.with(scheme: "http", secure), plain)
        XCTAssertEqual(EndpointPolicy.with(scheme: "https", try XCTUnwrap(URL(string: "http://192.168.1.20")))?.absoluteString,
                       "https://192.168.1.20:80", "Same port for both schemes")
        XCTAssertTrue(EndpointPolicy.allows(URL(string: "https://192.168.1.20:8620/api/apps"), endpoint: secure))
        for input in ["http://192.168.1.20:8620/", "https://192.168.1.21:8620/", "https://192.168.1.20:8621/",
                      "https://user@192.168.1.20:8620/"] {
            XCTAssertFalse(EndpointPolicy.allows(URL(string: input), endpoint: secure), input)
        }
        let rules = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(EndpointPolicy.contentRules(for: secure).utf8)) as? [[String: Any]])
        let filters = rules.compactMap { ($0["trigger"] as? [String: Any])?["url-filter"] as? String }
        XCTAssertTrue(filters.contains("^https://192[.]168[.]1[.]20:8620/"))
        XCTAssertTrue(filters.contains("^wss://192[.]168[.]1[.]20:8620/"))
        XCTAssertFalse(filters.contains { $0.hasPrefix("^http://") || $0.hasPrefix("^ws://") }, "No plain origin for an https dock")
        for (pattern, url, expected) in [("^https://192[.]168[.]1[.]20:8620/", "https://192.168.1.20:8620/app.js", true),
                                         ("^wss://192[.]168[.]1[.]20:8620/", "wss://192.168.1.20:8620/input", true),
                                         ("^https://192[.]168[.]1[.]20:8620/", "https://192.168.1.20:86200/", false)] {
            let regex = try NSRegularExpression(pattern: pattern)
            XCTAssertEqual(regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil, expected, url)
        }
    }

    func testHealthRequiresBoundedWinDockMarker() {
        XCTAssertTrue(HealthProbe.isWinDock(Data(#"{"ok":true,"app":"windock"}"#.utf8)))
        for input in [#"{"ok":true,"app":"other"}"#, #"{"app":"windock"}"#, #"{"ok":false,"app":"windock"}"#,
                      #"[{"ok":true,"app":"windock"}]"#, "not json", String(repeating: " ", count: 4097)] {
            XCTAssertFalse(HealthProbe.isWinDock(Data(input.utf8)))
        }
    }
}
