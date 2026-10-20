import Foundation

/// What a WinDock `/health` body says about the host. Over plain HTTP every field is only a hint.
struct HealthInfo: Equatable {
    let hostId: String?
    let hostName: String
    let tlsFingerprint: String?
}

/// The result of one probe. `presentedFingerprint` is the leaf certificate the TLS handshake
/// actually presented (https only), recorded even when the probe then refused it.
struct ProbeResult {
    let info: HealthInfo?
    let presentedFingerprint: String?
}

/// A bounded, cookie-free probe. Redirects never select a different host for the user.
final class HealthProbe: NSObject, URLSessionDataDelegate {
    private var session: URLSession?
    private var completion: ((ProbeResult) -> Void)?
    private var body = Data()
    private var validResponse = false
    private var target: URL?
    private var pinned: String?
    private var presented: String?

    /// For an https `endpoint`, the handshake certificate is accepted only for this probe's host and
    /// port, and only when it equals `pinned` or when there is no pin yet (captured for confirmation).
    func start(endpoint: URL, pinned: String? = nil, completion: @escaping (ProbeResult) -> Void) {
        cancel()
        self.completion = completion
        body = Data()
        validResponse = false
        target = endpoint
        self.pinned = pinned
        presented = nil
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 20
        config.waitsForConnectivity = true
        config.httpShouldSetCookies = false
        config.urlCache = nil
        let session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        self.session = session
        session.dataTask(with: endpoint.appendingPathComponent("health")).resume()
    }

    func cancel() {
        completion = nil
        session?.invalidateAndCancel()
        session = nil
    }

    private func finish(_ success: Bool) {
        let callback = completion
        let result = ProbeResult(info: success ? Self.parse(body) : nil, presentedFingerprint: presented)
        cancel()
        callback?(result)
    }

    static func parse(_ body: Data) -> HealthInfo? {
        guard body.count <= 4096,
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              object["app"] as? String == "windock", object["ok"] as? Bool == true else { return nil }
        let tls = object["tls"] as? [String: Any]
        return HealthInfo(hostId: object["hostId"] as? String,
                          hostName: object["hostName"] as? String ?? "",
                          tlsFingerprint: tls?["fingerprint"] as? String)
    }

    static func isWinDock(_ body: Data) -> Bool { parse(body) != nil }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil); return
        }
        guard session === self.session, let target, target.scheme == "https",
              space.host.lowercased() == target.host, space.port == EndpointPolicy.effectivePort(target),
              let trust = space.serverTrust, let fingerprint = CertificatePin.leafFingerprint(trust) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        presented = fingerprint
        if pinned == nil || pinned == fingerprint {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard session === self.session else { completionHandler(.cancel); return }
        validResponse = (response as? HTTPURLResponse)?.statusCode == 200 && response.expectedContentLength <= 4096
        completionHandler(validResponse ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard session === self.session else { return }
        guard body.count + data.count <= 4096 else { finish(false); return }
        body.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard session === self.session else { return }
        finish(error == nil && validResponse && Self.isWinDock(body))
    }
}
