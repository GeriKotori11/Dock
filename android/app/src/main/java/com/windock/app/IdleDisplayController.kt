package com.windock.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import kotlin.math.min

/** Dims only this Activity's brightness while the dock is idle; no admin privileges.
 *  Keeping the screen on is the Activity's job (FLAG_KEEP_SCREEN_ON while resumed). */
class IdleDisplayController(private val activity: Activity,
                            private val clock: () -> Long = SystemClock::uptimeMillis) {
    private val handler = Handler(Looper.getMainLooper())
    private val originalBrightness = activity.window.attributes.screenBrightness
    private var lastInput = clock()
    private var active = false
    var policy = PhonePreferences.display(activity)
        private set
    var stage = DisplayPolicy.Stage.AWAKE
        private set
    private val tick = Runnable { refresh() }

    fun setActive(enabled: Boolean) {
        if (active == enabled) return
        active = enabled
        lastInput = clock()
        refresh()
    }

    fun reloadPreferences() {
        policy = PhonePreferences.display(activity)
        userActivity()
    }

    /** Returns true when the first gesture should only wake the dimmed dock. */
    fun userActivity(): Boolean {
        val waking = active && stage != DisplayPolicy.Stage.AWAKE
        lastInput = clock()
        refresh()
        return waking
    }

    private fun refresh() {
        handler.removeCallbacks(tick)
        val elapsed = (clock() - lastInput).coerceAtLeast(0)
        stage = if (active) policy.stage(elapsed) else DisplayPolicy.Stage.AWAKE
        val window = activity.window
        val brightness = when (stage) {
            DisplayPolicy.Stage.AWAKE -> originalBrightness
            DisplayPolicy.Stage.DIMMED -> {
                val current = if (originalBrightness >= 0) originalBrightness else
                    Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128) / 255f
                min(current, policy.dimPercent / 100f)
            }
        }
        if (window.attributes.screenBrightness != brightness) window.attributes = window.attributes.apply { screenBrightness = brightness }
        if (active) policy.nextDeadline(elapsed)?.let {
            handler.postDelayed(tick, (it - elapsed).coerceAtLeast(1))
        }
    }

    fun close() { setActive(false); handler.removeCallbacks(tick) }
}
