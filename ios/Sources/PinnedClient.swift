import Foundation
import WebKit

/// Native requests to one host over https that only ever trust the pinned certificate (the same
/// rule as `HealthProbe` and the dock's WebView), or over plain http for very old hosts without TLS.
/// Cookie-free: the caller passes any cookie explicitly and reads `Set-Cookie` itself.
final class PinnedClient: NSObject, URLSessionTaskDelegate {
    struct Response {
        let status: Int
        let headers: [String: String]
        let body: Data
        let url: URL
    }

    enum Failure: Error { case untrusted, network(ProbeFailure), tooLarge }

    let endpoint: URL
    let fingerprint: String?
    private var session: URLSession?

    init(endpoint: URL, fingerprint: String?) {
        self.endpoint = endpoint
        self.fingerprint = fingerprint
        super.init()
    }

    func send(method: String, path: String, json: [String: Any]? = nil, cookie: HTTPCookie? = nil,
              timeout: TimeInterval = 8, completion: @escaping (Result<Response, Failure>) -> Void) {
        // Never trust-all: an https endpoint without a pin gets no native request.
        guard endpoint.scheme == "http" || fingerprint != nil else { completion(.failure(.untrusted)); return }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.waitsForConnectivity = false
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.httpCookieStorage = nil
        config.urlCache = nil
        let session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        self.session = session
        var request = URLRequest(url: endpoint.appendingPathComponent(path))
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // No Origin header: the host only checks same-origin when one is present.
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        if let cookie { request.setValue("\(cookie.name)=\(cookie.value)", forHTTPHeaderField: "Cookie") }
        session.dataTask(with: request) { [weak self] data, response, error in
            self?.session?.finishTasksAndInvalidate()
            self?.session = nil
            guard error == nil, let http = response as? HTTPURLResponse, let url = http.url else {
                completion(.failure(.network(HealthProbe.classify(error) ?? .other))); return
            }
            let body = data ?? Data()
            guard body.count <= 65_536 else { completion(.failure(.tooLarge)); return }
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String, let value = value as? String { headers[key] = value }
            }
            completion(.success(Response(status: http.statusCode, headers: headers, body: body, url: url)))
        }.resume()
    }

    func cancel() {
        session?.invalidateAndCancel()
        session = nil
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil); return
        }
        guard endpoint.scheme == "https", let fingerprint,
              space.host.lowercased() == endpoint.host, space.port == EndpointPolicy.effectivePort(endpoint),
              let trust = space.serverTrust, CertificatePin.matches(CertificatePin.leafFingerprint(trust), fingerprint) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// `POST /api/auth` outcomes (docs/PROTOCOL.md, Pairing).
enum AuthOutcome: Equatable {
    case paired([HTTPCookie])
    case wrongPin
    case locked(retryInMs: Int)
    case closed
    case invalid
    case failed
}

enum PairingAPI {
    /// iOS 16+ withholds the device's own name without an entitlement (spec section 12).
    static func deviceName(isPad: Bool) -> String { isPad ? "iPad" : "iPhone" }

    static func classify(status: Int, body: Data, headers: [String: String], url: URL) -> AuthOutcome {
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let error = object?["error"] as? String
        switch status {
        case 200:
            let cookies = SessionCookies.cookies(fromHeaders: headers, url: url)
            return cookies.isEmpty ? .failed : .paired(cookies)
        case 401: return .wrongPin
        case 429:
            let retry = (object?["retryInMs"] as? NSNumber)?.intValue ?? 60_000
            return .locked(retryInMs: max(1000, min(retry, 3_600_000)))
        case 403 where error == "pairing closed": return .closed
        case 400 where error == "invalid pin": return .invalid
        default: return .failed
        }
    }

    static func authenticate(client: PinnedClient, pin: String, deviceName: String,
                             completion: @escaping (AuthOutcome) -> Void) {
        client.send(method: "POST", path: "api/auth", json: ["pin": pin, "deviceName": deviceName]) { result in
            switch result {
            case .success(let response):
                completion(classify(status: response.status, body: response.body, headers: response.headers, url: response.url))
            case .failure:
                completion(.failed)
            }
        }
    }
}

/// The host's `windock_session` cookie, moved between native requests and the WebView store.
enum SessionCookies {
    static let name = "windock_session"

    /// Session cookies from a response's `Set-Cookie`, scoped to the exact host (no domain
    /// widening), keeping HttpOnly, Secure, path, SameSite and expiry.
    static func cookies(fromHeaders headers: [String: String], url: URL) -> [HTTPCookie] {
        guard let host = url.host?.lowercased() else { return [] }
        var fields: [String: String] = [:]
        for (key, value) in headers where key.lowercased() == "set-cookie" { fields["Set-Cookie"] = value }
        guard !fields.isEmpty else { return [] }
        return HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
            .filter { $0.name == name }
            .compactMap { scoped($0, toHost: host) }
    }

    /// The same cookie bound to `host` exactly, with every attribute preserved.
    static func scoped(_ cookie: HTTPCookie, toHost host: String) -> HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: cookie.name,
            .value: cookie.value,
            .domain: host.lowercased(),
            .path: cookie.path.isEmpty ? "/" : cookie.path
        ]
        if let expires = cookie.expiresDate { properties[.expires] = expires }
        if cookie.isSecure { properties[.secure] = "TRUE" }
        if cookie.isHTTPOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        if let policy = cookie.sameSitePolicy { properties[.sameSitePolicy] = policy }
        return HTTPCookie(properties: properties)
    }

    static func matches(_ cookie: HTTPCookie, host: String) -> Bool {
        cookie.name == name && cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) == host.lowercased()
    }

    /// Calls `completion` once: with the result, or with `fallback` if WebKit has not answered in
    /// time, so a stalled cookie store never leaves a screen waiting.
    static func once<T>(timeout: TimeInterval = 5, fallback: T, _ completion: @escaping (T) -> Void) -> (T) -> Void {
        var done = false
        let finish: (T) -> Void = { value in
            DispatchQueue.main.async {
                guard !done else { return }
                done = true
                completion(value)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(fallback) }
        return finish
    }

    /// Sets every cookie and calls back once WebKit has stored all of them.
    static func set(_ cookies: [HTTPCookie], in store: WKHTTPCookieStore, completion: @escaping () -> Void) {
        let finish = once(fallback: ()) { completion() }
        let group = DispatchGroup()
        for cookie in cookies {
            group.enter()
            store.setCookie(cookie) { group.leave() }
        }
        group.notify(queue: .main) { finish(()) }
    }

    static func session(for host: String, in store: WKHTTPCookieStore, completion: @escaping (HTTPCookie?) -> Void) {
        let finish = once(fallback: nil as HTTPCookie?, completion)
        store.getAllCookies { cookies in
            let match = cookies.filter { matches($0, host: host) }
                .max { ($0.expiresDate ?? .distantFuture) < ($1.expiresDate ?? .distantFuture) }
            finish(match)
        }
    }

    /// The computer moved to a new address: the same session works there (one host, one store).
    static func copySession(from oldHost: String, to newHost: String, in store: WKHTTPCookieStore,
                            completion: @escaping (Bool) -> Void) {
        guard oldHost.lowercased() != newHost.lowercased() else { completion(true); return }
        let finish = once(fallback: false, completion)
        session(for: oldHost, in: store) { cookie in
            guard let cookie, let moved = scoped(cookie, toHost: newHost) else { finish(false); return }
            store.setCookie(moved) { finish(true) }
        }
    }

    /// Removes every cookie WinDock's host set for `host`.
    static func removeAll(for host: String, in store: WKHTTPCookieStore, completion: @escaping () -> Void) {
        let finish = once(fallback: ()) { completion() }
        store.getAllCookies { cookies in
            let doomed = cookies.filter { $0.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) == host.lowercased() }
            let group = DispatchGroup()
            for cookie in doomed {
                group.enter()
                store.delete(cookie) { group.leave() }
            }
            group.notify(queue: .main) { finish(()) }
        }
    }
}
