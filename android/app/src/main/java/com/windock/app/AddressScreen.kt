package com.windock.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.concurrent.ExecutorService

/** S7 Add by address (spec 4.6, 5.7). A bare address means port 8620, shown as ghost text. */
class AddressScreen(activity: Activity, private val io: ExecutorService, private val callbacks: Callbacks) :
    Screen(activity, R.layout.screen_address) {

    interface Callbacks {
        fun cancelled()
        /** Something answered at the address; the activity decides by host ID. */
        fun answered(probe: Probe)
    }

    private val main = Handler(Looper.getMainLooper())
    private val input: EditText = find(R.id.address_input)
    private val suffix: TextView = find(R.id.address_suffix)
    private val connect: View = find(R.id.address_connect)
    private val connectText: TextView = find(R.id.address_connect_text)
    private val spinner: ProgressBar = find(R.id.address_spinner)
    private val message: TextView = find(R.id.address_message)
    private val errorIcon: ImageView = find(R.id.address_error_icon)
    private var generation = 0

    override val title: View get() = input

    init {
        find<View>(R.id.address_back).setOnClickListener { callbacks.cancelled() }
        connect.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_GO || action == EditorInfo.IME_ACTION_DONE) submit(); true
        }
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) { updateSuffix() }
        })
        resetMessage()
    }

    fun bind(prefill: String = "") {
        generation++
        setBusy(false)
        input.setText(prefill)
        input.setSelection(input.text.length)
        resetMessage()
    }

    private fun updateSuffix() {
        val text = input.text.toString()
        val show = text.isNotEmpty() && ':' !in text && "://" !in text
        suffix.visibility = if (show) View.VISIBLE else View.GONE
        if (show) suffix.translationX = input.paddingStart + input.paint.measureText(text) + Ui.dp(activity, 4f)
    }

    private fun resetMessage() {
        errorIcon.visibility = View.GONE
        message.setTextColor(activity.getColor(R.color.text_3))
        message.text = Ui.rich(activity, str(R.string.address_hint), commands = listOf("npm run info"))
    }

    private fun error(text: String) {
        errorIcon.visibility = View.VISIBLE
        message.setTextColor(activity.getColor(R.color.danger_text))
        message.text = text
        message.announceForAccessibility(text)
        input.requestFocus()
    }

    private fun setBusy(busy: Boolean) {
        connect.isEnabled = !busy
        input.isEnabled = !busy
        spinner.visibility = if (busy) View.VISIBLE else View.GONE
        connectText.setText(if (busy) R.string.address_checking else R.string.address_connect)
    }

    private fun submit() {
        val raw = input.text.toString().trim()
        val endpoint = EndpointPolicy.normalize(raw)
        if (endpoint == null) {
            val host = raw.substringAfter("://").substringBefore('/').substringBefore(':')
            val ipv4 = host.matches(Regex("\\d{1,3}(\\.\\d{1,3}){3}"))
            return error(str(if (ipv4) R.string.address_public else R.string.address_invalid))
        }
        resetMessage()
        setBusy(true)
        val run = ++generation
        val shown = raw.substringAfter("://").trimEnd('/').let { if (':' in it) it else "$it:8620" }
        io.execute {
            val result = HostClient.probe(endpoint, timeoutMs = 4000)
            main.post {
                if (run != generation) return@post
                setBusy(false)
                val probe = (result as? HostClient.Result.Answer)?.probe
                if (probe?.hostId == null) error(str(R.string.address_no_answer, shown))
                else callbacks.answered(probe)
            }
        }
    }

    /** The answer could not be used (unverifiable TLS): same message as no answer. */
    fun noAnswer() {
        error(str(R.string.address_no_answer, input.text.toString().trim().let { if (':' in it) it else "$it:8620" }))
    }

    override fun onShown() {
        input.requestFocus()
        input.post { WindowCompat.getInsetsController(activity.window, input).show(WindowInsetsCompat.Type.ime()) }
    }

    override fun onHidden() {
        generation++
        WindowCompat.getInsetsController(activity.window, input).hide(WindowInsetsCompat.Type.ime())
    }

    override fun onBack(): Boolean { callbacks.cancelled(); return true }
}
