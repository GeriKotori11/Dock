package com.windock.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import java.util.concurrent.ExecutorService

/**
 * Q5 to Q9 (docs/design/HOST-CONTROL-PAGE.md 10.5 to 10.7): confirm a scanned
 * `windock://pair` link, then pair with it. Nothing touches the network before Pair. The
 * PIN goes only over a connection whose TLS handshake presented the scanned certificate,
 * to the scanned host ID; the computer and its pin are saved only after a 200.
 */
class QrPairScreen(activity: Activity, private val io: ExecutorService, private val callbacks: Callbacks) :
    Screen(activity, R.layout.screen_qr, R.id.qr_columns) {

    interface Callbacks {
        fun cancelled()
        /** 200 from /api/auth: save the pin and computer, hand the session over, then call [showPaired]. */
        fun paired(link: PairLink, probe: Probe, session: SessionCookie)
        /** Q8 "Enter the PIN instead": step 2 with the scanned certificate already pinned. */
        fun enterPin(probe: Probe)
        fun openCamera(): Boolean
        /** Q10: steps 1 and 2 found nothing. The activity shows it, then calls [retryWhileUnreachable]. */
        fun unreachable(link: PairLink, failure: ProbeFailure?, otherDevice: Boolean)
        fun unreachableShowing(): Boolean
        /** A background retry from Q10 verified the computer: bring this screen back. */
        fun resume()
        /** Verified discovery results right now (step 2 of 10.6). */
        fun discovered(): List<Probe>
        /** [scans] changed. */
        fun scanningChanged()
        /** The scanned computer answered with its scanned identity. */
        fun seen(probe: Probe)
    }

    private enum class State { CONFIRM, PAIRING, PAIRED, USED, CLOSED }

    private val main = Handler(Looper.getMainLooper())
    private val glyph: FrameLayout = find(R.id.qr_glyph)
    private val icon: ImageView = find(R.id.qr_icon)
    private val titleView: TextView = find(R.id.qr_title)
    private val body: TextView = find(R.id.qr_body)
    private val statusRow: View = find(R.id.qr_status_row)
    private val statusSpinner: ProgressBar = find(R.id.qr_status_spinner)
    private val confirmPanel: View = find(R.id.qr_confirm_panel)
    private val usedPanel: View = find(R.id.qr_used_panel)
    private val closedPanel: View = find(R.id.qr_closed_panel)
    private val pairButton: View = find(R.id.qr_pair)
    private val pairSpinner: ProgressBar = find(R.id.qr_pair_spinner)
    private val pairText: TextView = find(R.id.qr_pair_text)
    private val buttons: View = find(R.id.qr_buttons)
    private val done: View = find(R.id.qr_done)
    private val messageRow: View = find(R.id.qr_message_row)
    private val messageIcon: ImageView = find(R.id.qr_message_icon)
    private val message: TextView = find(R.id.qr_message)
    private val usedCamera: View = find(R.id.qr_used_camera)

    lateinit var link: PairLink
        private set
    private var again = false
    private var state = State.CONFIRM
    private var generation = 0
    /** The answer that proved the scanned identity (step 1 or 2). */
    private var verified: Probe? = null
    private var lockedUntil = 0L

    val paired: Boolean get() = state == State.PAIRED
    override val waiting: Boolean get() = state == State.CLOSED
    override val title: View get() = titleView
    /** Q5 and Q8 send nothing, so discovery stays off while they are up. */
    override val scans: Boolean get() = state == State.PAIRING || state == State.CLOSED || state == State.PAIRED

    private val countdown = Runnable { updateLocked() }
    private val spinnerStop = Runnable { statusSpinner.visibility = View.GONE }

    init {
        find<View>(R.id.qr_back).setOnClickListener { onBack() }
        find<View>(R.id.qr_cancel).setOnClickListener { cancel() }
        pairButton.setOnClickListener { pair() }
        usedCamera.setOnClickListener { if (!callbacks.openCamera()) usedCamera.visibility = View.GONE }
        find<View>(R.id.qr_used_pin).setOnClickListener { verified?.let(callbacks::enterPin) ?: cancel() }
        find<TextView>(R.id.qr_code).accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: android.view.accessibility.AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.hintText = str(R.string.pair_code_a11y)
            }
        }
    }

    /** A new link replaces whatever this screen was doing (spec 10.4). */
    fun bind(link: PairLink, again: Boolean) {
        abort()
        this.link = link
        this.again = again
        verified = null
        lockedUntil = 0L
        find<TextView>(R.id.qr_address).text = link.address
        find<TextView>(R.id.qr_code).text = Ui.securityCode(activity, link.securityCode)
        find<View>(R.id.qr_address_row).contentDescription = "${str(R.string.confirm_address)}, ${link.address}"
        setState(State.CONFIRM)
    }

    /** Stops any attempt in flight; its answer is ignored. */
    fun abort() {
        generation++
        main.removeCallbacksAndMessages(null)
    }

    private fun cancel() {
        abort()
        callbacks.cancelled()
    }

    private fun setState(next: State, error: CharSequence? = null) {
        val changedScans = scans
        state = next
        main.removeCallbacks(spinnerStop)
        val name = link.displayName
        confirmPanel.visibility = if (next == State.CONFIRM || next == State.PAIRING || next == State.PAIRED) View.VISIBLE else View.GONE
        usedPanel.visibility = if (next == State.USED) View.VISIBLE else View.GONE
        closedPanel.visibility = if (next == State.CLOSED) View.VISIBLE else View.GONE
        statusRow.visibility = if (next == State.CLOSED) View.VISIBLE else View.GONE
        when (next) {
            State.CONFIRM, State.PAIRING, State.PAIRED -> {
                glyph.setBackgroundResource(R.drawable.bg_glyph_lg_accent)
                icon.setImageResource(R.drawable.ic_monitor)
                icon.imageTintList = activity.getColorStateList(R.color.accent)
                titleView.text = str(if (again) R.string.confirm_again else R.string.confirm_title, name)
                body.text = str(R.string.confirm_body)
                val busy = next != State.CONFIRM
                buttons.visibility = if (next == State.PAIRED) View.GONE else View.VISIBLE
                done.visibility = if (next == State.PAIRED) View.VISIBLE else View.GONE
                pairSpinner.visibility = if (next == State.PAIRING) View.VISIBLE else View.GONE
                pairText.setText(if (next == State.PAIRING) R.string.confirm_pairing else R.string.confirm_pair)
                pairButton.isEnabled = !busy
                pairButton.alpha = if (busy) 0.7f else 1f
                if (error != null) showMessage(error, R.drawable.ic_shield) else if (next != State.CONFIRM || lockedUntil == 0L) hideMessage()
                if (next == State.CONFIRM) updateLocked()
            }
            State.USED -> {
                glyph.setBackgroundResource(R.drawable.bg_glyph_lg)
                icon.setImageResource(R.drawable.ic_qr)
                icon.imageTintList = activity.getColorStateList(R.color.text_2)
                titleView.text = str(R.string.used_title)
                body.text = str(R.string.used_body, name)
                find<TextView>(R.id.qr_used_where).text =
                    Ui.rich(activity, str(R.string.used_where), strong = listOf(str(R.string.pair_new_phone)))
                usedCamera.visibility = if (QrCamera.available(activity)) View.VISIBLE else View.GONE
                Ui.hapticReject(view)
            }
            State.CLOSED -> {
                glyph.setBackgroundResource(R.drawable.bg_glyph_lg)
                icon.setImageResource(R.drawable.ic_clock)
                icon.imageTintList = activity.getColorStateList(R.color.text_2)
                titleView.text = str(R.string.closed_title, name)
                val probe = verified
                body.text = PairingScreen.closedBody(activity, probe?.platform.orEmpty(), probe?.hostUi == true)
                statusSpinner.visibility = View.VISIBLE
                main.postDelayed(spinnerStop, ScreenHost.SPINNER_STOP_MS)
                schedulePoll(generation)
            }
        }
        if (changedScans != scans) callbacks.scanningChanged()
        if (next != State.PAIRING && next != State.PAIRED) Ui.announceTitle(titleView)
    }

    private fun showMessage(text: CharSequence, iconRes: Int) {
        messageRow.visibility = View.VISIBLE
        message.text = text
        messageIcon.setImageResource(iconRes)
        messageIcon.imageTintList = activity.getColorStateList(R.color.danger_text)
    }

    private fun hideMessage() { messageRow.visibility = View.GONE }

    // ---- 10.6 What Pair does -------------------------------------------------------------

    private fun pair() {
        if (state != State.CONFIRM || System.currentTimeMillis() < lockedUntil) return
        abort()
        setState(State.PAIRING)
        attempt(generation, silent = false)
    }

    /** Steps 1 and 2. `silent` while Q10 is up: only a verified answer comes back to this screen. */
    private fun attempt(run: Int, silent: Boolean) {
        val target = link
        io.execute {
            val first = HostClient.probePinned(target.endpoint, target.fingerprint)
            main.post {
                if (run != generation) return@post
                when (first) {
                    is HostClient.Pinned.Answer ->
                        if (QrDecision.accepts(target, first.probe)) verifiedAnswer(run, first.probe, silent)
                        else search(run, silent, otherDevice = true, failure = null)
                    HostClient.Pinned.OtherCertificate -> search(run, silent, otherDevice = true, failure = null)
                    is HostClient.Pinned.Failed -> search(run, silent, otherDevice = false, failure = first.why)
                }
            }
        }
    }

    /** Step 2: discovery for up to 8 s; only the scanned host ID behind the scanned certificate counts. */
    private fun search(run: Int, silent: Boolean, otherDevice: Boolean, failure: ProbeFailure?) {
        val target = link
        val until = SystemClock.uptimeMillis() + SEARCH_MS
        val tick = object : Runnable {
            override fun run() {
                if (run != generation) return
                val hit = callbacks.discovered().firstOrNull { QrDecision.accepts(target, it) }
                if (hit != null) {
                    io.execute {
                        // Confirm over a pinned connection before anything else is sent there.
                        val pinned = HostClient.probePinned(hit.endpoint, target.fingerprint)
                        main.post {
                            if (run != generation) return@post
                            if (pinned is HostClient.Pinned.Answer && QrDecision.accepts(target, pinned.probe)) verifiedAnswer(run, pinned.probe, silent)
                            else giveUp(run, silent, otherDevice, failure)
                        }
                    }
                    return
                }
                if (SystemClock.uptimeMillis() >= until) giveUp(run, silent, otherDevice, failure)
                else main.postDelayed(this, 500)
            }
        }
        main.post(tick)
    }

    private fun giveUp(run: Int, silent: Boolean, otherDevice: Boolean, failure: ProbeFailure?) {
        if (silent) scheduleRetry(run, RETRY_MS)
        else callbacks.unreachable(link, failure, otherDevice)
    }

    /** Q10 is up: keep trying while it stays visible (spec 10.7). */
    fun retryWhileUnreachable() {
        abort()
        scheduleRetry(generation, RETRY_MS)
    }

    /** Q10 Try again. */
    fun retryNow() {
        abort()
        attempt(generation, silent = true)
    }

    private fun scheduleRetry(run: Int, delay: Long) {
        main.postDelayed({ if (run == generation && callbacks.unreachableShowing()) attempt(run, silent = true) }, delay)
    }

    private fun verifiedAnswer(run: Int, probe: Probe, silent: Boolean) {
        verified = probe
        callbacks.seen(probe)
        if (silent) {
            callbacks.resume()
            if (run != generation) return
            setState(State.PAIRING)
        }
        if (!probe.pairingOpen) { setState(State.CLOSED); return }
        auth(run, probe)
    }

    /** Step 3: `POST /api/auth` with the scanned PIN, over a connection that accepts only the scanned certificate. */
    private fun auth(run: Int, probe: Probe) {
        val target = link
        val device = PairingScreen.deviceName(activity)
        if (state != State.PAIRING) setState(State.PAIRING)
        io.execute {
            val result = HostClient.pair(probe.endpoint, target.fingerprint, target.pin, device)
            main.post {
                if (run != generation) return@post
                when (result) {
                    is HostClient.Auth.Paired -> callbacks.paired(target, probe, result.cookie)
                    HostClient.Auth.Wrong, HostClient.Auth.Invalid -> setState(State.USED)
                    is HostClient.Auth.Locked -> { lockedUntil = System.currentTimeMillis() + result.retryInMs; setState(State.CONFIRM) }
                    HostClient.Auth.Closed -> setState(State.CLOSED)
                    HostClient.Auth.Failed -> setState(State.CONFIRM, error = str(R.string.pin_failed, target.displayName))
                }
            }
        }
    }

    /** Q9: poll every 2 s; when pairing opens, pair with the scanned PIN (decision D4). */
    private fun schedulePoll(run: Int) {
        main.postDelayed({
            if (run != generation || state != State.CLOSED) return@postDelayed
            val target = link
            val at = verified?.endpoint ?: target.endpoint
            io.execute {
                val answer = HostClient.probePinned(at, target.fingerprint)
                main.post {
                    if (run != generation || state != State.CLOSED) return@post
                    val probe = (answer as? HostClient.Pinned.Answer)?.probe?.takeIf { QrDecision.accepts(target, it) }
                    if (probe != null && probe.pairingOpen) {
                        verified = probe
                        statusSpinner.visibility = View.VISIBLE
                        setState(State.PAIRING)
                        auth(run, probe)
                    } else schedulePoll(run)
                }
            }
        }, POLL_MS)
    }

    private fun updateLocked() {
        main.removeCallbacks(countdown)
        if (state != State.CONFIRM) return
        val left = lockedUntil - System.currentTimeMillis()
        if (left <= 0) {
            if (lockedUntil != 0L) { lockedUntil = 0L; hideMessage() }
            pairButton.isEnabled = true
            pairButton.alpha = 1f
            return
        }
        pairButton.isEnabled = false
        pairButton.alpha = 0.5f
        val seconds = (left + 999) / 1000
        showMessage(str(R.string.pin_locked, "%d:%02d".format(seconds / 60, seconds % 60)), R.drawable.ic_clock)
        main.postDelayed(countdown, ((left - 1) % 1000) + 1)
    }

    /** Called by the activity once the session is in the WebView store (Q7). */
    fun showPaired() {
        setState(State.PAIRED)
        Ui.hapticSuccess(done)
    }

    override fun onHidden() {
        // Leaving for the dock, Q10 or another screen: nothing here keeps running.
        abort()
    }

    override fun onBack(): Boolean { cancel(); return true }

    companion object {
        private const val SEARCH_MS = 8_000L
        private const val RETRY_MS = 3_000L
        private const val POLL_MS = 2_000L
    }
}
