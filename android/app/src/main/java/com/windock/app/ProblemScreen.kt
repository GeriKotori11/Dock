package com.windock.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

/** S8 Can't reach, S9 No Wi-Fi and S10 Security code changed (spec 5.8 to 5.10). */
class ProblemScreen(activity: Activity) : Screen(activity, R.layout.screen_problem) {
    enum class Kind { CANT_REACH, NO_WIFI, CHANGED }

    private val main = Handler(Looper.getMainLooper())
    private val left: LinearLayout = find(R.id.problem_left)
    private val glyph: View = find(R.id.problem_glyph)
    private val icon: ImageView = find(R.id.problem_icon)
    private val titleView: TextView = find(R.id.problem_title)
    private val body: TextView = find(R.id.problem_body)
    private val statusRow: View = find(R.id.problem_status_row)
    private val spinner: ProgressBar = find(R.id.problem_spinner)
    private val status: TextView = find(R.id.problem_status)
    private val spacer: View = find(R.id.problem_spacer)
    private val buttons: View = find(R.id.problem_buttons)
    private val primary: Button = find(R.id.problem_primary)
    private val secondary: Button = find(R.id.problem_secondary)
    private val usb: View = find(R.id.problem_usb)
    private val right: LinearLayout = find(R.id.problem_right)
    var kind = Kind.CANT_REACH
        private set
    var computer: Computer? = null
        private set
    private var onBackAction: () -> Unit = {}
    private val longWait = Runnable {
        spinner.visibility = View.GONE
        status.text = str(R.string.reach_status_long)
    }

    override val waiting: Boolean get() = kind != Kind.CHANGED
    override val title: View get() = titleView

    private fun reset() {
        main.removeCallbacks(longWait)
        right.removeAllViews()
        statusRow.visibility = View.GONE
        usb.visibility = View.GONE
        buttons.visibility = View.VISIBLE
        spacer.visibility = View.VISIBLE
        left.gravity = Gravity.NO_GRAVITY
        body.textSize = 15f
        right.gravity = Gravity.NO_GRAVITY
        glyph.setBackgroundResource(R.drawable.bg_glyph_lg)
        icon.imageTintList = activity.getColorStateList(R.color.text_2)
        primary.setBackgroundResource(R.drawable.bg_button_primary)
        primary.setTextColor(activity.getColor(R.color.on_accent))
    }

    /** S8: likely cause first; retries continue in the coordinator while this is visible. */
    fun cantReach(c: Computer, diagnosis: ReachChecks.Result, onRetry: () -> Unit, onOther: () -> Unit, onUsb: (() -> Unit)?) {
        reset()
        kind = Kind.CANT_REACH; computer = c; onBackAction = onOther
        val name = c.displayName
        icon.setImageResource(R.drawable.ic_monitor)
        titleView.text = str(R.string.reach_title, name)
        body.text = str(R.string.reach_body, name)
        statusRow.visibility = View.VISIBLE
        spinner.visibility = View.VISIBLE
        status.text = str(R.string.reach_status)
        primary.setText(R.string.reach_retry)
        primary.setOnClickListener { onRetry() }
        secondary.visibility = View.VISIBLE
        secondary.setText(R.string.reach_other)
        secondary.setOnClickListener { onOther() }
        if (onUsb != null) { usb.visibility = View.VISIBLE; usb.setOnClickListener { onUsb() } }
        diagnosis.checks.forEachIndexed { i, check ->
            val card = activity.layoutInflater.inflate(R.layout.item_check, right, false)
            val likely = check == diagnosis.likely
            card.findViewById<TextView>(R.id.check_number).apply {
                text = (i + 1).toString()
                setBackgroundResource(if (likely) R.drawable.bg_number_likely else R.drawable.bg_number)
                setTextColor(activity.getColor(if (likely) R.color.accent else R.color.text_2))
            }
            if (likely) {
                card.setBackgroundResource(R.drawable.bg_card_likely)
                card.findViewById<View>(R.id.check_tag).visibility = View.VISIBLE
            }
            val (t, b) = when (check) {
                ReachChecks.Check.SUBNET -> str(R.string.check_subnet_title) to
                    Ui.rich(activity, str(R.string.check_subnet_body, diagnosis.phoneIp ?: "?", name, c.address),
                        commands = listOfNotNull(diagnosis.phoneIp, c.address).filter { it.isNotEmpty() })
                ReachChecks.Check.RUNNING -> str(R.string.check_running_title, name) to
                    if (DisplayName.normalizePlatform(c.platform) == "macos")
                        Ui.rich(activity, str(R.string.check_running_mac), commands = listOf("npm run mac:status"))
                    else str(R.string.check_running_windows)
                ReachChecks.Check.ISOLATION -> str(R.string.check_isolation_title) to str(R.string.check_isolation_body)
                ReachChecks.Check.FIREWALL -> str(R.string.check_firewall_title) to str(R.string.check_firewall_body)
            }
            card.findViewById<TextView>(R.id.check_title).text = t
            card.findViewById<TextView>(R.id.check_body).text = b
            right.addView(card)
        }
        main.postDelayed(longWait, ScreenHost.SPINNER_STOP_MS)
    }

    /** Try again pressed: the status line restarts. */
    fun restartStatus() {
        if (kind != Kind.CANT_REACH) return
        main.removeCallbacks(longWait)
        spinner.visibility = View.VISIBLE
        status.text = str(R.string.reach_status)
        main.postDelayed(longWait, ScreenHost.SPINNER_STOP_MS)
    }

    /** S9: an explanation after an attempt failed; leaves by itself when a link appears. */
    fun noWifi(c: Computer, onSettings: () -> Unit, onUsb: (() -> Unit)?, onOther: () -> Unit) {
        reset()
        kind = Kind.NO_WIFI; computer = c; onBackAction = onOther
        icon.setImageResource(R.drawable.ic_wifi_off)
        titleView.text = str(R.string.wifi_title)
        body.text = str(R.string.wifi_body, c.displayName)
        buttons.visibility = View.GONE
        spacer.visibility = View.GONE
        left.gravity = Gravity.CENTER_VERTICAL
        val width = Ui.dp(activity, 300f).toInt()
        fun add(style: Int, text: Int, iconRes: Int?, click: () -> Unit) {
            val b = Button(activity, null, 0, style).apply {
                setText(text); setOnClickListener { click() }
                if (iconRes != null) {
                    val d = activity.getDrawable(iconRes)!!.mutate()
                    val size = Ui.dp(activity, 18f).toInt()
                    d.setBounds(0, 0, size, size); d.setTint(activity.getColor(R.color.text))
                    setCompoundDrawablesRelative(d, null, null, null)
                    compoundDrawablePadding = Ui.dp(activity, 8f).toInt()
                }
            }
            right.addView(b, LinearLayout.LayoutParams(width, Ui.dp(activity, 48f).toInt()).apply {
                bottomMargin = Ui.dp(activity, 12f).toInt(); gravity = Gravity.CENTER_HORIZONTAL })
        }
        add(R.style.Btn_Primary, R.string.wifi_settings, null, onSettings)
        if (onUsb != null) add(R.style.Btn_Secondary, R.string.wifi_usb, R.drawable.ic_usb, onUsb)
        add(R.style.Btn_Ghost, R.string.reach_other, null, onOther)
        right.gravity = Gravity.CENTER_HORIZONTAL
    }

    /** S10: both codes; "Not now" is the default and the Back action. */
    fun changed(c: Computer, pinned: String?, presented: String?, onForget: () -> Unit, onNotNow: () -> Unit) {
        reset()
        kind = Kind.CHANGED; computer = c; onBackAction = onNotNow
        val name = c.displayName
        glyph.setBackgroundResource(R.drawable.bg_glyph_lg_danger)
        icon.setImageResource(R.drawable.ic_shield)
        icon.imageTintList = activity.getColorStateList(R.color.danger_text)
        titleView.text = str(R.string.changed_title, name)
        body.text = str(R.string.changed_body, name)
        body.textSize = 14f
        primary.setText(R.string.changed_forget)
        primary.setBackgroundResource(R.drawable.bg_button_danger)
        primary.setTextColor(activity.getColor(R.color.danger_text))
        primary.setOnClickListener { onForget() }
        secondary.visibility = View.VISIBLE
        secondary.setText(R.string.changed_not_now)
        secondary.setOnClickListener { onNotNow() }
        fun card(label: Int, fingerprint: String?, now: Boolean) {
            val v = activity.layoutInflater.inflate(R.layout.item_code_card, right, false)
            v.findViewById<TextView>(R.id.code_card_label).setText(label)
            v.findViewById<TextView>(R.id.code_card_code).text = fingerprint?.let {
                Ui.securityCode(activity, Fingerprint.securityCode(it), if (now) R.color.text else R.color.text_2)
            } ?: str(R.string.changed_none)
            if (now) v.setBackgroundResource(R.drawable.bg_card_danger)
            right.addView(v)
        }
        card(R.string.changed_then, pinned, false)
        card(R.string.changed_now, presented, true)
        right.addView(TextView(activity).apply {
            textSize = 13f; setTextColor(activity.getColor(R.color.text_3))
            text = str(R.string.changed_howto, name)
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = Ui.dp(activity, 8f).toInt() })
        Ui.hapticReject(view)
        secondary.post { secondary.requestFocus() }
    }

    override fun onHidden() { main.removeCallbacks(longWait) }

    override fun onBack(): Boolean { onBackAction(); return true }
}
