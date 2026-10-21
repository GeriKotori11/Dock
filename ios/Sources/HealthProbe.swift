import Foundation

/// What a WinDock `/health` body says about the host. Over plain HTTP (or an https
/// connection whose certificate is not the pinned one) every field is only a hint.
struct HealthInfo: Equatable {
    let hostId: String?
    let hostName: String
    let tlsFingerprint: String?
    var platform: String? = nil
    var pairingOpen: Bool? = nil
    /// The host has its own UI with "Pair a new phone" (section 13.2); picks the instructions.
    var hostUi: Bool? = nil
}

/// Why a probe got no WinDock answer, which orders the checks on the "Can't reach" screen.
enum ProbeFailure: Equatable {
    case refused, timeout, tls, notWinDock, other
}

/// The result of one probe. `presentedFingerprint` is the leaf certificate the TLS handshake
/// actually presented (https only), recorded even when the probe then refused it.
struct ProbeResult {
    let info: HealthInfo?
    let presentedFingerprint: String?
    var failure: ProbeFailure? = nil
    var endpoint: URL? = nil
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
    /// port, and only when it equals `pinned` or when there is no pin (captured for the caller to
    /// compare). `/health` carries no credentials, so reading it before deciding is safe; trust is
    /// decided by the caller from `presentedFingerprint`, never from the body.
    func start(endpoint: URL, pinned: String? = nil, timeout: TimeInterval = 10,
               completion: @escaping (ProbeResult) -> Void) {
        cancel()
        self.completion = completion
        body = Data()
        validResponse = false
        target = endpoint
        self.pinned = pinned
        presented = nil
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.waitsForConnectivity = false
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        let session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        self.session = session
        var request = URLRequest(url: endpoint.appendingPathComponent("health"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        session.dataTask(with: request).resume()
    }

    func cancel() {
        completion = nil
        session?.invalidateAndCancel()
        session = nil
    }

    private func finish(_ success: Bool, failure: ProbeFailure?) {
        let callback = completion
        let info = success ? Self.parse(body) : nil
        let result = ProbeResult(info: info, presentedFingerprint: presented,
                                 failure: info == nil ? (failure ?? .notWinDock) : nil, endpoint: target)
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
                          tlsFingerprint: tls?["fingerprint"] as? String,
                          platform: object["platform"] as? String,
                          pairingOpen: object["pairingOpen"] as? Bool,
                          hostUi: object["hostUi"] as? Bool)
    }

    static func isWinDock(_ body: Data) -> Bool { parse(body) != nil }

    static func classify(_ error: Error?) -> ProbeFailure? {
        guard let error = error as? URLError else { return error == nil ? nil : .other }
        switch error.code {
        case .cannotConnectToHost, .networkConnectionLost: return .refused
        case .timedOut, .cannotFindHost, .notConnectedToInternet: return .timeout
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .clientCertificateRejected,
             .cancelled: return .tls
        default: return .other
        }
    }

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
        if pinned == nil || CertificatePin.matches(pinned, fingerprint) {
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
        guard body.count + data.count <= 4096 else { finish(false, failure: .notWinDock); return }
        body.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard session === self.session else { return }
        let ok = error == nil && validResponse && Self.isWinDock(body)
        finish(ok, failure: ok ? nil : (error == nil ? .notWinDock : Self.classify(error)))
    }
}

/// Runs any number of probes at once and keeps each alive until it answers.
final class ProbePool {
    private var active: [ObjectIdentifier: HealthProbe] = [:]

    @discardableResult
    func probe(_ endpoint: URL, timeout: TimeInterval, completion: @escaping (ProbeResult) -> Void) -> HealthProbe {
        let probe = HealthProbe()
        let id = ObjectIdentifier(probe)
        active[id] = probe
        probe.start(endpoint: endpoint, pinned: nil, timeout: timeout) { [weak self] result in
            self?.active[id] = nil
            completion(result)
        }
        return probe
    }

    /// Probes over https first, and over plain http only when the https handshake failed and the
    /// host may be a very old one without TLS (`allowPlain`). A plain answer that advertises TLS is
    /// not accepted: such a host must be reached over https.
    func probeSecureFirst(_ endpoint: URL, timeout: TimeInterval, allowPlain: Bool,
                          completion: @escaping (ProbeResult) -> Void) {
        guard let secure = EndpointPolicy.with(scheme: "https", endpoint) else {
            completion(ProbeResult(info: nil, presentedFingerprint: nil, failure: .other, endpoint: endpoint)); return
        }
        let started = Date()
        probe(secure, timeout: timeout) { [weak self] result in
            guard let self else { return }
            if result.info != nil || !allowPlain || result.failure == .refused || result.failure == .timeout {
                completion(result); return
            }
            guard let plain = EndpointPolicy.with(scheme: "http", endpoint) else { completion(result); return }
            let remaining = max(1, timeout - Date().timeIntervalSince(started))
            self.probe(plain, timeout: remaining) { plainResult in
                if let info = plainResult.info, info.tlsFingerprint == nil {
                    completion(plainResult)
                } else {
                    completion(ProbeResult(info: nil, presentedFingerprint: nil,
                                           failure: plainResult.info != nil ? .tls : (plainResult.failure ?? result.failure),
                                           endpoint: secure))
                }
            }
        }
    }

    func cancelAll() {
        active.values.forEach { $0.cancel() }
        active = [:]
    }
}
