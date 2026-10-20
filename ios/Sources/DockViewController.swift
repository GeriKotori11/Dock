import UIKit
import WebKit

final class DockViewController: UIViewController, WKNavigationDelegate, UITextFieldDelegate {
    static let rememberedPCKey = "windock.pcAddress"
    private let defaults: UserDefaults
    private let autoConnect: Bool
    private let probe = HealthProbe()
    private let pins: PinStore
    /// Asks the person to compare the security code with the one their computer shows.
    /// Replaceable so hosted tests can answer; it only ever adds a confirmation step.
    var confirmSecurityCode: (_ hostName: String, _ code: String, _ completion: @escaping (Bool) -> Void) -> Void
    private let connection = UIScrollView()
    let address = UITextField()
    let status = UILabel()
    let connectButton = UIButton(type: .system)
    private let pcButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private(set) var webView: WKWebView?
    private(set) var endpoint: URL?
    /// The pinned leaf fingerprint the dock's https endpoint must present, nil for plain http.
    private(set) var trustedFingerprint: String?
    private var attempt = UUID()
    private var loadTimeout: DispatchWorkItem?
    private var started = false
    private let mint = UIColor(red: 0.51, green: 0.91, blue: 0.75, alpha: 1)

    init(defaults: UserDefaults = .standard, autoConnect: Bool = true) {
        self.defaults = defaults
        self.autoConnect = autoConnect
        self.pins = PinStore(defaults: defaults)
        self.confirmSecurityCode = { _, _, completion in completion(false) }
        super.init(nibName: nil, bundle: nil)
        self.confirmSecurityCode = { [weak self] hostName, code, completion in
            self?.presentSecurityCodeAlert(hostName: hostName, code: code, completion: completion) ?? completion(false)
        }
    }
    required init?(coder: NSCoder) { fatalError("Use init(defaults:autoConnect:)") }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { webView != nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.035, green: 0.055, blue: 0.063, alpha: 1)
        view.tintColor = mint
        // The screen never sleeps while WinDock is in the foreground (connection screen included).
        // iOS restores the system idle timer on its own when the app goes to the background.
        UIApplication.shared.isIdleTimerDisabled = true
        buildConnectionScreen()
        buildPCMenu()
        address.text = defaults.string(forKey: Self.rememberedPCKey)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !started {
            started = true
            if autoConnect && EndpointPolicy.normalize(address.text) != nil { connect() }
        }
    }

    private func label(_ text: String, size: CGFloat, weight: UIFont.Weight = .regular) -> UILabel {
        let label = UILabel()
        label.text = text
        label.textColor = .white
        label.font = .systemFont(ofSize: size, weight: weight)
        label.numberOfLines = 0
        label.adjustsFontForContentSizeCategory = true
        return label
    }

    private func buildConnectionScreen() {
        connection.translatesAutoresizingMaskIntoConstraints = false
        connection.keyboardDismissMode = .interactive
        view.addSubview(connection)
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            connection.topAnchor.constraint(equalTo: safe.topAnchor),
            connection.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            connection.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            connection.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
        let brand = label("WinDock", size: 17, weight: .semibold)
        let mark = BrandMark()
        NSLayoutConstraint.activate([mark.widthAnchor.constraint(equalToConstant: 38), mark.heightAnchor.constraint(equalToConstant: 38)])
        let brandRow = UIStackView(arrangedSubviews: [mark, brand])
        brandRow.spacing = 12
        brandRow.alignment = .center
        let title = label("Your computer.\nWithin reach.", size: 34, weight: .bold)
        let intro = label("A little space for your favorite apps.\nKeep both devices on the same Wi-Fi.", size: 14)
        intro.textColor = .secondaryLabel
        let left = UIStackView(arrangedSubviews: [brandRow, title, intro])
        left.axis = .vertical
        left.spacing = 18
        left.alignment = .leading

        let heading = label("Connect to your computer", size: 21, weight: .semibold)
        let hint = label("Find the address WinDock shows on your computer: on Windows, tray menu → Show connection info; on a Mac, run npm run info.", size: 13)
        hint.textColor = .secondaryLabel
        address.accessibilityIdentifier = "pc-address"
        address.accessibilityLabel = "Computer address"
        address.placeholder = "192.168.1.20:8620"
        address.keyboardType = .URL
        address.autocapitalizationType = .none
        address.autocorrectionType = .no
        address.spellCheckingType = .no
        address.smartQuotesType = .no
        address.smartDashesType = .no
        address.returnKeyType = .go
        address.clearButtonMode = .whileEditing
        address.font = .monospacedSystemFont(ofSize: 16, weight: .regular)
        address.backgroundColor = UIColor.white.withAlphaComponent(0.065)
        address.layer.cornerRadius = 12
        address.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        address.leftViewMode = .always
        address.heightAnchor.constraint(equalToConstant: 48).isActive = true
        address.delegate = self
        var config = UIButton.Configuration.filled()
        config.title = "Connect"
        config.image = UIImage(systemName: "arrow.right")
        config.imagePlacement = .trailing
        config.imagePadding = 10
        config.baseBackgroundColor = mint
        config.baseForegroundColor = UIColor(red: 0.04, green: 0.11, blue: 0.10, alpha: 1)
        config.cornerStyle = .medium
        connectButton.configuration = config
        connectButton.heightAnchor.constraint(equalToConstant: 46).isActive = true
        connectButton.accessibilityIdentifier = "connect"
        connectButton.addTarget(self, action: #selector(connect), for: .touchUpInside)
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabel
        status.numberOfLines = 0
        status.text = "Your computer will ask you to pair with a PIN."
        status.accessibilityIdentifier = "connection-status"
        let statusRow = UIStackView(arrangedSubviews: [spinner, status])
        statusRow.spacing = 8
        statusRow.alignment = .top
        spinner.hidesWhenStopped = true
        let right = UIStackView(arrangedSubviews: [heading, hint, address, connectButton, statusRow])
        right.axis = .vertical
        right.spacing = 12
        let columns = UIStackView(arrangedSubviews: [left, right])
        columns.distribution = .fillEqually
        columns.alignment = .center
        columns.spacing = 36
        columns.translatesAutoresizingMaskIntoConstraints = false
        connection.addSubview(columns)
        NSLayoutConstraint.activate([
            columns.leadingAnchor.constraint(equalTo: connection.contentLayoutGuide.leadingAnchor, constant: 28),
            columns.trailingAnchor.constraint(equalTo: connection.contentLayoutGuide.trailingAnchor, constant: -28),
            columns.topAnchor.constraint(equalTo: connection.contentLayoutGuide.topAnchor, constant: 24),
            columns.bottomAnchor.constraint(equalTo: connection.contentLayoutGuide.bottomAnchor, constant: -24),
            columns.widthAnchor.constraint(equalTo: connection.frameLayoutGuide.widthAnchor, constant: -56)
        ])
        let height = columns.heightAnchor.constraint(greaterThanOrEqualTo: connection.frameLayoutGuide.heightAnchor, constant: -48)
        height.priority = .defaultLow
        height.isActive = true
    }

    private func buildPCMenu() {
        var config = UIButton.Configuration.gray()
        config.image = UIImage(systemName: "ellipsis")
        config.baseForegroundColor = .white
        config.background.backgroundColor = UIColor.black.withAlphaComponent(0.5)
        config.cornerStyle = .capsule
        pcButton.configuration = config
        pcButton.accessibilityLabel = "Connection options"
        pcButton.accessibilityIdentifier = "pc-options"
        pcButton.showsMenuAsPrimaryAction = true
        pcButton.menu = UIMenu(children: [
            UIAction(title: "Reconnect", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in self?.connect() },
            UIAction(title: "Change computer", image: UIImage(systemName: "desktopcomputer")) { [weak self] _ in self?.showConnection() }
        ])
        pcButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(pcButton)
        NSLayoutConstraint.activate([
            pcButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 8),
            pcButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            pcButton.widthAnchor.constraint(equalToConstant: 44), pcButton.heightAnchor.constraint(equalToConstant: 44)
        ])
        pcButton.isHidden = true
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool { connect(); return true }

    @objc func connect() {
        showConnection()
        view.endEditing(true)
        guard let endpoint = EndpointPolicy.normalize(address.text) else {
            status.text = "Enter a local computer address, for example 192.168.1.20:8620."
            return
        }
        self.endpoint = endpoint
        let id = attempt
        connectButton.isEnabled = false
        address.isEnabled = false
        spinner.startAnimating()
        status.text = "Looking for WinDock… Allow Local Network access if asked."
        // The host serves http and https on one port; its plain /health says whether it has TLS.
        guard let plain = EndpointPolicy.with(scheme: "http", endpoint) else { showUnreachable(); return }
        probe.start(endpoint: plain) { [weak self] result in
            guard let self, self.attempt == id else { return }
            guard let info = result.info else { self.showUnreachable(); return }
            if let hostId = info.hostId, PinStore.isValidHostId(hostId),
               info.tlsFingerprint != nil || self.pins.pin(for: hostId) != nil {
                // A pinned host is always reached over https, whatever plain /health claims.
                self.secureConnect(endpoint, hostId: hostId, hostName: info.hostName, attempt: id)
            } else {
                self.loadDock(endpoint, trusting: nil, attempt: id)
            }
        }
    }

    private func showUnreachable() {
        showConnection(message: "Couldn’t reach WinDock. Check the address WinDock shows, Wi-Fi, firewall and Settings → Privacy & Security → Local Network, then retry.")
    }

    private func secureConnect(_ requested: URL, hostId: String, hostName: String, attempt id: UUID) {
        guard let secure = EndpointPolicy.with(scheme: "https", requested) else { showUnreachable(); return }
        self.endpoint = secure
        let pinned = pins.pin(for: hostId)
        status.text = "Securing connection…"
        probe.start(endpoint: secure, pinned: pinned) { [weak self] result in
            guard let self, self.attempt == id else { return }
            guard let presented = result.presentedFingerprint else { self.showUnreachable(); return }
            let decision = PinDecision.decide(pinned: pinned, presented: presented)
            if decision == .mismatch {
                self.presentMismatchAlert(hostId: hostId, hostName: hostName, attempt: id); return
            }
            // The https body comes from the certificate holder; it must describe the same host.
            guard let info = result.info, info.hostId?.lowercased() == hostId.lowercased(),
                  let code = CertificatePin.securityCode(presented) else { self.showUnreachable(); return }
            if decision == .trust { self.loadDock(secure, trusting: presented, attempt: id); return }
            self.confirmSecurityCode(Self.displayName(info.hostName), code) { [weak self] matches in
                guard let self, self.attempt == id else { return }
                guard matches, self.pins.setPin(presented, for: hostId) else {
                    self.showConnection(message: "Connection cancelled."); return
                }
                self.loadDock(secure, trusting: presented, attempt: id)
            }
        }
    }

    static func displayName(_ hostName: String) -> String {
        let name = hostName.trimmingCharacters(in: .whitespacesAndNewlines)
        let shown = name.isEmpty ? "your computer" : name
        return shown.count > 60 ? String(shown.prefix(60)) : shown
    }

    private func presentSecurityCodeAlert(hostName: String, code: String, completion: @escaping (Bool) -> Void) {
        let alert = UIAlertController(
            title: "Check the security code",
            message: "Make sure this code matches the one WinDock shows on \(hostName):\n\n\(code)\n\nWindows: tray → Show connection info · Mac: npm run info",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completion(false) })
        let match = UIAlertAction(title: "Codes match", style: .default) { _ in completion(true) }
        alert.addAction(match)
        alert.preferredAction = match
        present(alert, animated: true)
    }

    private func presentMismatchAlert(hostId: String, hostName: String, attempt id: UUID) {
        let alert = UIAlertController(
            title: "Security code changed",
            message: "\(Self.displayName(hostName)) is presenting a different security identity than when you paired. This happens if WinDock was reinstalled or its data was reset on that computer, or if another device is pretending to be it.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Forget and pair again", style: .destructive) { [weak self] _ in
            guard let self, self.attempt == id else { return }
            self.forgetAndReconnect(hostId: hostId)
        })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            guard let self, self.attempt == id else { return }
            self.showConnection(message: "Connection cancelled.")
        })
        present(alert, animated: true)
    }

    /// Removes the pin so the next connection asks the person to confirm the new security code.
    func forgetAndReconnect(hostId: String) {
        pins.removePin(for: hostId)
        connect()
    }

    private func loadDock(_ endpoint: URL, trusting fingerprint: String?, attempt id: UUID) {
        self.endpoint = endpoint
        trustedFingerprint = fingerprint
        guard let rules = try? EndpointPolicy.contentRules(for: endpoint) else {
            showConnection(message: "Couldn’t prepare the dock. Please try again."); return
        }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "windock-pc", encodedContentRuleList: rules) { [weak self] rules, error in
            guard let self, self.attempt == id else { return }
            guard let rules, error == nil else {
                self.showConnection(message: "Couldn’t prepare the dock. Please try again."); return
            }
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .default() // HttpOnly pairing cookie survives switching/reopening the app.
            config.userContentController.add(rules)
            let web = WKWebView(frame: .zero, configuration: config)
            web.navigationDelegate = self
            web.isOpaque = false
            web.backgroundColor = self.view.backgroundColor
            web.scrollView.backgroundColor = self.view.backgroundColor
            web.scrollView.contentInsetAdjustmentBehavior = .never
            web.scrollView.bounces = false
            web.allowsBackForwardNavigationGestures = false
            web.translatesAutoresizingMaskIntoConstraints = false
            self.view.insertSubview(web, belowSubview: self.connection)
            NSLayoutConstraint.activate([
                web.leadingAnchor.constraint(equalTo: self.view.leadingAnchor), web.trailingAnchor.constraint(equalTo: self.view.trailingAnchor),
                web.topAnchor.constraint(equalTo: self.view.topAnchor), web.bottomAnchor.constraint(equalTo: self.view.bottomAnchor)
            ])
            self.webView = web
            self.status.text = "Opening your dock…"
            let timeout = DispatchWorkItem { [weak self] in
                guard let self, self.attempt == id else { return }
                self.showConnection(message: "The dock took too long to load. Check that WinDock is still running, then retry.")
            }
            self.loadTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout)
            web.load(URLRequest(url: endpoint))
        }
    }

    func showConnection(message: String = "Enter your computer's address to connect.") {
        attempt = UUID()
        probe.cancel()
        loadTimeout?.cancel()
        loadTimeout = nil
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.removeFromSuperview()
        webView = nil // Close sockets and release any remote gestures with the old page.
        endpoint = nil
        trustedFingerprint = nil
        pcButton.isHidden = true
        connection.isHidden = false
        connectButton.isEnabled = true
        address.isEnabled = true
        spinner.stopAnimating()
        status.text = message
        setNeedsUpdateOfHomeIndicatorAutoHidden()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let endpoint, navigationAction.targetFrame != nil,
              EndpointPolicy.allows(navigationAction.request.url, endpoint: endpoint) else {
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let endpoint, EndpointPolicy.allows(navigationResponse.response.url, endpoint: endpoint) else {
            decisionHandler(.cancel); return
        }
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse, !(200...299).contains(response.statusCode) {
            decisionHandler(.cancel)
            showConnection(message: "WinDock couldn’t open the dock. Check the computer and retry.")
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
        guard webView === self.webView, let endpoint, endpoint.scheme == "https",
              space.host.lowercased() == endpoint.host, space.port == EndpointPolicy.effectivePort(endpoint) else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        guard let trustedFingerprint else {
            completionHandler(.performDefaultHandling, nil); return // An https address without a pin keeps system validation.
        }
        guard let trust = space.serverTrust, CertificatePin.leafFingerprint(trust) == trustedFingerprint else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView, let endpoint else { return }
        loadTimeout?.cancel()
        loadTimeout = nil
        defaults.set(endpoint.absoluteString, forKey: Self.rememberedPCKey)
        address.text = endpoint.absoluteString
        connection.isHidden = true
        pcButton.isHidden = false
        spinner.stopAnimating()
        UIApplication.shared.isIdleTimerDisabled = true
        setNeedsUpdateOfHomeIndicatorAutoHidden()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    private func failed(_ web: WKWebView, _ error: Error) {
        guard web === webView, (error as NSError).code != NSURLErrorCancelled else { return }
        showConnection(message: "Connection interrupted. Check your computer and Wi-Fi, then reconnect.")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        showConnection(message: "The dock was paused by iOS. Tap Connect to reopen it.")
    }
    deinit { probe.cancel(); loadTimeout?.cancel() }
}

private final class BrandMark: UIView {
    override func draw(_ rect: CGRect) {
        let colors: [UIColor] = [
            UIColor(red: 0.51, green: 0.91, blue: 0.75, alpha: 1),
            UIColor(red: 0.78, green: 0.98, blue: 0.91, alpha: 1),
            UIColor(red: 0.50, green: 0.73, blue: 1, alpha: 1),
            UIColor(red: 0.41, green: 0.85, blue: 0.80, alpha: 1)
        ]
        for i in 0..<4 {
            colors[i].setFill()
            let size = bounds.width * 0.42
            UIBezierPath(roundedRect: CGRect(x: CGFloat(i % 2) * bounds.width * 0.58,
                                            y: CGFloat(i / 2) * bounds.height * 0.58,
                                            width: size, height: size), cornerRadius: 4).fill()
        }
    }
}
