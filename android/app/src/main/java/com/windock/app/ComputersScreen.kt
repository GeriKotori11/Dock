package com.windock.app

import android.animation.LayoutTransition
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.TextView

/**
 * S2 / S3 Computers (spec 5.2, 5.3). Paired rows keep the order they had when the screen
 * appeared and discovered rows are appended, so nothing jumps under a finger.
 */
class ComputersScreen(activity: Activity, private val presence: Presence, private val actions: Actions) :
    Screen(activity, R.layout.screen_computers, R.id.hub_columns) {

    interface Actions {
        fun open(computer: Computer)
        fun pair(found: HostScanner.Found)
        fun addByAddress()
        /** Q3 camera sheet (HOST-CONTROL-PAGE 10.1). */
        fun scan()
        fun usb()
        fun phone()
        fun close()
        fun rename(computer: Computer)
        fun forget(computer: Computer)
    }

    private val main = Handler(Looper.getMainLooper())
    private val display: TextView = find(R.id.hub_display)
    private val body: TextView = find(R.id.hub_body)
    private val list: LinearLayout = find(R.id.hub_list)
    private val closeButton: View = find(R.id.hub_close)
    private val railAdd: View = find(R.id.rail_add)
    private val railScan: View = find(R.id.rail_scan)

    private var paired: List<Computer> = emptyList()
    private val pairedRows = LinkedHashMap<String, ComputerRows.Holder>()
    private val discoveredRows = LinkedHashMap<String, ComputerRows.Holder>()
    private var found: Map<String, HostScanner.Found> = emptyMap()
    private var shownAt = 0L
    var overDock = false
        private set

    private lateinit var pairedHeader: View
    private lateinit var pairedGroup: LinearLayout
    private lateinit var networkHeader: View
    private lateinit var networkSpinner: ProgressBar
    private lateinit var networkStatus: TextView
    private lateinit var discoveredGroup: LinearLayout
    private lateinit var empty: View
    private lateinit var foot: TextView
    private val onPresence = { refreshPaired() }
    private val tick = object : Runnable {
        override fun run() { updateSearching(); main.postDelayed(this, 1000) }
    }

    override val title: View get() = display

    init {
        closeButton.setOnClickListener { actions.close() }
        railAdd.setOnClickListener { actions.addByAddress() }
        railScan.setOnClickListener { actions.scan() }
        find<View>(R.id.rail_usb).setOnClickListener { actions.usb() }
        find<View>(R.id.rail_phone).setOnClickListener { actions.phone() }
    }

    /** Called before every show: the paired list is snapshotted here. */
    fun bind(computers: List<Computer>, overDock: Boolean) {
        this.overDock = overDock
        paired = computers
        closeButton.visibility = if (overDock) View.VISIBLE else View.GONE
        if (paired.isEmpty()) {
            val text = SpannableStringBuilder(str(R.string.welcome_title_1)).append('\n')
            val s = text.length
            text.append(str(R.string.welcome_title_2))
            text.setSpan(ForegroundColorSpan(activity.getColor(R.color.accent)), s, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            display.text = text
            body.text = str(R.string.welcome_body)
        } else {
            display.text = str(R.string.hub_title)
            body.text = str(R.string.hub_body)
        }
        // At 844 the Android rail has four links, so its body text is dropped (HOST-CONTROL-PAGE 10.1).
        body.visibility = if (activity.resources.configuration.screenWidthDp < 900) View.GONE else View.VISIBLE
        build()
    }

    private fun section(label: Int): View = activity.layoutInflater.inflate(R.layout.item_section, list, false).also {
        it.findViewById<TextView>(R.id.section_label).setText(label)
    }

    private fun group(): LinearLayout = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundResource(R.drawable.bg_group)
        clipToOutline = true
        layoutTransition = LayoutTransition().apply {
            val d = Ui.dp(activity, 6f)
            setAnimator(LayoutTransition.APPEARING, ObjectAnimator.ofPropertyValuesHolder(null as Any?,
                PropertyValuesHolder.ofFloat(View.ALPHA, 0f, 1f), PropertyValuesHolder.ofFloat(View.TRANSLATION_Y, d, 0f)).apply {
                interpolator = Ui.easeOut })
            setDuration(LayoutTransition.APPEARING, 200)
            setStagger(LayoutTransition.APPEARING, 40)
            disableTransitionType(LayoutTransition.CHANGING)
        }
    }

    private fun build() {
        list.removeAllViews()
        pairedRows.clear(); discoveredRows.clear()
        val gap = Ui.dp(activity, 16f).toInt()
        pairedHeader = section(R.string.hub_section_paired)
        pairedGroup = group()
        if (paired.isNotEmpty()) {
            list.addView(pairedHeader)
            list.addView(pairedGroup, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = gap })
            paired.forEach { c -> addPairedRow(c) }
        }
        networkHeader = section(R.string.hub_section_network)
        networkSpinner = networkHeader.findViewById(R.id.section_spinner)
        networkStatus = networkHeader.findViewById(R.id.section_status)
        list.addView(networkHeader)
        discoveredGroup = group()
        list.addView(discoveredGroup, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = gap })
        empty = buildEmpty()
        list.addView(empty)
        foot = TextView(activity).apply {
            setTextAppearance(R.style.T_Cap); textSize = 13f
            setPadding(Ui.dp(activity, 4f).toInt(), 0, Ui.dp(activity, 4f).toInt(), 0)
            text = str(R.string.hub_foot)
        }
        list.addView(foot)
        refreshPaired()
        refreshDiscovered()
    }

    /** First launch, nothing found (HOST-CONTROL-PAGE 10.1, frame Q1): scanning first. */
    private fun buildEmpty(): View {
        val d = { v: Float -> Ui.dp(activity, v).toInt() }
        val box = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(0, d(4f), 0, 0) }
        val glyph = FrameLayout(activity).apply { setBackgroundResource(R.drawable.bg_glyph_lg_accent); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        glyph.addView(ImageView(activity).apply {
            setImageResource(R.drawable.ic_qr); imageTintList = activity.getColorStateList(R.color.accent)
        }, FrameLayout.LayoutParams(d(26f), d(26f), Gravity.CENTER))
        box.addView(glyph, LinearLayout.LayoutParams(d(56f), d(56f)).apply { bottomMargin = d(18f) })
        box.addView(TextView(activity).apply { setTextAppearance(R.style.T_Title); text = str(R.string.scan_empty_title) })
        box.addView(TextView(activity).apply {
            setTextAppearance(R.style.T_Body); text = str(R.string.scan_empty_body); maxWidth = d(460f)
        }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = d(8f) })
        val buttons = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val scan = LinearLayout(activity).apply {
            id = R.id.hub_scan_qr
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER
            setBackgroundResource(R.drawable.bg_button_primary)
            setPadding(d(20f), 0, d(20f), 0)
            isClickable = true; isFocusable = true
            contentDescription = str(R.string.scan_rail)
            setOnClickListener { actions.scan() }
            addView(ImageView(activity).apply {
                setImageResource(R.drawable.ic_camera); imageTintList = activity.getColorStateList(R.color.on_accent)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(d(18f), d(18f)).apply { marginEnd = d(10f) })
            addView(TextView(activity).apply {
                text = str(R.string.scan_rail); textSize = 15f
                typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
                setTextColor(activity.getColor(R.color.on_accent))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            })
        }
        buttons.addView(scan, LinearLayout.LayoutParams(-2, d(48f)))
        buttons.addView(Button(activity, null, 0, R.style.Btn_Ghost).apply {
            text = str(R.string.hub_enter_address); id = R.id.hub_enter_address
            setOnClickListener { actions.addByAddress() }
        }, LinearLayout.LayoutParams(-2, d(48f)).apply { marginStart = d(12f) })
        box.addView(buttons, LinearLayout.LayoutParams(-2, -2).apply { topMargin = d(22f) })
        box.visibility = View.GONE
        return box
    }

    private fun addPairedRow(c: Computer) {
        val h = ComputerRows.inflate(activity, pairedGroup)
        h.separator.visibility = if (pairedRows.isEmpty()) View.GONE else View.VISIBLE
        h.view.setOnClickListener { actions.open(currentOf(c.hostId) ?: c) }
        pairedGroup.addView(h.view)
        pairedRows[c.hostId] = h
    }

    private fun currentOf(hostId: String): Computer? = paired.firstOrNull { it.hostId == hostId }

    /** Re-read records (rename, needsPin) without reordering. */
    fun updateRecords(computers: List<Computer>) {
        val byId = computers.associateBy { it.hostId }
        val removed = paired.filter { it.hostId !in byId }
        paired = paired.mapNotNull { byId[it.hostId] }
        removed.forEach { c -> pairedRows.remove(c.hostId)?.let { pairedGroup.removeView(it.view) } }
        pairedRows.values.firstOrNull()?.separator?.visibility = View.GONE
        if (paired.isEmpty() && removed.isNotEmpty()) { bind(emptyList(), overDock); return }
        refreshPaired()
        refreshDiscovered()
    }

    private fun refreshPaired() {
        val last = paired.maxByOrNull { it.lastConnectedAt ?: 0L }?.takeIf { it.lastConnectedAt != null }?.hostId
        for (c in paired) {
            val h = pairedRows[c.hostId] ?: continue
            ComputerRows.bindPaired(activity, h, c, presence.of(c.hostId), c.hostId == last,
                onMore = { anchor -> menu(anchor, c) },
                onRename = { actions.rename(c) }, onForget = { actions.forget(c) })
        }
    }

    private fun menu(anchor: View, c: Computer) {
        PopupMenu(activity, anchor, Gravity.END).apply {
            menu.add(0, 1, 0, R.string.menu_open)
            menu.add(0, 2, 1, R.string.menu_rename)
            menu.add(0, 3, 2, R.string.menu_forget)
            setOnMenuItemClickListener {
                val current = currentOf(c.hostId) ?: c
                when (it.itemId) { 1 -> actions.open(current); 2 -> actions.rename(current); 3 -> actions.forget(current) }
                true
            }
            show()
        }
    }

    /** Verified discovery results; paired host IDs update their paired row instead. */
    fun setFound(results: Map<String, HostScanner.Found>) {
        found = results
        refreshDiscovered()
    }

    private fun refreshDiscovered() {
        if (!::discoveredGroup.isInitialized) return
        val pairedIds = paired.map { it.hostId }.toSet()
        val visible = found.filterKeys { it !in pairedIds }
        // Gone for 10 s (HostScanner keeps them that long): system list delete.
        discoveredRows.keys.filter { it !in visible }.forEach { id -> discoveredRows.remove(id)?.let { discoveredGroup.removeView(it.view) } }
        // New ones are appended, ordered by name within the batch.
        visible.values.filter { it.probe.hostId !in discoveredRows }
            .sortedBy { DisplayName.of(null, it.probe.hostName, it.probe.endpoint).lowercase() }
            .forEach { f ->
                val id = f.probe.hostId ?: return@forEach
                val h = ComputerRows.inflate(activity, discoveredGroup)
                h.view.setOnClickListener { found[id]?.let(actions::pair) }
                discoveredGroup.addView(h.view)
                discoveredRows[id] = h
            }
        discoveredRows.entries.forEachIndexed { i, (id, h) ->
            h.separator.visibility = if (i == 0) View.GONE else View.VISIBLE
            visible[id]?.let { ComputerRows.bindDiscovered(activity, h, it.probe, it.txt) }
        }
        updateSearching()
    }

    private fun updateSearching() {
        if (!::networkHeader.isInitialized) return
        val elapsed = SystemClock.uptimeMillis() - shownAt
        val none = discoveredRows.isEmpty()
        discoveredGroup.visibility = if (none) View.GONE else View.VISIBLE
        val showEmpty = none && paired.isEmpty() && elapsed >= 8_000
        empty.visibility = if (showEmpty) View.VISIBLE else View.GONE
        foot.visibility = if (!showEmpty && (!none || elapsed >= 3_000)) View.VISIBLE else View.GONE
        // The rail's Scan and Add links are hidden while the empty state's buttons say the same.
        railAdd.visibility = if (showEmpty) View.GONE else View.VISIBLE
        railScan.visibility = if (showEmpty) View.GONE else View.VISIBLE
        networkStatus.visibility = View.VISIBLE
        networkStatus.text = str(if (elapsed >= 8_000 && none) R.string.hub_searching_long else R.string.hub_searching)
        networkSpinner.visibility = if (elapsed < ScreenHost.SPINNER_STOP_MS) View.VISIBLE else View.GONE
        if (elapsed >= ScreenHost.SPINNER_STOP_MS) networkStatus.text = str(R.string.hub_searching_long)
    }

    override fun onShown() {
        shownAt = SystemClock.uptimeMillis()
        presence.listen(onPresence)
        main.removeCallbacks(tick)
        main.post(tick)
    }

    override fun onHidden() {
        presence.unlisten(onPresence)
        main.removeCallbacks(tick)
    }

    override fun onBack(): Boolean {
        if (overDock) { actions.close(); return true }
        return false
    }
}
