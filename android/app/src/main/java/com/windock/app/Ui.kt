package com.windock.app

import android.animation.ObjectAnimator
import android.content.Context
import android.graphics.Typeface
import android.os.Build
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.text.style.TtsSpan
import android.text.style.TypefaceSpan
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.animation.LinearInterpolator
import android.view.animation.PathInterpolator
import android.view.accessibility.AccessibilityEvent

/** Shared motion, text and feedback helpers (spec sections 6 and 8). */
object Ui {
    /** ease-out cubic-bezier(0.23, 1, 0.32, 1). Animator duration scale 0 collapses it (reduced motion). */
    val easeOut = PathInterpolator(0.23f, 1f, 0.32f, 1f)
    val ease = PathInterpolator(0.25f, 0.1f, 0.25f, 1f)

    fun dp(context: Context, value: Float): Float = value * context.resources.displayMetrics.density

    fun color(context: Context, id: Int): Int = context.getColor(id)

    /** Fade from the current value, so a second call retargets instead of queueing. */
    fun fade(view: View, to: Float, duration: Long, then: (() -> Unit)? = null) {
        view.animate().cancel()
        if (to > 0f && view.visibility != View.VISIBLE) { view.alpha = 0f; view.visibility = View.VISIBLE }
        view.animate().alpha(to).setDuration(duration).setInterpolator(easeOut)
            .withEndAction { then?.invoke() }.start()
    }

    /** Wrong PIN: translateX 0, -10, 8, -6, 4, 0 over 320 ms (scaled away by "Remove animations"). */
    fun shake(view: View) {
        val d = dp(view.context, 1f)
        ObjectAnimator.ofFloat(view, View.TRANSLATION_X, 0f, -10 * d, 8 * d, -6 * d, 4 * d, 0f).apply {
            duration = 320; interpolator = LinearInterpolator(); start()
        }
    }

    fun hapticSuccess(view: View) {
        view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
    }

    fun hapticReject(view: View) {
        view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)
    }

    /** Screen change: TalkBack focus goes to the title. */
    fun announceTitle(view: View) {
        view.post {
            view.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_FOCUSED)
            view.performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null)
        }
    }

    /** `XXXX-XXXX-XXXX` with hyphens in text-3, spelled out for TalkBack. */
    fun securityCode(context: Context, code: String, mainColor: Int = R.color.text): CharSequence {
        val out = SpannableStringBuilder()
        code.split('-').forEachIndexed { i, group ->
            if (i > 0) {
                val s = out.length
                out.append('-')
                out.setSpan(ForegroundColorSpan(color(context, R.color.text_3)), s, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            val s = out.length
            out.append(group)
            out.setSpan(ForegroundColorSpan(color(context, mainColor)), s, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        val spoken = code.split('-').joinToString(", ") { it.toCharArray().joinToString(" ") }
        out.setSpan(TtsSpan.VerbatimBuilder(spoken).build(), 0, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        return out
    }

    /** Body text with an inline command chip (`npm run info`) and an emphasised menu item. */
    fun rich(context: Context, text: String, commands: List<String> = emptyList(), strong: List<String> = emptyList()): CharSequence {
        val out = SpannableStringBuilder(text)
        for (cmd in commands) {
            val i = text.indexOf(cmd); if (i < 0) continue
            out.setSpan(TypefaceSpan("monospace"), i, i + cmd.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(ForegroundColorSpan(color(context, R.color.text)), i, i + cmd.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(android.text.style.BackgroundColorSpan(color(context, R.color.white_7)), i, i + cmd.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        for (word in strong) {
            val i = text.indexOf(word); if (i < 0) continue
            out.setSpan(ForegroundColorSpan(color(context, R.color.text)), i, i + word.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(TypefaceSpan("sans-serif-medium"), i, i + word.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return out
    }

    /** Row subtitle parts joined by a text-3 "·"; addresses in mono 12, text-3 (decision D5). */
    fun subtitle(context: Context, parts: List<String>, address: String? = null): CharSequence {
        val out = SpannableStringBuilder()
        fun sep() {
            if (out.isEmpty()) return
            val s = out.length
            out.append("  ·  ")
            out.setSpan(ForegroundColorSpan(color(context, R.color.text_3)), s, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        parts.filter { it.isNotEmpty() }.forEach { sep(); out.append(it) }
        if (!address.isNullOrEmpty()) {
            sep()
            val s = out.length
            out.append(address)
            out.setSpan(TypefaceSpan("monospace"), s, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(RelativeSizeSpan(12f / 13f), s, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(ForegroundColorSpan(color(context, R.color.text_3)), s, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return out
    }

    fun mono(text: String): CharSequence = SpannableStringBuilder(text).apply {
        setSpan(TypefaceSpan("monospace"), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    fun bold(text: String): CharSequence = SpannableStringBuilder(text).apply {
        setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
}
