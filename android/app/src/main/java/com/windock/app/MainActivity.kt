package com.windock.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Typeface
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.text.SpannableString
import android.text.Spanned
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.view.View
import android.view.WindowManager
import android.view.MotionEvent
import android.view.KeyEvent
import android.view.Gravity
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.view.inputmethod.InputMethodManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.doOnLayout
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.Executors
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/** Native discovery/connection shell; the shared web UI owns pairing and the dock. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var connection: View
    private lateinit var status: TextView
    private lateinit var address: EditText
    private lateinit var connectButton: Button
    private lateinit var retryButton: Button
    private lateinit var keyboardBar: LinearLayout
    private lateinit var keyboardEditor: RemoteKeyboardEditor
    private var keyboardTarget: String? = null
    private var resumed = false
    private val io = Executors.newSingleThreadExecutor()
    @Volatile private var endpoint: String? = null
    /** Host ID and display name of `endpoint` when it is https; its certificate must match PinStore. */
    private var endpointHostId: String? = null
    private var endpointHostName: String = ""
    private var trustDialog: AlertDialog? = null
    private var loadFailed = false
    private var connecting = false
    private lateinit var idleDisplay: IdleDisplayController
    private var phoneDialog: AlertDialog? = null
    private var wakingGesture = false
    private val wakingKeys = mutableSetOf<Int>()
    private var usbOnly = false
    private val loadTimeout = Runnable {
        if (connecting) {
            failConnection(R.string.connection_lost)
            web.stopLoading()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        connection = findViewById(R.id.connection)
        status = findViewById(R.id.status)
        address = findViewById(R.id.address)
        connectButton = findViewById(R.id.connect)
        retryButton = findViewById(R.id.retry)
        ServerUrl.migrate(this)
        usbOnly = PhonePreferences.usbOnly(this)
        idleDisplay = IdleDisplayController(this)
        setupRemoteKeyboard()
        address.setText(ServerUrl.load(this).orEmpty())
        connectButton.setOnClickListener {
            val selected = EndpointPolicy.normalize(address.text.toString())
            if (selected == null) address.error = getString(R.string.invalid_address)
            else connect(selected)
        }
        retryButton.setOnClickListener {
            selectConnection(false); connect()
        }
        findViewById<Button>(R.id.usb_connect).setOnClickListener { showUsbSetup() }
        findViewById<Button>(R.id.phone_options).setOnClickListener { showPhoneOptions() }
        address.setOnEditorActionListener { _, _, _ -> connectButton.performClick(); true }

        web.setBackgroundColor(getColor(R.color.dock_background))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.addJavascriptInterface(KeyboardBridge(), "WinDockAndroid")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !EndpointPolicy.allowsRequest(endpoint, request.url.toString())

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (EndpointPolicy.allowsRequest(endpoint, request.url.toString())) null
                else WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                hideRemoteKeyboard()
                loadFailed = false
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (loadFailed || !EndpointPolicy.allowsRequest(endpoint, url)) return
                setBusy(false)
                connection.visibility = View.GONE
                web.visibility = View.VISIBLE
                hideSystemBars()
                syncIdleDisplay()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) failConnection(R.string.connection_lost)
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                if (request.isForMainFrame) failConnection(R.string.connection_lost)
            }

            // The host's certificate is self-signed: proceed only for the selected
            // https origin presenting exactly the fingerprint pinned for its host ID.
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                val selected = endpoint
                val hostId = endpointHostId
                val pinned = PinStore.get(this@MainActivity, hostId)
                val sameOrigin = selected != null && selected.startsWith("https://") &&
                    EndpointPolicy.allowsRequest(selected, error.url)
                val presented = fingerprintOf(error.certificate)
                if (sameOrigin && pinned != null && presented != null && presented == pinned) {
                    handler.proceed()
                    return
                }
                handler.cancel()
                if (sameOrigin && pinned != null && hostId != null && selected != null)
                    showMismatch(Route.Secure(selected, hostId, endpointHostName, presented, Trust.MISMATCH))
                else failConnection(R.string.connection_lost)
            }
        }
        hideSystemBars()
        connect(restoreOnStartup = true)
    }

    private fun syncIdleDisplay() {
        if (::idleDisplay.isInitialized) idleDisplay.setActive(resumed && !connecting && !loadFailed &&
            web.visibility == View.VISIBLE && phoneDialog == null)
    }

    private fun showPhoneOptions() {
        if (phoneDialog != null) return
        showPhoneDialog(PhoneOptions.displayDialog(this) { idleDisplay.reloadPreferences() })
    }

    private fun showUsbSetup() {
        if (phoneDialog != null) return
        showPhoneDialog(PhoneOptions.usbDialog(this) {
            selectConnection(true); connect()
        })
    }

    private fun showPhoneDialog(dialog: AlertDialog) {
        phoneDialog = dialog
        syncIdleDisplay()
        dialog.setOnDismissListener { if (phoneDialog === dialog) phoneDialog = null; syncIdleDisplay() }
        dialog.show()
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
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
            text = "↓"; contentDescription = "Hide keyboard"
            setOnClickListener { keyboardEditor.commitDraft(); hideRemoteKeyboard(); emitKeyboardEvent("closed") }
        }
        val signature = Button(this).apply {
            text = "Sign"; contentDescription = "Draw and insert a signature"
            isAllCaps = false
            setOnClickListener { keyboardEditor.commitDraft(); hideRemoteKeyboard(); emitKeyboardEvent("signature") }
        }
        keyboardBar.addView(close, LinearLayout.LayoutParams((52 * dp).toInt(), (48 * dp).toInt()))
        keyboardBar.addView(keyboardEditor, LinearLayout.LayoutParams(0, (52 * dp).toInt(), 1f))
        keyboardBar.addView(signature, LinearLayout.LayoutParams((72 * dp).toInt(), (48 * dp).toInt()))
        findViewById<FrameLayout>(R.id.root).addView(keyboardBar, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, (56 * dp).toInt(), Gravity.BOTTOM))
    }

    private fun trustedKeyboardPage(): Boolean =
        resumed && !loadFailed && !connecting && web.visibility == View.VISIBLE &&
            EndpointPolicy.allowsRequest(endpoint, web.url.orEmpty())

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

    private inner class KeyboardBridge {
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

    private fun setBusy(busy: Boolean) {
        if (!busy) web.removeCallbacks(loadTimeout)
        connecting = busy
        connectButton.isEnabled = !busy
        retryButton.isEnabled = !busy
        address.isEnabled = !busy
        findViewById<View>(R.id.usb_connect).isEnabled = !busy
        findViewById<View>(R.id.progress).visibility = if (busy) View.VISIBLE else View.GONE
    }

    private fun selectConnection(useUsb: Boolean, enteredAddress: String? = null) {
        usbOnly = useUsb
        PhonePreferences.setUsbOnly(this, useUsb)
        address.setText(enteredAddress ?: ServerUrl.load(this, useUsb).orEmpty())
        address.setHint(if (useUsb) R.string.usb_address_hint else R.string.address_hint)
        findViewById<TextView>(R.id.connection_mode).setText(if (useUsb) R.string.mode_usb else R.string.mode_wifi)
    }

    private fun failConnection(message: Int) {
        hideRemoteKeyboard()
        loadFailed = true
        setBusy(false)
        web.visibility = View.GONE
        connection.visibility = View.VISIBLE
        status.setText(message)
        syncIdleDisplay()
    }

    /** Validate remembered, entered and discovered hosts with the same health check. */
    private fun connect(manual: String? = null, restoreOnStartup: Boolean = false) {
        if (connecting) return
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(address.windowToken, 0)
        web.stopLoading()
        web.visibility = View.GONE
        syncIdleDisplay()
        connection.visibility = View.VISIBLE
        findViewById<TextView>(R.id.connection_mode).setText(if (usbOnly) R.string.mode_usb else R.string.mode_wifi)
        status.setText(if (usbOnly) R.string.usb_searching else R.string.searching)
        setBusy(true)
        val requestedUsb = usbOnly
        io.execute {
            val networks = LocalNetwork.available()
            val useUsb = if (restoreOnStartup) Discovery.useUsbOnStartup(requestedUsb, networks) else requestedUsb
            runOnUiThread {
                if (!isDestroyed && !isFinishing) {
                    selectConnection(useUsb, manual)
                    status.setText(if (requestedUsb && !useUsb) R.string.usb_disconnected else if (useUsb) R.string.usb_searching else R.string.searching)
                }
            }
            val remembered = manual ?: ServerUrl.load(this, useUsb)
            val selected = remembered?.takeIf { Discovery.permitsRememberedEndpoint(it, useUsb, networks) && reachable(it) }
                ?: if (manual == null) Discovery.find(::reachable, useUsb, networks) else null
            val route = selected?.let { route(it) }
            runOnUiThread {
                if (isDestroyed || isFinishing) return@runOnUiThread
                when (route) {
                    null -> failConnection(if (useUsb) R.string.usb_not_found else R.string.not_found)
                    is Route.Plain -> open(route.endpoint, null, "", useUsb)
                    is Route.Secure -> when (route.decision) {
                        Trust.TRUST -> open(route.endpoint, route.hostId, route.hostName, useUsb)
                        Trust.CONFIRM -> confirmTrust(route, useUsb)
                        Trust.MISMATCH -> showMismatch(route)
                    }
                    Route.Unverified -> failConnection(R.string.connection_lost)
                }
            }
        }
    }

    private sealed class Route {
        class Plain(val endpoint: String) : Route()
        class Secure(val endpoint: String, val hostId: String, val hostName: String,
                     val fingerprint: String?, val decision: Trust) : Route()
        /** The host needs https (it advertises TLS or is already trusted) but it could not be verified. */
        object Unverified : Route()
    }

    /**
     * Decide how to open a reachable host. Hosts that advertise TLS, were already
     * trusted, or were selected as https are verified with the certificate their
     * TLS handshake presents; /health's own `tls` field is only a hint. A trusted
     * host never falls back to http.
     */
    private fun route(selected: String): Route {
        val health = health(selected) ?: return Route.Unverified
        val hostId = health.optString("hostId").takeIf(PinStore::isHostId)
        val hostName = health.optString("hostName").trim().take(60).ifEmpty { URI(selected).host.orEmpty() }
        val pinned = PinStore.get(this, hostId)
        val advertised = health.optJSONObject("tls") != null
        if (!advertised && pinned == null && !selected.startsWith("https://"))
            return EndpointPolicy.withScheme(selected, "http")?.let { Route.Plain(it) } ?: Route.Unverified
        if (hostId == null) return Route.Unverified
        val secure = EndpointPolicy.withScheme(selected, "https") ?: return Route.Unverified
        // A trusted host that stopped offering TLS no longer proves its identity.
        if (!advertised && pinned != null) return Route.Secure(secure, hostId, hostName, null, Trust.MISMATCH)
        runOnUiThread { if (!isDestroyed && !isFinishing) status.setText(R.string.securing) }
        val presented = secureProbe(secure, pinned) ?: return Route.Unverified
        val decision = PinDecision.decide(pinned, presented.fingerprint)
        if (decision != Trust.MISMATCH && presented.hostId != hostId) return Route.Unverified
        return Route.Secure(secure, hostId, hostName, presented.fingerprint, decision)
    }

    private fun open(selected: String, hostId: String?, hostName: String, useUsb: Boolean) {
        endpointHostId = hostId
        endpointHostName = hostName
        endpoint = selected
        ServerUrl.save(this, selected, useUsb)
        address.setText(selected)
        status.setText(R.string.connecting)
        loadFailed = false
        // Forget earlier certificate decisions so onReceivedSslError checks this load.
        if (hostId != null) web.clearSslPreferences()
        web.loadUrl(selected)
        web.postDelayed(loadTimeout, 15000)
    }

    private fun showTrustDialog(builder: AlertDialog.Builder) {
        trustDialog?.setOnDismissListener(null)
        trustDialog?.dismiss()
        web.removeCallbacks(loadTimeout)
        web.stopLoading()
        hideRemoteKeyboard()
        web.visibility = View.GONE
        connection.visibility = View.VISIBLE
        syncIdleDisplay()
        val dialog = builder.create()
        trustDialog = dialog
        dialog.setOnDismissListener { if (trustDialog === dialog) trustDialog = null }
        dialog.show()
    }

    private fun confirmTrust(route: Route.Secure, useUsb: Boolean) {
        val fingerprint = route.fingerprint ?: return failConnection(R.string.connection_lost)
        val code = Fingerprint.securityCode(fingerprint)
        val message = SpannableString(getString(R.string.trust_confirm_message, route.hostName, code))
        val start = message.lastIndexOf(code)
        if (start >= 0) {
            val end = start + code.length
            for (span in listOf(TypefaceSpan("monospace"), RelativeSizeSpan(1.4f), StyleSpan(Typeface.BOLD)))
                message.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        showTrustDialog(AlertDialog.Builder(this)
            .setTitle(R.string.trust_confirm_title)
            .setMessage(message)
            .setPositiveButton(R.string.trust_confirm_accept) { _, _ ->
                if (PinStore.save(this, route.hostId, fingerprint)) open(route.endpoint, route.hostId, route.hostName, useUsb)
                else failConnection(R.string.connection_lost)
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> failConnection(R.string.connection_cancelled) }
            .setOnCancelListener { failConnection(R.string.connection_cancelled) })
    }

    private fun showMismatch(route: Route.Secure) {
        if (trustDialog != null) return
        showTrustDialog(AlertDialog.Builder(this)
            .setTitle(R.string.trust_mismatch_title)
            .setMessage(getString(R.string.trust_mismatch_message, route.hostName))
            .setPositiveButton(R.string.trust_mismatch_forget) { _, _ ->
                PinStore.remove(this, route.hostId)
                web.clearSslPreferences()
                setBusy(false)
                connect(route.endpoint)
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> failConnection(R.string.connection_cancelled) }
            .setOnCancelListener { failConnection(R.string.connection_cancelled) })
    }

    private fun reachable(endpoint: String): Boolean = health(endpoint) != null

    /** The host's plain-http /health, or null when it is not a reachable WinDock host. */
    private fun health(candidate: String): JSONObject? {
        val endpoint = EndpointPolicy.withScheme(candidate, "http") ?: return null
        var conn: HttpURLConnection? = null
        return try {
            conn = URL("$endpoint/health").openConnection() as HttpURLConnection
            readHealth(conn)
        } catch (_: Exception) { null }
        finally { conn?.disconnect() }
    }

    private fun readHealth(conn: HttpURLConnection): JSONObject? {
        conn.connectTimeout = 1500
        conn.readTimeout = 1500
        conn.instanceFollowRedirects = false
        conn.requestMethod = "GET"
        if (conn.responseCode != 200) return null
        return conn.inputStream.bufferedReader().use { reader ->
            val body = CharArray(4097)
            var count = 0
            while (count < body.size) {
                val read = reader.read(body, count, body.size - count)
                if (read == -1) break
                count += read
            }
            JSONObject(String(body, 0, count)).takeIf { count <= 4096 && it.optString("app") == "windock" }
        }
    }

    private class Presented(val fingerprint: String, val hostId: String?)

    /**
     * One https /health request that records the leaf certificate presented in
     * the handshake. Its trust manager is installed on this connection only: it
     * accepts the pinned certificate (or, before pairing, whichever certificate
     * is presented, for the person to confirm) and nothing else. Returns the
     * presented fingerprint and, when the handshake was accepted, the host ID it served.
     */
    private fun secureProbe(endpoint: String, pinned: String?): Presented? {
        if (!endpoint.startsWith("https://") || !ServerUrl.isValid(endpoint)) return null
        var leaf: String? = null
        val trust = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
                throw CertificateException("client certificates are not used")
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                val presented = chain?.firstOrNull()?.let { Fingerprint.of(it.encoded) }
                    ?: throw CertificateException("no certificate")
                leaf = presented
                if (pinned != null && presented != pinned) throw CertificateException("certificate changed")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        var conn: HttpsURLConnection? = null
        return try {
            val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), null) }
            conn = URL("$endpoint/health").openConnection() as HttpsURLConnection
            conn.sslSocketFactory = context.socketFactory
            conn.hostnameVerifier = HostnameVerifier { _, session ->
                val peer = session.peerCertificates.firstOrNull() as? X509Certificate
                peer != null && leaf != null && Fingerprint.of(peer.encoded) == leaf
            }
            val health = readHealth(conn)
            leaf?.let { Presented(it, health?.optString("hostId")?.takeIf(PinStore::isHostId)) }
        } catch (_: Exception) { leaf?.let { Presented(it, null) } }
        finally { conn?.disconnect() }
    }

    private fun fingerprintOf(certificate: SslCertificate?): String? = try {
        val x509 = if (Build.VERSION.SDK_INT >= 29) certificate?.x509Certificate
        else certificate?.let { SslCertificate.saveState(it).getByteArray("x509-certificate") }?.let {
            CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(it)) as X509Certificate
        }
        x509?.let { Fingerprint.of(it.encoded) }
    } catch (_: Exception) { null }

    @Deprecated("Activity back dispatch for the supported API 24+ range")
    override fun onBackPressed() {
        if (keyboardBar.visibility == View.VISIBLE) {
            keyboardEditor.commitDraft()
            hideRemoteKeyboard()
            emitKeyboardEvent("closed")
            return
        }
        if (web.visibility != View.VISIBLE) {
            super.onBackPressed()
            return
        }
        // Close the shared UI's topmost sheet first; otherwise offer PC selection.
        web.evaluateJavascript("""
            (() => { const sheets = document.querySelectorAll('dialog[open]');
            if (!sheets.length) return false; sheets[sheets.length - 1].close(); return true; })()
        """.trimIndent()) { closed ->
            if (closed != "true" && !isDestroyed) failConnection(R.string.choose_pc)
        }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        // The screen never turns off while WinDock is in front: connection, pairing and dock alike.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (::web.isInitialized) web.onResume()
        syncIdleDisplay()
    }
    override fun onPause() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        resumed = false; wakingGesture = false; wakingKeys.clear(); syncIdleDisplay(); hideRemoteKeyboard()
        if (::web.isInitialized) web.onPause()
        super.onPause()
    }
    override fun onDestroy() {
        phoneDialog?.setOnDismissListener(null)
        phoneDialog?.dismiss()
        trustDialog?.setOnDismissListener(null)
        trustDialog?.dismiss()
        idleDisplay.close()
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        io.shutdownNow()
        web.removeCallbacks(loadTimeout)
        web.stopLoading()
        web.destroy()
        super.onDestroy()
    }
}
