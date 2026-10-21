// One WKWebView showing the host control page (or the bundled offline page)
// in a container: the popover or the detached window. Implements the native
// half of the bridge (HOST-CONTROL-PAGE.md 13.5).
import AppKit
import WebKit

protocol WebPaneDelegate: AnyObject {
    /// A validated message from the page.
    func webPane(_ pane: WebPane, received message: BridgeMessage, from source: BridgeSource)
    /// The offline page to show right now (variant, port, detail).
    func offlineContent(for pane: WebPane) -> (variant: OfflineVariant, detail: String)
}

/// Breaks the WKUserContentController → handler retain cycle.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Serves windock-offline://offline/ from memory.
private final class OfflineSchemeHandler: NSObject, WKURLSchemeHandler {
    weak var pane: WebPane?

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let pane, let url = task.request.url, url.host == OfflineOrigin.host else {
            task.didFailWithError(URLError(.unsupportedURL))
            return
        }
        let html = pane.renderOffline()
        let data = Data(html.utf8)
        let headers = [
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": String(data.count),
            "Cache-Control": "no-store",
            "Content-Security-Policy": OfflinePage.contentSecurityPolicy,
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class WebPane: NSViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    static let handlerName = "windockShell"

    let container: ShellContainer
    let rules: BridgeRules
    weak var delegate: WebPaneDelegate?
    private(set) var webView: WKWebView!
    private let schemeHandler = OfflineSchemeHandler()
    private var offlineRevision = 0
    private var loadRetries = 0
    /// The page posted `ready` since the last navigation.
    private(set) var pageReady = false
    private var pendingPair = false
    private var capabilities = BridgeRules.Capabilities(restart: false)
    var onResize: ((Double) -> Void)?

    init(container: ShellContainer, port: Int) {
        self.container = container
        self.rules = BridgeRules(port: port)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.userContentController.add(WeakScriptMessageHandler(self), name: Self.handlerName)
        schemeHandler.pane = self
        config.setURLSchemeHandler(schemeHandler, forURLScheme: OfflineOrigin.scheme)
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: PopoverLayout.width, height: PopoverLayout.initialHeight),
                                configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        if #available(macOS 12.0, *) {
            webView.underPageBackgroundColor = NSColor(srgbRed: 0x09 / 255, green: 0x0E / 255, blue: 0x10 / 255, alpha: 1)
        }
        webView.autoresizingMask = [.width, .height]
        self.webView = webView
        view = webView
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName)
    }

    // ---- loading -------------------------------------------------------

    /// Shows /host (host running) or the offline page.
    func load(hostRunning: Bool, capabilities: BridgeRules.Capabilities) {
        _ = view
        self.capabilities = capabilities
        installShellScript()
        pageReady = false
        if hostRunning {
            loadRetries = 0
            webView.load(URLRequest(url: HostHealth.pageURL(port: rules.port), cachePolicy: .reloadIgnoringLocalCacheData))
        } else {
            offlineRevision += 1
            webView.load(URLRequest(url: OfflineOrigin.url(revision: offlineRevision)))
        }
    }

    var isShowingHostPage: Bool { rules.isHostOrigin(webView?.url) }

    private func installShellScript() {
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        let source = rules.shellScript(container: container, version: AppSettings.appVersion, capabilities: capabilities)
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    fileprivate func renderOffline() -> String {
        let content = delegate?.offlineContent(for: self) ?? (.starting, "")
        return OfflinePage.render(content.variant, port: rules.port, detail: content.detail, container: container)
    }

    // ---- native → page -------------------------------------------------

    /// Dispatches a `windockshell` event, only into the host page.
    func send(_ detail: [String: Any]) {
        guard isViewLoaded, isShowingHostPage, let script = BridgeRules.eventScript(detail) else { return }
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    /// Native "Pair a new phone": now if the page is ready, else on `ready`.
    func requestPair() {
        if pageReady && isShowingHostPage {
            pendingPair = false
            send(["type": "navigate", "view": "pair"])
        } else {
            pendingPair = true
        }
    }

    // ---- page → native -------------------------------------------------

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        let frame = FrameOrigin(isMainFrame: message.frameInfo.isMainFrame, scheme: origin.protocol,
                                host: origin.host, port: origin.port)
        guard let (source, parsed) = rules.message(message.body, from: frame) else { return }
        if case .ready = parsed {
            pageReady = true
            if source == .host && pendingPair {
                pendingPair = false
                send(["type": "navigate", "view": "pair"])
            }
        }
        if case let .resize(height) = parsed { onResize?(height) }
        delegate?.webPane(self, received: parsed, from: source)
    }

    // ---- navigation policy (13.5) ---------------------------------------

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let userInitiated = action.navigationType == .linkActivated
        switch rules.navigation(to: action.request.url, userInitiated: userInitiated) {
        case .allow:
            if action.targetFrame?.isMainFrame ?? false { pageReady = false }
            decisionHandler(.allow)
        case let .openExternally(url):
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
        case .block:
            decisionHandler(.cancel)
        }
    }

    /// target=_blank and window.open: never a new web view; web links go to the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if case let .openExternally(url) = rules.navigation(to: action.request.url, userInitiated: true) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retryHostPageIfNeeded(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retryHostPageIfNeeded(error)
    }

    /// The host can answer /health a moment before /host serves; retry a few times.
    private func retryHostPageIfNeeded(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        guard loadRetries < 3, rules.isHostOrigin(nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL) else { return }
        loadRetries += 1
        let retries = loadRetries
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.loadRetries == retries else { return }
            self.webView.load(URLRequest(url: HostHealth.pageURL(port: self.rules.port), cachePolicy: .reloadIgnoringLocalCacheData))
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageReady = false
        webView.reload()
    }

    // ---- snapshots (verification) --------------------------------------

    func snapshot(to url: URL, completion: @escaping (Bool) -> Void) {
        let config = WKSnapshotConfiguration()
        webView.takeSnapshot(with: config) { image, _ in
            guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { completion(false); return }
            completion((try? png.write(to: url)) != nil)
        }
    }
}
