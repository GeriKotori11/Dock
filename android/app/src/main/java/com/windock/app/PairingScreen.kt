package com.windock.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.concurrent.ExecutorService

/** What pairing needs: the verified probe, the saved record if any, and where to start. */
data class PairingRequest(
    val probe: Probe,
    val computer: Computer?,
    /** The presented certificate already matches the pin: start at the PIN step. */
    val startAtPin: Boolean,
    /** The computer revoked this phone (spec 4.13). */
    val revoked: Boolean = false,
) {
    val name: String get() = computer?.displayName ?: DisplayName.of(null, probe.hostName, probe.endpoint)
    val platform: String get() = probe.platform.ifEmpty { computer?.platform.orEmpty() }
    /** Hosts without TLS: step 1 is skipped and the indicator reads "1 of 1". */
    val plain: Boolean get() = probe.presented == null
}

/**
 * S5 / S6 Pairing (spec 4.5, 4.8, 4.9, 5.5, 5.6): compare the security code, then enter
 * the PIN. `POST /api/auth` goes over a connection that accepts only the certificate the
 * user just compared.
 */
class PairingScreen(activity: Activity, private val io: ExecutorService, private val callbacks: Callbacks) :
    Screen(activity, R.layout.screen_pairing, R.id.pair_columns) {

    interface Callbacks {
        fun cancelled(request: PairingRequest)
        /** 200 from /api/auth. The screen shows "Paired" once [showPaired] is called. */
        fun paired(request: PairingRequest, fingerprint: String?, cookie: SessionCookie)
        /** "Scan the QR code instead" on step 1 (HOST-CONTROL-PAGE 10.1). */
        fun scanInstead()
    }

    private enum class State { CODE, NOMATCH, CLOSED, PIN }

    private val main = Handler(Looper.getMainLooper())
    private val columns: View = find(R.id.pair_columns)
    private val pinPanel: View = find(R.id.pair_pin_panel)
    private val topTitle: TextView = find(R.id.pair_topbar_title)
    private val topStep: TextView = find(R.id.pair_topbar_step)
    private val codePanel: View = find(R.id.pair_code_panel)
    private val noMatchPanel: View = find(R.id.pair_nomatch_panel)
    private val closedPanel: View = find(R.id.pair_closed_panel)
    private val closedSpinner: ProgressBar = find(R.id.pair_closed_spinner)
    private val closedStatus: TextView = find(R.id.pair_closed_status)
    private val input: EditText = find(R.id.pin_input)
    private val boxes: LinearLayout = find(R.id.pin_boxes)
    private val pinField: FrameLayout = find(R.id.pin_field)
    private val message: TextView = find(R.id.pin_message)
    private val messageIcon: ImageView = find(R.id.pin_icon)
    private val pinSpinner: ProgressBar = find(R.id.pin_spinner)

    lateinit var request: PairingRequest
        private set
    private var state = State.CODE
    private var checked: String? = null
    private var sawStep1 = false
    private var wrongDigits: String? = null
    private var hadWrong = false
    private var sending = false
    private var lockedUntil = 0L
    private var closedSince = 0L
    private var generation = 0

    override val waiting: Boolean get() = state == State.CLOSED
    override val title: View get() = if (state == State.PIN) topTitle else find(R.id.pair_name)

    private val poll = object : Runnable {
        override fun run() { pollHealth(); main.postDelayed(this, 3_000) }
    }
    private val countdown = object : Runnable {
        override fun run() { updateLocked() }
    }
    private val closedTick = Runnable {
        closedSpinner.visibility = View.GONE
    }

    init {
        find<View>(R.id.pair_back).setOnClickListener { onBack() }
        find<View>(R.id.pair_match).setOnClickListener { codesMatch() }
        find<View>(R.id.pair_no_match).setOnClickListener { setState(State.NOMATCH) }
        find<View>(R.id.pair_nomatch_back).setOnClickListener { callbacks.cancelled(request) }
        find<View>(R.id.pair_scan_qr).setOnClickListener { callbacks.scanInstead() }
        buildBoxes()
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable) {
                val digits = s.filter { it.isDigit() }.toString()
                if (digits != s.toString()) { s.replace(0, s.length, digits); return }
                if (wrongDigits != null && digits.isNotEmpty()) clearWrong()
                renderBoxes()
                if (digits.length == 6 && !sending) send(digits)
            }
        })
        input.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_DONE && input.text.length == 6 && !sending) send(input.text.toString())
            true
        }
        input.setOnKeyListener { _, keyCode, event ->
            if (keyCode == KeyEvent.KEYCODE_DEL && event.action == KeyEvent.ACTION_DOWN && wrongDigits != null) {
                clearWrong(); renderBoxes(); true
            } else false
        }
        pinField.setOnClickListener { raiseKeyboard() }
        input.accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                val digits = shownDigits()
                info.hintText = str(R.string.pin_label)
                info.text = str(R.string.pin_value, digits.toCharArray().joinToString(" "), digits.length)
            }
        }
    }

    private fun buildBoxes() {
        val d = { v: Float -> Ui.dp(activity, v).toInt() }
        for (i in 0 until 6) {
            val box = FrameLayout(activity).apply { setBackgroundResource(R.drawable.bg_pin_box) }
            box.addView(TextView(activity).apply {
                id = R.id.pin_box_text
                gravity = Gravity.CENTER
                typeface = android.graphics.Typeface.MONOSPACE
                textSize = 26f
                setTextColor(activity.getColor(R.color.text))
            }, FrameLayout.LayoutParams(-1, -1))
            box.addView(View(activity).apply {
                id = R.id.pin_box_caret
                setBackgroundColor(activity.getColor(R.color.accent))
                visibility = View.GONE
            }, FrameLayout.LayoutParams(d(2f), d(26f), Gravity.CENTER))
            val lp = LinearLayout.LayoutParams(d(46f), d(56f))
            if (i > 0) lp.marginStart = d(if (i == 3) 18f else 8f)
            boxes.addView(box, lp)
        }
        // The real field covers the boxes so a tap or TalkBack lands on it.
        // FrameLayout does not stretch a lone match_parent child: size it to the boxes.
        input.layoutParams = FrameLayout.LayoutParams(d(6 * 46f + 5 * 8f + 10f), d(56f))
        input.alpha = 1f
        input.setTextColor(0)
        input.isCursorVisible = false
        input.isLongClickable = false
        input.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        pinField.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun bind(req: PairingRequest) {
        generation++
        request = req
        checked = if (req.startAtPin) req.probe.presented else null
        sawStep1 = false
        hadWrong = false
        wrongDigits = null
        sending = false
        lockedUntil = 0L
        input.setText("")
        find<TextView>(R.id.pair_name).text = req.name
        find<TextView>(R.id.pair_sub).text = Ui.subtitle(activity, listOf(DisplayName.platformLabel(req.platform)), DisplayName.hostOf(req.probe.endpoint))
        val code = req.probe.presented?.let { Fingerprint.securityCode(it) }
        if (code != null) find<TextView>(R.id.pair_code).apply {
            text = Ui.securityCode(activity, code)
            contentDescription = null
        }
        find<TextView>(R.id.pair_code).accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.hintText = str(R.string.pair_code_a11y)
            }
        }
        val how = find<TextView>(R.id.pair_how)
        val icon = find<ImageView>(R.id.pair_how_icon)
        // Hosts with their own control page say "Pair a new phone" (HOST-CONTROL-PAGE 10.9).
        val pairNew = listOf(str(R.string.pair_new_phone))
        when (DisplayName.normalizePlatform(req.platform)) {
            "windows" -> {
                how.text = if (req.probe.hostUi) Ui.rich(activity, str(R.string.pair_code_windows_ui, req.name), strong = pairNew)
                else Ui.rich(activity, str(R.string.pair_code_windows, req.name), strong = listOf("Show connection info"))
                icon.setImageResource(R.drawable.ic_monitor)
            }
            "macos" -> if (req.probe.hostUi) {
                how.text = Ui.rich(activity, str(R.string.pair_code_mac_ui), strong = pairNew); icon.setImageResource(R.drawable.ic_monitor)
            } else {
                how.text = Ui.rich(activity, str(R.string.pair_code_mac), commands = listOf("npm run info")); icon.setImageResource(R.drawable.ic_terminal)
            }
            else -> { how.text = str(R.string.pair_code_other, req.name); icon.setImageResource(R.drawable.ic_monitor) }
        }
        find<TextView>(R.id.pair_nomatch_body).text = str(R.string.pair_no_match_body, req.name)
        val first = when {
            req.startAtPin || req.plain -> if (req.probe.pairingOpen) State.PIN else State.CLOSED
            else -> State.CODE
        }
        setState(first, animate = false)
    }

    private fun setStepper() {
        val done = state == State.PIN || state == State.CLOSED
        val plain = request.plain
        find<View>(R.id.pair_step1).visibility = if (plain) View.GONE else View.VISIBLE
        find<View>(R.id.pair_step1_ring).setBackgroundResource(if (done) R.drawable.bg_step_done else R.drawable.bg_step_now)
        find<View>(R.id.pair_step1_num).visibility = if (done) View.GONE else View.VISIBLE
        find<View>(R.id.pair_step1_check).visibility = if (done) View.VISIBLE else View.GONE
        find<TextView>(R.id.pair_step1_text).apply {
            setText(if (done) R.string.pair_step1_done else R.string.pair_step1)
            setTextColor(activity.getColor(if (done) R.color.text_2 else R.color.text))
            typeface = android.graphics.Typeface.create(if (done) "sans-serif" else "sans-serif-medium", android.graphics.Typeface.NORMAL)
        }
        find<TextView>(R.id.pair_step2_num).apply {
            text = if (plain) "1" else "2"
            setBackgroundResource(if (done) R.drawable.bg_step_now else R.drawable.bg_step_idle)
            setTextColor(activity.getColor(if (done) R.color.accent else R.color.text_3))
        }
        find<TextView>(R.id.pair_step2_text).apply {
            setTextColor(activity.getColor(if (done) R.color.text else R.color.text_3))
            typeface = android.graphics.Typeface.create(if (done) "sans-serif-medium" else "sans-serif", android.graphics.Typeface.NORMAL)
        }
        val total = if (plain) 1 else 2
        find<View>(R.id.pair_step1).contentDescription = str(R.string.pair_step_label, 1, total,
            str(if (done) R.string.pair_step1_done else R.string.pair_step1), str(if (done) R.string.pair_step_done else R.string.pair_step_current))
        find<View>(R.id.pair_step2).contentDescription = str(R.string.pair_step_label, total, total, str(R.string.pair_step2),
            str(if (done) R.string.pair_step_current else R.string.pair_step_upcoming))
    }

    private fun setState(next: State, animate: Boolean = true) {
        val previous = state
        state = next
        main.removeCallbacks(poll)
        main.removeCallbacks(closedTick)
        if (next == State.CODE) sawStep1 = true
        setStepper()
        val compact = next == State.PIN
        val swap = {
            columns.visibility = if (compact) View.GONE else View.VISIBLE
            pinPanel.visibility = if (compact) View.VISIBLE else View.GONE
            codePanel.visibility = if (next == State.CODE) View.VISIBLE else View.GONE
            noMatchPanel.visibility = if (next == State.NOMATCH) View.VISIBLE else View.GONE
            closedPanel.visibility = if (next == State.CLOSED) View.VISIBLE else View.GONE
        }
        topTitle.text = when {
            compact && request.revoked -> str(R.string.pin_revoked_title, request.name)
            compact -> str(R.string.pin_title, request.name)
            else -> str(R.string.pair_title)
        }
        topStep.visibility = if (compact) View.VISIBLE else View.GONE
        topStep.text = if (request.plain) str(R.string.pin_step_of, 1, 1) else str(R.string.pin_step_of, 2, 2)
        val target = if (compact) pinPanel else find<View>(R.id.pair_right)
        if (animate && previous != next && view.isAttachedToWindow) {
            // Step 1 -> step 2: outgoing slides 16 left and fades (140 ms), incoming from 16 right (220 ms, +60 ms).
            val back = previous == State.PIN && next == State.CODE
            val d = Ui.dp(activity, 16f) * if (back) -1 else 1
            val out = if (previous == State.PIN) pinPanel else find<View>(R.id.pair_right)
            out.animate().cancel()
            out.animate().translationX(-d).alpha(0f).setDuration(140).setInterpolator(Ui.easeOut).withEndAction {
                out.translationX = 0f; out.alpha = 1f
                swap()
                target.translationX = d; target.alpha = 0f
                target.animate().translationX(0f).alpha(1f).setDuration(220).setInterpolator(Ui.easeOut).start()
                afterSwap(next)
            }.start()
        } else { swap(); target.translationX = 0f; target.alpha = 1f; afterSwap(next) }
    }

    private fun afterSwap(next: State) {
        when (next) {
            State.PIN -> { renderBoxes(); setCaption(); raiseKeyboard(); updateLocked() }
            State.CLOSED -> {
                hideKeyboard()
                closedSince = System.currentTimeMillis()
                find<TextView>(R.id.pair_closed_title).text = str(R.string.closed_title, request.name)
                val bodyText = closedBody(activity, request.platform, request.probe.hostUi)
                find<TextView>(R.id.pair_closed_body).text = if (hadWrong)
                    android.text.SpannableStringBuilder(str(R.string.closed_budget, request.name)).append(' ').append(bodyText) else bodyText
                closedSpinner.visibility = View.VISIBLE
                closedStatus.text = str(R.string.closed_waiting)
                main.postDelayed(poll, 3_000)
                main.postDelayed(closedTick, ScreenHost.SPINNER_STOP_MS)
            }
            else -> hideKeyboard()
        }
        Ui.announceTitle(title)
    }

    private fun codesMatch() {
        checked = request.probe.presented
        setState(if (request.probe.pairingOpen) State.PIN else State.CLOSED)
    }

    private fun shownDigits(): String = wrongDigits ?: input.text.toString()

    private fun renderBoxes() {
        val digits = shownDigits()
        val error = wrongDigits != null
        val locked = System.currentTimeMillis() < lockedUntil
        for (i in 0 until 6) {
            val box = boxes.getChildAt(i)
            val text = box.findViewById<TextView>(R.id.pin_box_text)
            text.text = digits.getOrNull(i)?.toString().orEmpty()
            text.setTextColor(activity.getColor(if (error) R.color.danger_text else R.color.text))
            val current = !error && !sending && !locked && i == digits.length
            box.setBackgroundResource(when { error -> R.drawable.bg_pin_box_error; current -> R.drawable.bg_pin_box_current; else -> R.drawable.bg_pin_box })
            box.findViewById<View>(R.id.pin_box_caret).visibility = if (current && digits.length < 6) View.VISIBLE else View.GONE
        }
        boxes.alpha = if (sending || locked) 0.6f else 1f
    }

    private fun setCaption(text: String = str(R.string.pin_hint), color: Int = R.color.text_3, icon: Int? = null, spinner: Boolean = false) {
        message.text = text
        message.setTextColor(activity.getColor(color))
        pinSpinner.visibility = if (spinner) View.VISIBLE else View.GONE
        messageIcon.visibility = if (icon != null) View.VISIBLE else View.GONE
        if (icon != null) {
            messageIcon.setImageResource(icon)
            messageIcon.imageTintList = activity.getColorStateList(color)
        }
    }

    private fun clearWrong() {
        wrongDigits = null
        setCaption()
    }

    private fun send(digits: String) {
        if (System.currentTimeMillis() < lockedUntil) return
        sending = true
        renderBoxes()
        setCaption(spinner = true, text = "")
        val run = generation
        val req = request
        val fingerprint = checked
        io.execute {
            val result = HostClient.pair(req.probe.endpoint, fingerprint, digits, deviceName(activity))
            main.post {
                if (run != generation) return@post
                sending = false
                when (result) {
                    is HostClient.Auth.Paired -> callbacks.paired(req, fingerprint, result.cookie)
                    HostClient.Auth.Wrong, HostClient.Auth.Invalid -> wrong(digits)
                    is HostClient.Auth.Locked -> locked(result.retryInMs)
                    HostClient.Auth.Closed -> { input.setText(""); setState(State.CLOSED) }
                    HostClient.Auth.Failed -> {
                        input.setText("")
                        renderBoxes()
                        setCaption(str(R.string.pin_failed, req.name), R.color.danger_text, R.drawable.ic_shield)
                    }
                }
            }
        }
    }

    private fun wrong(digits: String) {
        hadWrong = true
        wrongDigits = digits
        input.setText("")
        renderBoxes()
        setCaption(str(R.string.pin_wrong, request.name), R.color.danger_text, R.drawable.ic_shield)
        Ui.shake(boxes)
        Ui.hapticReject(boxes)
        // The tenth wrong PIN anywhere closes pairing: notice it and say so (spec 4.8).
        val run = generation
        io.execute {
            val answer = (HostClient.probe(request.probe.endpoint) as? HostClient.Result.Answer)?.probe
            main.post {
                if (run == generation && answer != null && answer.hostId == request.probe.hostId && !answer.pairingOpen && state == State.PIN)
                    setState(State.CLOSED)
            }
        }
    }

    private fun locked(ms: Long) {
        lockedUntil = System.currentTimeMillis() + ms
        input.setText("")
        wrongDigits = null
        updateLocked()
    }

    private fun updateLocked() {
        main.removeCallbacks(countdown)
        val left = lockedUntil - System.currentTimeMillis()
        if (left <= 0) {
            if (!input.isEnabled) { input.isEnabled = true; setCaption(); renderBoxes(); raiseKeyboard() }
            return
        }
        input.isEnabled = false
        val seconds = (left + 999) / 1000
        setCaption(str(R.string.pin_locked, "%d:%02d".format(seconds / 60, seconds % 60)), R.color.danger_text, R.drawable.ic_clock)
        renderBoxes()
        main.postDelayed(countdown, ((left - 1) % 1000) + 1)
    }

    /** Called by the activity after the session is in the WebView store. */
    fun showPaired() {
        hideKeyboard()
        boxes.alpha = 1f
        setCaption(str(R.string.pin_paired), R.color.accent, R.drawable.ic_check)
        Ui.hapticSuccess(boxes)
    }

    private fun pollHealth() {
        val run = generation
        val req = request
        io.execute {
            val answer = (HostClient.probe(req.probe.endpoint) as? HostClient.Result.Answer)?.probe
            main.post {
                if (run != generation || state != State.CLOSED || answer == null) return@post
                // Same computer, same certificate: continue by itself when pairing opens.
                if (answer.hostId == req.probe.hostId && answer.presented == req.probe.presented && answer.pairingOpen) {
                    request = req.copy(probe = req.probe.copy(pairingOpen = true))
                    setState(State.PIN)
                }
            }
        }
    }

    private fun raiseKeyboard() {
        if (state != State.PIN || !input.isEnabled) return
        input.requestFocus()
        input.post { WindowCompat.getInsetsController(activity.window, input).show(WindowInsetsCompat.Type.ime()) }
    }

    private fun hideKeyboard() {
        WindowCompat.getInsetsController(activity.window, input).hide(WindowInsetsCompat.Type.ime())
        input.clearFocus()
    }

    override fun onShown() { if (state == State.CLOSED) { main.removeCallbacks(poll); main.postDelayed(poll, 3_000) } }

    override fun onHidden() {
        generation++
        main.removeCallbacks(poll)
        main.removeCallbacks(countdown)
        main.removeCallbacks(closedTick)
        hideKeyboard()
    }

    override fun onBack(): Boolean {
        when {
            (state == State.PIN || state == State.CLOSED) && sawStep1 && !request.plain -> { generation++; setState(State.CODE) }
            state == State.NOMATCH -> setState(State.CODE)
            else -> callbacks.cancelled(request)
        }
        return true
    }

    companion object {
        /**
         * The name the user gave this phone (Settings > About phone; `Settings.Global.DEVICE_NAME`,
         * API 25+, no permission), else the model, else "Android phone" (HOST-CONTROL-PAGE 10.8, D2).
         */
        fun deviceName(context: android.content.Context): String {
            val named = if (android.os.Build.VERSION.SDK_INT >= 25) try {
                android.provider.Settings.Global.getString(context.contentResolver, android.provider.Settings.Global.DEVICE_NAME)
            } catch (_: Exception) { null } else null
            return DisplayName.clean(named, 60).ifEmpty { DisplayName.clean(android.os.Build.MODEL, 60) }.ifEmpty { "Android phone" }
        }

        /** S6 / Q9 closed body for the computer's platform, with the host-UI wording when it has one. */
        fun closedBody(activity: Activity, platform: String, hostUi: Boolean): CharSequence {
            val mac = DisplayName.normalizePlatform(platform) == "macos"
            return when {
                hostUi -> Ui.rich(activity, activity.getString(if (mac) R.string.closed_body_mac_ui else R.string.closed_body_windows_ui),
                    strong = listOf(activity.getString(R.string.pair_new_phone)))
                mac -> Ui.rich(activity, activity.getString(R.string.closed_body_mac), commands = listOf("npm run info"))
                else -> Ui.rich(activity, activity.getString(R.string.closed_body_windows), strong = listOf("Show connection info"))
            }
        }
    }
}
