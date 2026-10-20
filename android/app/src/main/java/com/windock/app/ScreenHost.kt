package com.windock.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.max

/** One native screen inflated into the container above the WebView. */
abstract class Screen(protected val activity: Activity, layout: Int) {
    val view: View = activity.layoutInflater.inflate(layout, FrameLayout(activity), false)
    /** Waiting screens dim to 60% after 2 minutes without a touch (spec 9.4). */
    open val waiting: Boolean get() = false
    /** Where TalkBack focus goes when the screen appears. */
    open val title: View? get() = null
    open fun onShown() {}
    /** Stop timers and polling; the screen may be shown again later. */
    open fun onHidden() {}
    /** System Back; true when handled here. */
    open fun onBack(): Boolean = false
    protected fun <T : View> find(id: Int): T = view.findViewById(id)
    protected fun str(id: Int, vararg args: Any): String = activity.getString(id, *args)
}

/**
 * Swaps screens with a 200 ms crossfade and owns the shared frame: side insets of at
 * least 40 dp (or the cutout), and the idle dim of waiting screens.
 */
class ScreenHost(private val activity: Activity, val container: FrameLayout, private val underlay: View? = null) {
    private val main = Handler(Looper.getMainLooper())
    var current: Screen? = null
        private set
    private var dimmed = false
    private val dim = Runnable {
        val v = current?.view ?: return@Runnable
        dimmed = true
        v.animate().cancel()
        v.animate().alpha(0.6f).setDuration(1000).setInterpolator(Ui.ease).start()
    }
    /** A screen is showing or fading in (not the launch blank, not a fade-out to the dock). */
    val visible: Boolean get() = container.visibility == View.VISIBLE && current != null

    init {
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            val min = Ui.dp(activity, 40f).toInt()
            v.setPadding(max(min, cutout.left), 0, max(min, cutout.right), 0)
            insets
        }
        container.setPadding(Ui.dp(activity, 40f).toInt(), 0, Ui.dp(activity, 40f).toInt(), 0)
    }

    fun show(screen: Screen, fadeMs: Long = 200) {
        val previous = current
        if (previous === screen) { reveal(fadeMs); return }
        current = screen
        main.removeCallbacks(dim)
        dimmed = false
        (screen.view.parent as? ViewGroup)?.removeView(screen.view)
        screen.view.animate().cancel()
        screen.view.alpha = if (fadeMs > 0 && previous != null) 0f else 1f
        container.addView(screen.view, FrameLayout.LayoutParams(-1, -1))
        previous?.let { old ->
            old.onHidden()
            if (fadeMs > 0) old.view.animate().alpha(0f).setDuration(fadeMs).setInterpolator(Ui.easeOut)
                .withEndAction { if (current !== old) container.removeView(old.view) }.start()
            else container.removeView(old.view)
        }
        if (fadeMs > 0 && previous != null) Ui.fade(screen.view, 1f, fadeMs)
        reveal(if (previous == null) fadeMs else 0)
        screen.onShown()
        screen.title?.let(Ui::announceTitle)
        if (screen.waiting) main.postDelayed(dim, DIM_AFTER_MS)
    }

    /**
     * While a native screen covers the dock, the WebView may neither take focus (its page
     * would steal the IME from native fields) nor be read by TalkBack.
     */
    private fun cover(covered: Boolean) {
        val web = underlay ?: return
        web.isFocusable = !covered
        web.isFocusableInTouchMode = !covered
        web.importantForAccessibility = if (covered) View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        if (covered && web.hasFocus()) web.clearFocus()
    }

    /** Make the container itself visible again (over the dock). */
    fun reveal(fadeMs: Long) {
        cover(true)
        container.animate().cancel()
        if (container.visibility != View.VISIBLE) { container.alpha = if (fadeMs > 0) 0f else 1f; container.visibility = View.VISIBLE }
        if (fadeMs > 0) container.animate().alpha(1f).setDuration(fadeMs).setInterpolator(Ui.easeOut).start()
        else container.alpha = 1f
    }

    /** An empty container: the launch grace period shows only the background. */
    fun blank() {
        current?.let { it.onHidden(); container.removeView(it.view) }
        current = null
        main.removeCallbacks(dim)
        reveal(0)
    }

    /** Dock ready: fade the native overlay out over the painted WebView. */
    fun hide(fadeMs: Long, then: () -> Unit = {}) {
        main.removeCallbacks(dim)
        val old = current
        current = null
        old?.onHidden()
        container.animate().cancel()
        container.animate().alpha(0f).setDuration(fadeMs).setInterpolator(Ui.easeOut).withEndAction {
            if (current == null) {
                container.visibility = View.GONE
                container.removeAllViews()
                cover(false)
            }
            then()
        }.start()
    }

    /** Any touch: undim within 150 ms and restart the 2 minute timer. */
    fun userActivity() {
        val screen = current ?: return
        if (!screen.waiting) return
        if (dimmed) {
            dimmed = false
            screen.view.animate().cancel()
            screen.view.animate().alpha(1f).setDuration(150).setInterpolator(Ui.ease).start()
        }
        main.removeCallbacks(dim)
        main.postDelayed(dim, DIM_AFTER_MS)
    }

    fun close() { main.removeCallbacks(dim); current?.onHidden() }

    companion object {
        const val DIM_AFTER_MS = 120_000L
        const val SPINNER_STOP_MS = 60_000L
    }
}
