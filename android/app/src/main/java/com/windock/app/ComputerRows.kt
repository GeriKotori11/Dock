package com.windock.app

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat

/** Binds `row_computer.xml` for every row state in spec 5.3 and the compact sheet rows (5.12). */
object ComputerRows {
    class Holder(val view: View) {
        val separator: View = view.findViewById(R.id.row_separator)
        val body: View = view.findViewById(R.id.row_body)
        val glyph: View = view.findViewById(R.id.row_glyph)
        val icon: ImageView = view.findViewById(R.id.row_icon)
        val title: TextView = view.findViewById(R.id.row_title)
        val spinner: ProgressBar = view.findViewById(R.id.row_spinner)
        val dot: View = view.findViewById(R.id.row_dot)
        val subtitle: TextView = view.findViewById(R.id.row_subtitle)
        val pill: View = view.findViewById(R.id.row_pill)
        val check: View = view.findViewById(R.id.row_check)
        val more: ImageButton = view.findViewById(R.id.row_more)
        var actions = mutableListOf<Int>()
    }

    fun inflate(activity: Activity, parent: ViewGroup): Holder =
        Holder(activity.layoutInflater.inflate(R.layout.row_computer, parent, false)).also { it.view.tag = it }

    private fun glyph(h: Holder, kind: String) {
        val (bg, icon, tint) = when (kind) {
            "accent" -> Triple(R.drawable.bg_glyph_accent, R.drawable.ic_monitor, R.color.accent)
            "danger" -> Triple(R.drawable.bg_glyph_danger, R.drawable.ic_shield, R.color.danger_text)
            else -> Triple(R.drawable.bg_glyph, R.drawable.ic_monitor, R.color.text_2)
        }
        h.glyph.setBackgroundResource(bg)
        h.icon.setImageResource(icon)
        h.icon.imageTintList = h.view.context.getColorStateList(tint)
    }

    private fun dot(h: Holder, res: Int?) {
        h.dot.visibility = if (res == null) View.GONE else View.VISIBLE
        res?.let { h.dot.setBackgroundResource(it) }
    }

    private fun reset(h: Holder) {
        h.spinner.visibility = View.GONE
        h.pill.visibility = View.GONE
        h.check.visibility = View.GONE
        h.more.visibility = View.GONE
        h.subtitle.setTextColor(h.view.context.getColor(R.color.text_2))
        h.actions.forEach { ViewCompat.removeAccessibilityAction(h.view, it) }
        h.actions.clear()
    }

    /** A paired computer in the hub. */
    fun bindPaired(activity: Activity, h: Holder, c: Computer, entry: Presence.Entry, lastUsed: Boolean,
                   onMore: (View) -> Unit, onRename: () -> Unit, onForget: () -> Unit) {
        reset(h)
        val ctx = activity
        h.title.text = c.displayName
        val platform = DisplayName.platformLabel(c.platform)
        val spoken: String
        when {
            entry.state == Presence.State.CHANGED -> {
                glyph(h, "danger"); dot(h, R.drawable.dot_danger)
                h.subtitle.text = ctx.getString(R.string.row_security_changed)
                h.subtitle.setTextColor(ctx.getColor(R.color.danger_text))
                spoken = ctx.getString(R.string.row_security_changed)
            }
            c.needsPin -> {
                glyph(h, "neutral"); dot(h, null)
                h.subtitle.text = ctx.getString(R.string.row_needs_pin)
                spoken = ctx.getString(R.string.row_needs_pin)
            }
            entry.state == Presence.State.ONLINE -> {
                glyph(h, "accent"); dot(h, R.drawable.dot_live)
                val second = if (lastUsed) ctx.getString(R.string.row_last_used) else platform
                h.subtitle.text = Ui.subtitle(ctx, listOf(ctx.getString(R.string.row_online), second), entry.address ?: c.address)
                spoken = listOf(ctx.getString(R.string.row_online), if (lastUsed) ctx.getString(R.string.row_last_used) else "", platform)
                    .filter { it.isNotEmpty() }.joinToString(". ")
            }
            entry.state == Presence.State.CHECKING -> {
                glyph(h, "neutral"); dot(h, null)
                h.spinner.visibility = View.VISIBLE
                h.subtitle.text = ctx.getString(R.string.row_checking)
                spoken = ctx.getString(R.string.row_checking)
            }
            else -> {
                glyph(h, "neutral"); dot(h, R.drawable.dot_ring)
                h.subtitle.text = Ui.subtitle(ctx, listOf(ctx.getString(R.string.row_not_found)), c.address)
                spoken = ctx.getString(R.string.row_not_found)
            }
        }
        h.more.visibility = View.VISIBLE
        h.more.contentDescription = ctx.getString(R.string.row_more, c.displayName)
        h.more.setOnClickListener { onMore(h.more) }
        h.view.setOnLongClickListener { onMore(h.more); true }
        h.view.contentDescription = "${c.displayName}. $spoken."
        ViewCompat.replaceAccessibilityAction(h.view, AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_CLICK,
            ctx.getString(R.string.row_open_hint).trimEnd('.'), null)
        h.actions += ViewCompat.addAccessibilityAction(h.view, ctx.getString(R.string.menu_rename)) { _, _ -> onRename(); true }
        h.actions += ViewCompat.addAccessibilityAction(h.view, ctx.getString(R.string.menu_forget)) { _, _ -> onForget(); true }
    }

    /** A computer found on this network that is not paired. */
    fun bindDiscovered(activity: Activity, h: Holder, probe: Probe, txt: TxtRecord?) {
        reset(h)
        val name = DisplayName.of(null, probe.hostName.ifEmpty { txt?.name.orEmpty() }, probe.endpoint)
        val platform = DisplayName.platformLabel(probe.platform.ifEmpty { txt?.os })
        glyph(h, "neutral"); dot(h, null)
        h.title.text = name
        h.subtitle.text = Ui.subtitle(activity, listOf(platform), DisplayName.hostOf(probe.endpoint))
        h.pill.visibility = View.VISIBLE
        h.view.setOnLongClickListener(null)
        h.view.contentDescription = listOf(name, platform, activity.getString(R.string.row_not_paired)).filter { it.isNotEmpty() }.joinToString(", ") + "."
        ViewCompat.replaceAccessibilityAction(h.view, AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_CLICK,
            activity.getString(R.string.row_pair_hint).trimEnd('.'), null)
    }

    /** Compact row in the Switch computer sheet. */
    fun bindSheet(activity: Activity, h: Holder, c: Computer, entry: Presence.Entry, connected: Boolean) {
        reset(h)
        h.body.minimumHeight = Ui.dp(activity, 56f).toInt()
        h.title.text = c.displayName
        val status = when {
            connected -> { glyph(h, "accent"); dot(h, R.drawable.dot_live); h.check.visibility = View.VISIBLE; activity.getString(R.string.switch_connected) }
            entry.state == Presence.State.CHANGED -> { glyph(h, "danger"); dot(h, R.drawable.dot_danger)
                h.subtitle.setTextColor(activity.getColor(R.color.danger_text)); activity.getString(R.string.row_security_changed) }
            c.needsPin -> { glyph(h, "neutral"); dot(h, null); activity.getString(R.string.row_needs_pin) }
            entry.state == Presence.State.ONLINE -> { glyph(h, "accent"); dot(h, R.drawable.dot_live); activity.getString(R.string.row_online) }
            entry.state == Presence.State.CHECKING -> { glyph(h, "neutral"); dot(h, null); h.spinner.visibility = View.VISIBLE; activity.getString(R.string.row_checking) }
            else -> { glyph(h, "neutral"); dot(h, R.drawable.dot_ring); activity.getString(R.string.row_not_found) }
        }
        h.subtitle.text = status
        h.view.setOnLongClickListener(null)
        h.view.contentDescription = "${c.displayName}. $status."
    }

    /** The "Add a computer" row at the end of the sheet. */
    fun bindAdd(activity: Activity, h: Holder) {
        reset(h)
        h.body.minimumHeight = Ui.dp(activity, 56f).toInt()
        h.glyph.background = null
        h.icon.setImageResource(R.drawable.ic_plus)
        h.icon.imageTintList = activity.getColorStateList(R.color.accent)
        h.title.text = activity.getString(R.string.switch_add)
        h.title.setTextColor(activity.getColor(R.color.accent))
        h.title.textSize = 15f
        (h.subtitle.parent as View).visibility = View.GONE
        h.view.contentDescription = activity.getString(R.string.switch_add)
    }
}
