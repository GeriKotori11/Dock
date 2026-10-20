package com.windock.app

import android.app.Activity
import android.os.SystemClock
import android.view.View
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView

/** S1 Connecting (spec 5.1): "Opening {name}" with one status line. */
class ConnectingScreen(activity: Activity, private val onOther: () -> Unit) : Screen(activity, R.layout.screen_connecting) {
    private val titleView: TextView = find(R.id.connecting_title)
    private val status: TextView = find(R.id.connecting_status)
    private val spinner: ProgressBar = find(R.id.connecting_spinner)
    private val check: ImageView = find(R.id.connecting_check)
    /** When the "new address" line appeared; it stays readable for at least 600 ms. */
    var movedShownAt = 0L
        private set

    override val title: View get() = titleView

    init {
        find<View>(R.id.connecting_other).setOnClickListener { onOther() }
    }

    fun bind(name: String) {
        titleView.text = str(R.string.connecting_title, name)
        setStatus(str(R.string.connecting_status_connecting), done = false)
        movedShownAt = 0L
    }

    fun looking(name: String) = setStatus(str(R.string.connecting_status_looking, name), done = false)

    fun moved(ip: String) {
        setStatus(str(R.string.connecting_status_moved, ip), done = true)
        movedShownAt = SystemClock.uptimeMillis()
    }

    private fun setStatus(text: String, done: Boolean) {
        if (status.text.toString() == text) return
        fun apply() {
            status.text = text
            spinner.visibility = if (done) View.GONE else View.VISIBLE
            check.visibility = if (done) View.VISIBLE else View.GONE
        }
        status.animate().cancel()
        if (status.text.isEmpty() || !view.isAttachedToWindow) { status.alpha = 1f; apply(); return }
        // Crossfade 150 ms; the last change wins.
        status.animate().alpha(0f).setDuration(75).withEndAction {
            apply()
            status.animate().alpha(1f).setDuration(75).start()
        }.start()
    }

    override fun onBack(): Boolean { onOther(); return true }
}
