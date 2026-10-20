import UIKit
import WebKit

/// The shared web dock for one computer: a `WKWebView` limited to that computer's origin, the
/// native bridge, and the legacy "…" button for hosts whose web UI predates the bridge.
final class DockViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    enum Failure: Equatable { case prepare, timeout, network, status, terminated }

    let endpoint: URL
    /// The pinned leaf fingerprint the dock's https endpoint must present, nil for plain http.
    let trustedFingerprint: String?
    let computerName: String

    var onReady: (() -> Void)?
    var onFailure: ((Failure) -> Void)?
    var onBridge: ((BridgeMessage) -> Void)?
    /// Legacy "…" menu actions (older hosts only).
    var onLegacyReconnect: (() -> Void)?
    var onLegacySwitch: (() -> Void)?

    private(set) var webView: WKWebView?
    private(set) var isReady = false
    private(set) var contentProcessTerminated = false
    private(set) var bridgeCapable = false
    private let fallbackButton = UIButton(type: .system)
    private var loadTimeout: DispatchWorkItem?
    private var fallbackTimer: DispatchWorkItem?
    private var started = false
    /// How long a page has to post `{type:"ready", switcher:true}` before the legacy button shows.
    var fallbackDelay: TimeInterval = 3

    init(endpoint: URL, trustedFingerprint: String?, computerName: String) {
        self.endpoint = endpoint
        self.trustedFingerprint = trustedFingerprint
        self.computerName = computerName
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    var isFallbackVisible: Bool { !fallbackButton.isHidden }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        buildFallbackButton()
    }

    private func buildFallbackButton() {
        var config = UIButton.Configuration.gray()
        config.image = UIImage(systemName: "ellipsis")
        config.baseForegroundColor = .white
        config.background.backgroundColor = UIColor.black.withAlphaComponent(0.5)
        config.cornerStyle = .capsule
        fallbackButton.configuration = config
        fallbackButton.accessibilityLabel = "Connection options"
        fallbackButton.accessibilityIdentifier = "pc-options"
        fallbackButton.showsMenuAsPrimaryAction = true
        fallbackButton.menu = UIMenu(children: [
            UIAction(title: "Reconnect", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in self?.onLegacyReconnect?() },
            UIAction(title: "Change computer", image: UIImage(systemName: "desktopcomputer")) { [weak self] _ in self?.onLegacySwitch?() }
        ])
        fallbackButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(fallbackButton)
        NSLayoutConstraint.activate([
            fallbackButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 8),
            fallbackButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            fallbackButton.widthAnchor.constraint(equalToConstant: 44), fallbackButton.heightAnchor.constraint(equalToConstant: 44)
        ])
        fallbackButton.isHidden = true
    }

    /// Compiles the origin's content rules, builds the web view and loads the dock. The session
    /// cookie must already be in `WKWebsiteDataStore.default()`.
    func start() {
        guard !started else { return }
        started = true
        loadViewIfNeeded()
        guard let rules = try? EndpointPolicy.contentRules(for: endpoint) else { fail(.prepare); return }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "windock-pc", encodedContentRuleList: rules) { [weak self] list, error in
            guard let self, self.started else { return }
            guard let list, error == nil else { self.fail(.prepare); return }
            self.buildWebView(rules: list)
        }
    }

    private func buildWebView(rules: WKContentRuleList) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // The HttpOnly session cookie survives relaunches.
        let controller = config.userContentController
        controller.add(rules)
        controller.addUserScript(WKUserScript(source: NativeBridge.userScriptSource(computerName: computerName),
                                              injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(WeakScriptMessageHandler(self), name: NativeBridge.handlerName)
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = Theme.bg
        web.scrollView.backgroundColor = Theme.bg
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = false
        web.translatesAutoresizingMaskIntoConstraints = false
        view.insertSubview(web, belowSubview: fallbackButton)
        web.pinEdges(to: view)
        webView = web
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, !self.isReady else { return }
            self.fail(.timeout)
        }
        loadTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout)
        web.load(URLRequest(url: endpoint))
    }

    /// Closes sockets and releases any remote gestures held by the page.
    func tearDown() {
        started = false
        loadTimeout?.cancel()
        fallbackTimer?.cancel()
        onReady = nil
        onFailure = nil
        onBridge = nil
        guard let web = webView else { return }
        web.stopLoading()
        web.navigationDelegate = nil
        web.configuration.userContentController.removeScriptMessageHandler(forName: NativeBridge.handlerName)
        web.configuration.userContentController.removeAllUserScripts()
        web.removeFromSuperview()
        webView = nil
    }

    private func fail(_ failure: Failure) {
        loadTimeout?.cancel()
        let callback = onFailure
        callback?(failure)
    }

    // MARK: Bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === webView, let parsed = NativeBridge.accept(message, endpoint: endpoint) else { return }
        if case .ready(let switcher) = parsed, switcher {
            bridgeCapable = true
            fallbackTimer?.cancel()
            fallbackButton.isHidden = true
        }
        onBridge?(parsed)
    }

    private func scheduleFallback() {
        fallbackTimer?.cancel()
        guard !bridgeCapable else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.bridgeCapable, self.webView != nil else { return }
            self.fallbackButton.isHidden = false
        }
        fallbackTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + fallbackDelay, execute: work)
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame != nil, EndpointPolicy.allows(navigationAction.request.url, endpoint: endpoint) else {
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard EndpointPolicy.allows(navigationResponse.response.url, endpoint: endpoint) else {
            decisionHandler(.cancel); return
        }
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse, !(200...299).contains(response.statusCode) {
            decisionHandler(.cancel)
            fail(.status)
            return
        }
        decisionHandler(.allow)
    }

    /// Only the pinned certificate is trusted for the dock's own https origin; never trust-all.
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                 completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.performDefaultHandling, nil); return
        }
        guard webView === self.webView, endpoint.scheme == "https",
              space.host.lowercased() == endpoint.host, space.port == EndpointPolicy.effectivePort(endpoint) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        guard let trustedFingerprint else {
            completionHandler(.performDefaultHandling, nil); return
        }
        guard let trust = space.serverTrust, CertificatePin.leafFingerprint(trust) == trustedFingerprint else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        loadTimeout?.cancel()
        scheduleFallback()
        guard !isReady else { return }
        isReady = true
        onReady?()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(webView, error) }

    private func failed(_ web: WKWebView, _ error: Error) {
        guard web === webView, (error as NSError).code != NSURLErrorCancelled else { return }
        fail(.network)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        contentProcessTerminated = true
        fail(.terminated)
    }

    deinit {
        loadTimeout?.cancel()
        fallbackTimer?.cancel()
    }
}
