package com.windock.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.Context
import android.content.DialogInterface
import android.content.Intent
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.doOnLayout
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.Executors

/**
 * Native shell: the Computers hub, pairing and problem screens around the shared web dock
 * (docs/design/PHONE-CONNECTION-FLOW.md). The WebView stays at the bottom of the window;
 * native screens are drawn above it by [ScreenHost].
 */
class MainActivity : Activity(), ConnectionCoordinator.Listener {
    private lateinit var web: WebView
    private lateinit var host: ScreenHost
    private lateinit var keyboardBar: LinearLayout
    private lateinit var keyboardEditor: RemoteKeyboardEditor
    private lateinit var idleDisplay: IdleDisplayController
    private lateinit var store: ComputerStore
    private lateinit var presence: Presence
    private lateinit var scanner: HostScanner
    private lateinit var coordinator: ConnectionCoordinator
    private lateinit var connecting: ConnectingScreen
    private lateinit var computers: ComputersScreen
    private lateinit var pairing: PairingScreen
    private lateinit var address: AddressScreen
    private lateinit var problem: ProblemScreen
    private lateinit var switchSheet: SwitchSheet
    private lateinit var usbSheet: UsbSheet
    private lateinit var qr: QrPairScreen
    private lateinit var cameraSheet: CameraSheet
    private val io = Executors.newFixedThreadPool(6)

    private var keyboardTarget: String? = null
    private var resumed = false
    /** The origin the WebView may load: the open computer's verified endpoint. */
    @Volatile private var endpoint: String? = null
    /** The computer whose dock is open or opening. */
    private var current: Computer? = null
    private var loading = false
    private var loadFailed = false
    private var dockReady = false
    private var bridgeReady = false
    private var dockFailures = 0
    private var pairedShownAt = 0L
    private var phoneDialog: Dialog? = null
    private var systemDialog: AlertDialog? = null
    private var wakingGesture = false
    private val wakingKeys = mutableSetOf<Int>()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    /** The app was opened by a pairing link: Cancel continues the normal launch. */
    private var linkAtLaunch = false
    /** Q10 for a scanned link is the problem screen in front. */
    private var qrProblem = false
    /** `/health.hostUi` per host ID, from this session's verified answers (copy, spec 10.9). */
    private val uiHosts = HashMap<String, Boolean>()

    private val loadTimeout = Runnable { if (loading) { web.stopLoading(); dockFailed() } }
    private val graceOver = Runnable { if (!dockReady && host.current == null) host.show(connecting, 180) }
    private val retryAfterFailure = Runnable { current?.let { if (!dockReady) coordinator.open(it) } }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        host = ScreenHost(this, findViewById(R.id.screens), findViewById(R.id.web))
        ServerUrl.migrate(this)
        store = ComputerStore.of(this)
        store.migrateIfNeeded(ComputerStore.legacyEndpoints(this), PinStore.all(this))
        idleDisplay = IdleDisplayController(this)
        presence = Presence(io) { PinStore.get(this, it) }
        scanner = HostScanner(this, io, ::onScan)
        coordinator = ConnectionCoordinator(io, { PinStore.get(this, it) }, this)
        buildScreens()
        setupRemoteKeyboard()

        web.setBackgroundColor(getColor(R.color.dock_background))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.addJavascriptInterface(Bridge(), "WinDockAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !EndpointPolicy.allowsRequest(endpoint, request.url.toString())

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (EndpointPolicy.allowsRequest(endpoint, request.url.toString())) null
                else WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                hideRemoteKeyboard()
                loadFailed = false
                bridgeReady = false
                injectNative(url)
            }

            override fun onPageCommitVisible(view: WebView, url: String) { injectNative(url) }

            override fun onPageFinished(view: WebView, url: String) {
                if (loadFailed || !loading || !EndpointPolicy.allowsRequest(endpoint, url)) return
                dockLoaded()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && loading) dockFailed()
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                if (request.isForMainFrame && loading) dockFailed()
            }

            // The host's certificate is self-signed: proceed only for the selected https
            // origin presenting exactly the fingerprint pinned for its host ID.
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                val selected = endpoint
                val computer = current
                val pinned = PinStore.get(this@MainActivity, computer?.hostId)
                val sameOrigin = selected != null && selected.startsWith("https://") &&
                    EndpointPolicy.allowsRequest(selected, error.url)
                val presented = fingerprintOf(error.certificate)
                if (sameOrigin && pinned != null && presented != null && presented == pinned) {
                    handler.proceed()
                    return
                }
                handler.cancel()
                if (sameOrigin && pinned != null && computer != null) {
                    teardownDock()
                    showChanged(computer, pinned, presented, selected!!)
                } else if (loading) dockFailed()
            }
        }
        hideSystemBars()
        registerNetworkCallback()
        // A pairing link at launch goes straight to its confirmation, before any network use.
        val launchLink = if (savedInstanceState == null) pairLinkFrom(intent) else null
        if (launchLink is LinkResult.Ok) { linkAtLaunch = true; receive(launchLink.link) }
        else { start(); launchLink?.let(::linkRejected) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        when (val result = pairLinkFrom(intent)) {
            null -> {}
            is LinkResult.Ok -> receive(result.link)
            else -> linkRejected(result)
        }
    }

    private fun buildScreens() {
        connecting = ConnectingScreen(this) { showHub(overDock = false) }
        computers = ComputersScreen(this, presence, object : ComputersScreen.Actions {
            override fun open(computer: Computer) {
                if (computers.overDock && computer.hostId == current?.hostId && dockReady) closeHub()
                else openComputer(computer, switching = true)
            }
            override fun pair(found: HostScanner.Found) = handleAnswer(found.probe, fromAddress = false)
            override fun addByAddress() { address.bind(); host.show(address) }
            override fun scan() = showCameraSheet()
            override fun usb() = showUsb()
            override fun phone() = showPhoneOptions()
            override fun close() = closeHub()
            override fun rename(computer: Computer) = this@MainActivity.rename(computer)
            override fun forget(computer: Computer) = this@MainActivity.forget(computer)
        })
        pairing = PairingScreen(this, io, object : PairingScreen.Callbacks {
            override fun cancelled(request: PairingRequest) = showHub(overDock = false)
            override fun paired(request: PairingRequest, fingerprint: String?, session: SessionCookie) =
                finishPairing(request, fingerprint, session) { pairing.showPaired() }
            override fun scanInstead() = showCameraSheet()
        })
        qr = QrPairScreen(this, io, object : QrPairScreen.Callbacks {
            override fun cancelled() = linkCancelled()
            override fun paired(link: PairLink, probe: Probe, session: SessionCookie) {
                linkAtLaunch = false
                finishPairing(PairingRequest(probe, store.get(link.hostId), startAtPin = true), link.fingerprint, session) { qr.showPaired() }
            }
            override fun enterPin(probe: Probe) {
                linkAtLaunch = false
                showPairing(PairingRequest(probe, store.get(probe.hostId), startAtPin = true))
            }
            override fun openCamera(): Boolean = QrCamera.open(this@MainActivity)
            override fun unreachable(link: PairLink, failure: ProbeFailure?, otherDevice: Boolean) =
                showQrUnreachable(link, failure, otherDevice)
            override fun unreachableShowing(): Boolean = qrProblem && host.current === problem
            override fun resume() {
                qrProblem = false
                host.show(qr)
                syncScanner()
                syncIdleDisplay()
            }
            override fun discovered(): List<Probe> = scanner.snapshot().values.map { it.probe }
            override fun scanningChanged() = syncScanner()
            override fun seen(probe: Probe) = remember(probe)
        })
        cameraSheet = CameraSheet(this)
        address = AddressScreen(this, io, object : AddressScreen.Callbacks {
            override fun cancelled() = showHub(overDock = computers.overDock && dockReady)
            override fun answered(probe: Probe) = handleAnswer(probe, fromAddress = true)
        })
        problem = ProblemScreen(this)
        switchSheet = SwitchSheet(this, presence, object : SwitchSheet.Actions {
            override fun pick(computer: Computer) = openComputer(computer, switching = true)
            override fun manage() = showHub(overDock = true)
            override fun add() = showHub(overDock = true)
        })
        usbSheet = UsbSheet(this, io) { found ->
            io.execute {
                val result = HostClient.probe(found)
                runOnUiThread { (result as? HostClient.Result.Answer)?.let { handleAnswer(it.probe, fromAddress = false) } }
            }
        }
    }

    /** Launch (spec 4.2): straight to the last computer; first launch is the hub. */
    private fun start() {
        val last = store.last()
        when {
            last != null -> openComputer(last, switching = false)
            store.pendingLegacy().isNotEmpty() -> resolveLegacy()
            else -> showHub(overDock = false)
        }
    }

    /** The pre-computers app remembered an address only: one probe, never a prompt. */
    private fun resolveLegacy() {
        val pending = store.pendingLegacy()
        connecting.bind(DisplayName.hostOf(pending.first()))
        host.blank()
        web.postDelayed(graceOver, 400)
        io.execute {
            var answered = false
            var migrated: Computer? = null
            for (candidate in pending) {
                val probe = (HostClient.probe(candidate) as? HostClient.Result.Answer)?.probe ?: continue
                answered = true
                migrated = LegacyMigration.accept(probe, PinStore.all(this), System.currentTimeMillis()) ?: continue
                break
            }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                web.removeCallbacks(graceOver)
                if (migrated != null || answered) store.clearPendingLegacy()
                if (migrated != null) { store.save(migrated); openComputer(migrated, switching = false) }
                else showHub(overDock = false)
            }
        }
    }

    // ---- opening a computer -------------------------------------------------------------

    private fun openComputer(computer: Computer, switching: Boolean) {
        dismissSheets()
        web.removeCallbacks(retryAfterFailure)
        web.removeCallbacks(graceOver)
        if (switching || current?.hostId != computer.hostId) teardownDock()
        current = computer
        dockFailures = 0
        connecting.bind(computer.displayName)
        if (switching) host.show(connecting, 160)
        else { host.blank(); web.postDelayed(graceOver, 400) }
        scanner.candidate(computer.endpoint)
        syncScanner()
        coordinator.open(computer)
    }

    override fun onStatus(computer: Computer, status: ConnectionCoordinator.Status) {
        if (computer.hostId != current?.hostId) return
        if (status == ConnectionCoordinator.Status.LOOKING) connecting.looking(computer.displayName)
    }

    override fun onVerdict(computer: Computer, verdict: Verdict, probe: Probe) {
        if (computer.hostId != current?.hostId) return
        web.removeCallbacks(graceOver)
        remember(probe)
        when (verdict) {
            is Verdict.Open -> {
                val fresh = refreshIdentity(computer, probe)
                if (fresh.needsPin) { askForNewPin(fresh, verdict.endpoint, revoked = false); return }
                if (verdict.moved) {
                    // Found by identity at a new address: no PIN, one status line (spec 4.3).
                    if (host.current !== connecting) host.show(connecting, 180)
                    connecting.moved(DisplayName.hostOf(verdict.endpoint))
                    SessionCookies.migrate(fresh.endpoint, verdict.endpoint) {
                        val moved = store.update(fresh.hostId) { it.copy(endpoint = verdict.endpoint) } ?: fresh.copy(endpoint = verdict.endpoint)
                        loadDock(moved, verdict.endpoint)
                    }
                } else loadDock(fresh, verdict.endpoint)
            }
            is Verdict.Mismatch -> showChanged(verdict.computer, verdict.pinned, verdict.presented, verdict.computer.endpoint)
            is Verdict.Pair -> showPairing(PairingRequest(verdict.probe, verdict.computer ?: computer, verdict.pinChecked))
            else -> {}
        }
    }

    override fun onUnreachable(computer: Computer, failure: ProbeFailure?) {
        if (computer.hostId != current?.hostId || dockReady) return
        web.removeCallbacks(graceOver)
        showUnreachable(computer, failure)
    }

    private fun showUnreachable(computer: Computer, failure: ProbeFailure?) {
        val networks = LocalNetwork.available()
        val windows = DisplayName.normalizePlatform(computer.platform) != "macos"
        val usb: (() -> Unit)? = if (windows) ({ showUsb() }) else null
        if (networks.isEmpty()) {
            problem.noWifi(computer, onSettings = {
                Sheets.openSettings(this, if (Build.VERSION.SDK_INT >= 29) Settings.Panel.ACTION_WIFI else Settings.ACTION_WIFI_SETTINGS)
            }, onUsb = usb, onOther = { showHub(overDock = false) })
        } else {
            val diagnosis = ReachChecks.diagnose(networks, computer.address, failure, scanner.sawAny, computer.platform)
            problem.cantReach(computer, diagnosis, onRetry = {
                problem.restartStatus()
                if (coordinator.active) coordinator.retryNow() else coordinator.open(computer)
            }, onOther = { showHub(overDock = false) }, onUsb = usb, hostUi = uiHosts[computer.hostId] == true)
        }
        qrProblem = false
        host.show(problem)
        syncScanner()
        syncIdleDisplay()
    }

    /** The host name and platform come from /health on every verified contact (spec 12). */
    private fun refreshIdentity(computer: Computer, probe: Probe): Computer {
        val saved = store.get(computer.hostId) ?: return computer
        if (probe.hostId != saved.hostId || probe.hostName.isEmpty()) return saved
        if (probe.hostName == saved.hostName && probe.platform == saved.platform) return saved
        return store.update(saved.hostId) { it.copy(hostName = probe.hostName, platform = probe.platform.ifEmpty { it.platform }) } ?: saved
    }

    /** A probe answered at an address (Add by address, a discovered row, USB): identity by host ID only. */
    private fun handleAnswer(probe: Probe, fromAddress: Boolean) {
        remember(probe)
        when (val found = TrustDecision.forAddress(probe, store::get, { PinStore.get(this, it) }, System.currentTimeMillis())) {
            is Verdict.Open -> {
                val v = found.copy(computer = refreshIdentity(found.computer, probe))
                dismissSheets()
                teardownDock()
                current = v.computer
                connecting.bind(v.computer.displayName)
                host.show(connecting, 160)
                coordinator.cancel()
                if (v.moved) {
                    connecting.moved(DisplayName.hostOf(v.endpoint))
                    SessionCookies.migrate(v.computer.endpoint, v.endpoint) {
                        loadDock(store.update(v.computer.hostId) { it.copy(endpoint = v.endpoint) } ?: v.computer, v.endpoint)
                    }
                } else if (v.computer.needsPin) askForNewPin(v.computer, v.endpoint, revoked = false)
                else loadDock(v.computer, v.endpoint)
            }
            is Verdict.Mismatch -> { dismissSheets(); teardownDock(); showChanged(found.computer, found.pinned, found.presented, probe.endpoint) }
            is Verdict.Pair -> { dismissSheets(); showPairing(PairingRequest(found.probe, found.computer, found.pinChecked)) }
            else -> if (fromAddress) address.noAnswer()
        }
    }

    private fun loadDock(computer: Computer, target: String) {
        coordinator.cancel()
        current = computer
        endpoint = target
        loading = true
        loadFailed = false
        dockReady = false
        presence.markOnline(computer, target)
        web.visibility = View.VISIBLE
        // Forget earlier certificate decisions so onReceivedSslError checks this load.
        if (target.startsWith("https://")) web.clearSslPreferences()
        web.removeCallbacks(loadTimeout)
        web.loadUrl(target)
        web.postDelayed(loadTimeout, 15_000)
    }

    /** First paint of the dock: fade the native overlay out over it (spec section 8). */
    private fun dockLoaded() {
        web.removeCallbacks(loadTimeout)
        web.removeCallbacks(graceOver)
        loading = false
        dockReady = true
        dockFailures = 0
        val computer = current ?: return
        store.markConnected(computer.hostId, endpoint ?: computer.endpoint)?.let { current = it }
        val screen = host.current
        val yields = screen == null || screen === connecting || screen === pairing || (screen === qr && qr.paired) ||
            (screen === problem && problem.kind != ProblemScreen.Kind.CHANGED && !qrProblem)
        if (!yields) return
        val now = SystemClock.uptimeMillis()
        val hold = maxOf(
            if (connecting.movedShownAt > 0 && screen === connecting) 600 - (now - connecting.movedShownAt) else 0,
            if (pairedShownAt > 0 && (screen === pairing || screen === qr)) 400 - (now - pairedShownAt) else 0,
        ).coerceAtLeast(0)
        web.postDelayed({
            if (!dockReady || host.current !== screen) return@postDelayed
            pairedShownAt = 0L
            host.hide(200) { syncScanner(); syncIdleDisplay() }
            hideSystemBars()
            syncIdleDisplay()
        }, hold)
    }

    private fun dockFailed() {
        web.removeCallbacks(loadTimeout)
        loadFailed = true
        loading = false
        dockReady = false
        hideRemoteKeyboard()
        val computer = current ?: return
        web.stopLoading()
        web.visibility = View.INVISIBLE
        dockFailures++
        showUnreachable(computer, ProbeFailure.OTHER)
        // Keep trying in the background, more slowly after repeated page failures.
        web.removeCallbacks(retryAfterFailure)
        web.postDelayed(retryAfterFailure, minOf(15_000L, 3_000L * dockFailures))
    }

    private fun teardownDock() {
        web.removeCallbacks(loadTimeout)
        web.removeCallbacks(retryAfterFailure)
        hideRemoteKeyboard()
        if (endpoint != null || loading) {
            web.stopLoading()
            endpoint = null
            web.loadUrl("about:blank")
        }
        web.visibility = View.INVISIBLE
        loading = false
        dockReady = false
        bridgeReady = false
        syncIdleDisplay()
    }

    private fun injectNative(url: String) {
        val computer = current ?: return
        if (!EndpointPolicy.allowsRequest(endpoint, url)) return
        val native = JSONObject().put("platform", "android").put("switcher", true).put("computerName", computer.displayName)
        web.evaluateJavascript("window.WinDockNative=$native;window.dispatchEvent(new Event('windock-native-ready'));", null)
    }

    // ---- screens ----------------------------------------------------------------------

    private fun showHub(overDock: Boolean) {
        dismissSheets()
        web.removeCallbacks(graceOver)
        coordinator.cancel()
        val keepDock = overDock && dockReady
        if (!keepDock) { teardownDock(); current = null }
        val list = store.all()
        computers.bind(list, keepDock)
        presence.refresh(list, connected = if (keepDock) current?.hostId else null)
        list.forEach { scanner.candidate(it.endpoint) }
        host.show(computers)
        computers.setFound(scanner.snapshot())
        syncScanner()
        syncIdleDisplay()
    }

    private fun closeHub() {
        if (!dockReady) return showHub(overDock = false)
        host.hide(160) { syncScanner(); syncIdleDisplay() }
        hideSystemBars()
    }

    private fun showPairing(request: PairingRequest) {
        coordinator.cancel()
        pairing.bind(request)
        host.show(pairing)
        syncScanner()
        syncIdleDisplay()
    }

    private fun showChanged(computer: Computer, pinned: String?, presented: String?, at: String) {
        coordinator.cancel()
        teardownDock()
        qrProblem = false
        problem.changed(computer, pinned, presented, hostUi = uiHosts[computer.hostId] == true, onForget = {
            // Removes the pin and session for this host ID only and keeps the nickname.
            // Phone-side only: the changed certificate cannot carry the old session, so
            // no DELETE /api/session is sent; the computer's old session expires or is
            // revoked from its paired-phones page (see ChangedForget).
            val plan = ChangedForget.plan(computer, at, store.all())
            PinStore.remove(this, computer.hostId)
            plan.clearCookies.forEach { SessionCookies.remove(it) }
            io.execute {
                val probe = (HostClient.probe(at) as? HostClient.Result.Answer)?.probe
                runOnUiThread {
                    val v = probe?.let { TrustDecision.forComputer(store.get(computer.hostId) ?: computer, null, it) }
                    if (v is Verdict.Pair) showPairing(PairingRequest(v.probe, v.computer, startAtPin = false))
                    else showHub(overDock = false)
                }
            }
        }, onNotNow = { showHub(overDock = false) })
        host.show(problem)
        syncScanner()
    }

    /** The computer revoked this phone, or the row says it needs a new PIN (spec 4.13). */
    private fun askForNewPin(computer: Computer, at: String, revoked: Boolean) {
        coordinator.cancel()
        io.execute {
            val probe = (HostClient.probe(at) as? HostClient.Result.Answer)?.probe
            runOnUiThread {
                if (probe == null) { openComputer(computer, switching = true); return@runOnUiThread }
                when (val v = TrustDecision.forComputer(computer, PinStore.get(this, computer.hostId), probe)) {
                    is Verdict.Open -> showPairing(PairingRequest(probe, computer, startAtPin = true, revoked = revoked))
                    is Verdict.Mismatch -> showChanged(computer, v.pinned, v.presented, at)
                    is Verdict.Pair -> showPairing(PairingRequest(v.probe, computer, startAtPin = v.pinChecked, revoked = revoked))
                    else -> openComputer(computer, switching = true)
                }
            }
        }
    }

    private fun finishPairing(request: PairingRequest, fingerprint: String?, session: SessionCookie, shown: () -> Unit) {
        val probe = request.probe
        val hostId = probe.hostId ?: return showHub(overDock = false)
        if (fingerprint != null && !PinStore.save(this, hostId, fingerprint)) return showHub(overDock = false)
        val now = System.currentTimeMillis()
        val computer = Computer(hostId = hostId, hostName = probe.hostName, nickname = request.computer?.nickname,
            platform = probe.platform, endpoint = probe.endpoint, lastConnectedAt = now,
            addedAt = request.computer?.addedAt?.takeIf { it > 0 } ?: now, needsPin = false)
        store.save(computer)
        SessionCookies.install(probe.endpoint, session) {
            if (isDestroyed) return@install
            shown()
            pairedShownAt = SystemClock.uptimeMillis()
            if (current?.hostId != computer.hostId) teardownDock()
            loadDock(computer, probe.endpoint)
        }
    }

    // ---- QR pairing links (HOST-CONTROL-PAGE 10.4 to 10.7) -----------------------------

    /**
     * A `windock://pair` VIEW intent, read once and then dropped from the intent because it
     * carries a secret. Never logged. A relaunch from Recents replays the old intent: ignored.
     */
    private fun pairLinkFrom(intent: Intent?): LinkResult? {
        if (intent == null || intent.action != Intent.ACTION_VIEW || intent.data == null) return null
        if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) { intent.data = null; return null }
        val raw = intent.dataString
        intent.data = null
        return QrLink.parse(raw)
    }

    private fun linkRejected(result: LinkResult) {
        val text = if (result is LinkResult.Newer) R.string.link_newer else R.string.link_invalid
        showSystemDialog(AlertDialog.Builder(this).setMessage(text).setPositiveButton(R.string.ok, null).create())
    }

    /** A valid link: decide locally, before anything touches the network (spec 10.5). */
    private fun receive(link: PairLink) {
        dismissSheets()
        coordinator.cancel()
        qr.abort()
        // A live dock stays under the confirmation; a dock still loading stops.
        if (!dockReady) teardownDock()
        val saved = store.get(link.hostId)
        val session = saved != null && SessionCookies.has(saved.endpoint)
        when (val start = QrDecision.decide(link, saved, PinStore.get(this, link.hostId), session, System.currentTimeMillis())) {
            is QrStart.Confirm -> showQr(link, start.again)
            is QrStart.OpenDock -> {
                linkAtLaunch = false
                if (start.computer.hostId == current?.hostId && dockReady) closeHub()
                else {
                    // Same identity, maybe a new address: the usual open finds it and moves it.
                    scanner.candidate(link.endpoint)
                    openComputer(start.computer, switching = true)
                }
            }
            is QrStart.Changed -> {
                problem.changed(start.computer, start.pinned, link.fingerprint, qr = true,
                    onForget = { showQr(link, again = true) }, onNotNow = { linkCancelled() })
                qrProblem = false
                host.show(problem)
                syncScanner()
                syncIdleDisplay()
            }
        }
    }

    private fun showQr(link: PairLink, again: Boolean) {
        qr.bind(link, again)
        qrProblem = false
        host.show(qr)
        syncScanner()
        syncIdleDisplay()
    }

    private fun linkCancelled() {
        qr.abort()
        qrProblem = false
        val launch = linkAtLaunch
        linkAtLaunch = false
        when {
            dockReady -> closeHub()
            launch -> start()
            else -> showHub(overDock = false)
        }
    }

    /** Q10: retries continue in the QR screen while this is visible. */
    private fun showQrUnreachable(link: PairLink, failure: ProbeFailure?, otherDevice: Boolean) {
        val shown = Computer(hostId = link.hostId, hostName = link.name, endpoint = link.endpoint, addedAt = 0L)
        val diagnosis = ReachChecks.diagnose(LocalNetwork.available(), DisplayName.hostOf(link.endpoint), failure, scanner.sawAny, "")
        problem.qrCantReach(shown, link.address, diagnosis, otherDevice, onRetry = { qr.retryNow() }, onCancel = { linkCancelled() })
        host.show(problem)
        qrProblem = true
        qr.retryWhileUnreachable()
        syncScanner()
        syncIdleDisplay()
    }

    private fun showCameraSheet() {
        if (cameraSheet.dialog != null) return
        cameraSheet.show { }
    }

    private fun remember(probe: Probe) {
        probe.hostId?.let { uiHosts[it] = probe.hostUi }
    }

    // ---- rename / forget (S4) ---------------------------------------------------------

    private fun rename(computer: Computer) {
        val field = EditText(this).apply {
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI
            filters = arrayOf(InputFilter.LengthFilter(DisplayName.NICKNAME_MAX))
            setText(computer.displayName)
            setSelection(text.length)
            setTextColor(getColor(R.color.text))
        }
        val box = FrameLayout(this).apply {
            val pad = Ui.dp(this@MainActivity, 20f).toInt()
            setPadding(pad, 0, pad, 0)
            addView(field)
        }
        val save = {
            store.update(computer.hostId) { it.copy(nickname = DisplayName.nickname(field.text.toString())) }
            if (current?.hostId == computer.hostId) {
                current = store.get(computer.hostId)
                web.url?.let { injectNative(it) }
            }
            computers.updateRecords(store.all())
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.rename_title)
            .setMessage(getString(R.string.rename_message, DisplayName.of(null, computer.hostName, computer.endpoint)))
            .setView(box)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.rename_save) { _, _ -> save() }
            .create()
        field.setOnEditorActionListener { _, _, _ -> save(); dialog.dismiss(); true }
        showSystemDialog(dialog)
        field.requestFocus()
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE)
    }

    /** Forget removes on both sides when the computer is reachable (decision D7). */
    private fun forget(computer: Computer) {
        val name = computer.displayName
        val base = getString(R.string.forget_message, name)
        var reachable: Boolean? = null
        val dialog = AlertDialog.Builder(this)
            .setTitle(getString(R.string.forget_title, name))
            .setMessage(base)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.forget_confirm) { _, _ -> confirmForget(computer, reachable == true) }
            .create()
        showSystemDialog(dialog)
        dialog.getButton(DialogInterface.BUTTON_POSITIVE)?.setTextColor(getColor(R.color.danger_text))
        dialog.getButton(DialogInterface.BUTTON_NEGATIVE)?.requestFocus()
        val pinned = PinStore.get(this, computer.hostId)
        io.execute {
            val probe = (HostClient.probe(computer.endpoint) as? HostClient.Result.Answer)?.probe
            val ok = probe != null && TrustDecision.forComputer(computer, pinned, probe) is Verdict.Open
            runOnUiThread {
                reachable = ok
                if (dialog.isShowing) dialog.setMessage(base + "\n\n" +
                    getString(if (ok) R.string.forget_message_removed else R.string.forget_message_unreachable, name))
            }
        }
    }

    private fun confirmForget(computer: Computer, reachable: Boolean) {
        val pinned = PinStore.get(this, computer.hostId)
        val session = SessionCookies.current(computer.endpoint)
        val finish = {
            PinStore.remove(this, computer.hostId)
            store.remove(computer.hostId)
            // The store is per host, not per port: keep it if another saved computer shares the address.
            if (store.all().none { DisplayName.hostOf(it.endpoint) == computer.address }) SessionCookies.remove(computer.endpoint)
            if (current?.hostId == computer.hostId) { teardownDock(); current = null }
            if (host.current === computers) {
                if (store.isEmpty()) showHub(overDock = false) else computers.updateRecords(store.all())
            }
        }
        if (!reachable || session == null) return finish()
        io.execute {
            HostClient.forgetSession(computer.endpoint, pinned, session)
            runOnUiThread { if (!isDestroyed) finish() }
        }
    }

    private fun showSystemDialog(dialog: AlertDialog) {
        systemDialog?.dismiss()
        systemDialog = dialog
        dialog.setOnDismissListener { if (systemDialog === dialog) systemDialog = null }
        dialog.show()
    }

    // ---- sheets -----------------------------------------------------------------------

    private fun showSwitchSheet() {
        if (switchSheet.dialog != null) return
        val list = store.all()
        presence.refresh(list, connected = current?.hostId)
        list.forEach { scanner.candidate(it.endpoint) }
        switchSheet.show(list, current?.takeIf { dockReady }?.hostId) { syncScanner() }
        syncScanner()
    }

    private fun showUsb() {
        if (usbSheet.dialog != null) return
        usbSheet.show { syncIdleDisplay() }
    }

    private fun showPhoneOptions() {
        if (phoneDialog != null) return
        val dialog = PhoneSheet.show(this, saved = { idleDisplay.reloadPreferences() }) {
            phoneDialog = null
            syncIdleDisplay()
        }
        phoneDialog = dialog
        syncIdleDisplay()
    }

    private fun dismissSheets() {
        switchSheet.dismiss()
        usbSheet.dismiss()
        cameraSheet.dismiss()
        systemDialog?.dismiss()
    }

    // ---- discovery --------------------------------------------------------------------

    private fun onScan(found: Map<String, HostScanner.Found>) {
        found.values.forEach { remember(it.probe) }
        val list = store.all()
        presence.discovered(list, found)
        if (host.current === computers) computers.setFound(found)
        if (coordinator.active) found.values.forEach { coordinator.discovered(it.probe) }
    }

    /** Discovery runs only while a native screen or the switch sheet is visible. */
    private fun syncScanner() {
        val wanted = resumed && (host.current?.scans == true || switchSheet.dialog != null || coordinator.active)
        if (wanted) scanner.start() else scanner.stop()
    }

    private fun registerNetworkCallback() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = networkChanged()
            override fun onLost(network: Network) = networkChanged()
            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) = networkChanged()
        }
        try { cm.registerDefaultNetworkCallback(callback); networkCallback = callback } catch (_: Exception) {}
    }

    /** Any network change retries at once; S9 leaves by itself when a usable link appears. */
    private fun networkChanged() = runOnUiThread {
        if (isDestroyed) return@runOnUiThread
        val computer = current
        if (host.current === problem && problem.kind == ProblemScreen.Kind.NO_WIFI && computer != null &&
            LocalNetwork.available().isNotEmpty()) openComputer(computer, switching = true)
        else if (coordinator.active) coordinator.retryNow()
    }

    // ---- idle display, keyboard and system UI ------------------------------------------

    private fun dockVisible(): Boolean = dockReady && web.visibility == View.VISIBLE && !host.visible

    private fun syncIdleDisplay() {
        if (!::idleDisplay.isInitialized) return
        val dock = dockVisible() && !loading && !loadFailed && phoneDialog == null
        val waiting = host.current?.waiting == true
        idleDisplay.setActive(resumed && (dock || waiting))
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (::host.isInitialized && event.actionMasked == MotionEvent.ACTION_DOWN) host.userActivity()
        if (::idleDisplay.isInitialized) {
            if (event.actionMasked == MotionEvent.ACTION_DOWN) wakingGesture = idleDisplay.userActivity()
            else if (event.actionMasked == MotionEvent.ACTION_MOVE) idleDisplay.userActivity()
            if (wakingGesture) {
                if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) wakingGesture = false
                return true
            }
        }
        return super.dispatchTouchEvent(event)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (::host.isInitialized && event.action == KeyEvent.ACTION_DOWN) host.userActivity()
        if (::idleDisplay.isInitialized && event.action == KeyEvent.ACTION_DOWN && idleDisplay.userActivity())
            wakingKeys.add(event.keyCode)
        if (event.keyCode in wakingKeys) {
            if (event.action == KeyEvent.ACTION_UP) wakingKeys.remove(event.keyCode)
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun hideSystemBars() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun setupRemoteKeyboard() {
        val dp = resources.displayMetrics.density
        keyboardBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding((8 * dp).toInt(), 0, (8 * dp).toInt(), 0)
            setBackgroundColor(0xff101722.toInt())
            visibility = View.GONE
        }
        keyboardEditor = RemoteKeyboardEditor(this)
        keyboardEditor.onUserActivity = { idleDisplay.userActivity() }
        keyboardEditor.onText = { emitKeyboardInput(JSONObject().put("type", "text").put("text", it)) }
        keyboardEditor.onRemoteKey = { emitKeyboardInput(JSONObject().put("type", "key").put("key", it)) }
        val close = Button(this).apply {
            text = "↓"; contentDescription = getString(R.string.keyboard_hide)
            setOnClickListener { keyboardEditor.commitDraft(); hideRemoteKeyboard(); emitKeyboardEvent("closed") }
        }
        val signature = Button(this).apply {
            text = "Sign"; contentDescription = getString(R.string.keyboard_sign)
            isAllCaps = false
            setOnClickListener { keyboardEditor.commitDraft(); hideRemoteKeyboard(); emitKeyboardEvent("signature") }
        }
        keyboardBar.addView(close, LinearLayout.LayoutParams((52 * dp).toInt(), (48 * dp).toInt()))
        keyboardBar.addView(keyboardEditor, LinearLayout.LayoutParams(0, (52 * dp).toInt(), 1f))
        keyboardBar.addView(signature, LinearLayout.LayoutParams((72 * dp).toInt(), (48 * dp).toInt()))
        findViewById<FrameLayout>(R.id.root).addView(keyboardBar, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, (56 * dp).toInt(), Gravity.BOTTOM))
    }

    /** The page is the open computer's own dock, in front and loaded. */
    private fun trustedPage(): Boolean = !loadFailed && EndpointPolicy.allowsRequest(endpoint, web.url.orEmpty())

    private fun trustedKeyboardPage(): Boolean = resumed && !loading && dockVisible() && trustedPage()

    private fun emitKeyboardInput(message: JSONObject) {
        val target = keyboardTarget ?: return
        if (!trustedKeyboardPage()) return
        idleDisplay.userActivity()
        message.put("target", target)
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('windock-keyboard-input',{detail:$message}))", null)
    }

    private fun emitKeyboardEvent(action: String) {
        if (!trustedKeyboardPage()) return
        val data = JSONObject().put("action", action)
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('windock-keyboard-action',{detail:$data}))", null)
    }

    private fun hideRemoteKeyboard() {
        if (!::keyboardBar.isInitialized) return
        keyboardTarget = null
        keyboardEditor.resetSession()
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(keyboardEditor.windowToken, 0)
        keyboardEditor.clearFocus()
        keyboardBar.visibility = View.GONE
    }

    /** `WinDockAndroid`: every call is checked against the open computer's origin. */
    private inner class Bridge {
        @JavascriptInterface fun showKeyboard(target: String, password: Boolean) {
            if (!target.matches(Regex("[1-9][0-9]{0,15}"))) return
            runOnUiThread {
                if (!trustedKeyboardPage()) return@runOnUiThread
                if (keyboardTarget != target) keyboardEditor.configure(password)
                keyboardTarget = target
                keyboardBar.visibility = View.VISIBLE
                keyboardEditor.requestFocus()
                keyboardEditor.post {
                    if (keyboardTarget == target) showRemoteIme()
                }
            }
        }
        @JavascriptInterface fun hideKeyboard() { runOnUiThread { hideRemoteKeyboard() } }
        @JavascriptInterface fun showPhoneSettings() { runOnUiThread { if (trustedKeyboardPage()) showPhoneOptions() } }
        /** The drawer's connection row (spec 11). */
        @JavascriptInterface fun switchComputer() { runOnUiThread { if (dockVisible() && trustedPage()) showSwitchSheet() } }
        @JavascriptInterface fun ready() { runOnUiThread { if (trustedPage()) bridgeReady = true } }
        /** The web UI would show its own PIN page: native step 2 instead (spec 4.13). */
        @JavascriptInterface fun unauthorized() {
            runOnUiThread {
                val computer = current ?: return@runOnUiThread
                val at = endpoint ?: return@runOnUiThread
                if (!trustedPage() || host.current === pairing) return@runOnUiThread
                val marked = store.update(computer.hostId) { it.copy(needsPin = true) } ?: computer
                current = marked
                askForNewPin(marked, at, revoked = true)
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) { hideSystemBars(); if (keyboardTarget != null) showRemoteIme() }
    }

    private fun showRemoteIme() {
        keyboardEditor.doOnLayout {
            if (keyboardTarget != null && trustedKeyboardPage() && keyboardEditor.hasWindowFocus())
                WindowCompat.getInsetsController(window, keyboardEditor).show(WindowInsetsCompat.Type.ime())
        }
    }

    private fun fingerprintOf(certificate: SslCertificate?): String? = try {
        val x509 = if (Build.VERSION.SDK_INT >= 29) certificate?.x509Certificate
        else certificate?.let { SslCertificate.saveState(it).getByteArray("x509-certificate") }?.let {
            CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(it)) as X509Certificate
        }
        x509?.let { Fingerprint.of(it.encoded) }
    } catch (_: Exception) { null }

    /**
     * Back (spec 4.4, 10): native screens go back one step or to the hub; in the dock the
     * web UI's sheet closes first, then the remote keyboard, then the Switch sheet opens.
     */
    @Deprecated("Activity back dispatch for the supported API 24+ range")
    override fun onBackPressed() {
        val screen = host.current
        if (screen != null && host.visible) {
            if (!screen.onBack()) super.onBackPressed()
            return
        }
        if (!dockVisible()) {
            super.onBackPressed()
            return
        }
        web.evaluateJavascript("""
            (() => { const sheets = document.querySelectorAll('dialog[open]');
            if (!sheets.length) return false; sheets[sheets.length - 1].close(); return true; })()
        """.trimIndent()) { closed ->
            if (closed == "true" || isDestroyed) return@evaluateJavascript
            if (keyboardBar.visibility == View.VISIBLE) {
                keyboardEditor.commitDraft()
                hideRemoteKeyboard()
                emitKeyboardEvent("closed")
            } else showSwitchSheet()
        }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        // The screen never turns off while WinDock is in front: connection, pairing and dock alike.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (::web.isInitialized) web.onResume()
        syncScanner()
        if (host.current === problem && coordinator.active) coordinator.retryNow()
        syncIdleDisplay()
    }

    override fun onPause() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        resumed = false; wakingGesture = false; wakingKeys.clear(); syncIdleDisplay(); hideRemoteKeyboard()
        // Persist the session now: a force-stop must not lose a fresh pairing.
        SessionCookies.flush()
        syncScanner()
        if (::web.isInitialized) web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        phoneDialog?.setOnDismissListener(null)
        phoneDialog?.dismiss()
        systemDialog?.setOnDismissListener(null)
        systemDialog?.dismiss()
        switchSheet.dismiss()
        usbSheet.dismiss()
        cameraSheet.dismiss()
        coordinator.cancel()
        scanner.stop()
        presence.stop()
        host.close()
        idleDisplay.close()
        networkCallback?.let { try { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) } catch (_: Exception) {} }
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        io.shutdownNow()
        web.removeCallbacks(loadTimeout)
        web.removeCallbacks(graceOver)
        web.removeCallbacks(retryAfterFailure)
        web.stopLoading()
        web.destroy()
        super.onDestroy()
    }
}
