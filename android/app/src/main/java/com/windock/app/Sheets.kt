package com.windock.app

import android.app.Activity
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.util.concurrent.ExecutorService

/** Bottom-attached sheets (S12, S13, S14): android.app.Dialog, gravity bottom, 500 or 560 dp wide. */
object Sheets {
    fun create(activity: Activity, layout: Int, widthDp: Float): Pair<Dialog, View> {
        val dialog = Dialog(activity, R.style.WinDockSheet)
        val content = activity.layoutInflater.inflate(layout, null)
        dialog.setContentView(content)
        dialog.setCanceledOnTouchOutside(true)
        dialog.window?.apply {
            setGravity(Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
            val screen = activity.resources.displayMetrics
            val max = screen.widthPixels - Ui.dp(activity, 32f).toInt()
            setLayout(minOf(Ui.dp(activity, widthDp).toInt(), max), ViewGroup.LayoutParams.WRAP_CONTENT)
            attributes = attributes.apply { dimAmount = 0.62f }
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            // Keep the immersive dock immersive while a sheet is up.
            WindowCompat.getInsetsController(this, decorView).apply {
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.systemBars())
            }
        }
        // Height follows content, up to 85% of the screen, then scrolls.
        content.post {
            val limit = (activity.resources.displayMetrics.heightPixels * 0.85f).toInt()
            if (content.height > limit) dialog.window?.setLayout(dialog.window!!.attributes.width, limit)
        }
        return dialog to content
    }

    fun openSettings(activity: Activity, action: String) {
        try { activity.startActivity(Intent(action)) }
        catch (_: ActivityNotFoundException) { Toast.makeText(activity, R.string.open_settings_manually, Toast.LENGTH_LONG).show() }
    }
}

/** S12 Switch computer (spec 4.4, 5.12): over the dimmed, still-live dock. */
class SwitchSheet(private val activity: Activity, private val presence: Presence, private val actions: Actions) {
    interface Actions {
        fun pick(computer: Computer)
        fun manage()
        fun add()
    }

    var dialog: Dialog? = null
        private set
    private var computers: List<Computer> = emptyList()
    private var connected: String? = null
    private var rows = LinkedHashMap<String, ComputerRows.Holder>()
    private val onPresence = { bindRows() }

    fun show(list: List<Computer>, connectedId: String?, onDismiss: () -> Unit) {
        dialog?.dismiss()
        computers = list
        connected = connectedId
        val (d, content) = Sheets.create(activity, R.layout.sheet_switch, 500f)
        dialog = d
        content.findViewById<View>(R.id.switch_manage).setOnClickListener { d.dismiss(); actions.manage() }
        val group = content.findViewById<LinearLayout>(R.id.switch_list)
        rows.clear()
        list.forEachIndexed { i, c ->
            val h = ComputerRows.inflate(activity, group)
            h.separator.visibility = if (i == 0) View.GONE else View.VISIBLE
            h.view.setOnClickListener {
                d.dismiss()
                // Tapping the current computer closes the sheet and nothing else happens.
                if (c.hostId != connected) actions.pick(c)
            }
            group.addView(h.view)
            rows[c.hostId] = h
        }
        val add = ComputerRows.inflate(activity, group)
        add.separator.visibility = if (list.isEmpty()) View.GONE else View.VISIBLE
        ComputerRows.bindAdd(activity, add)
        add.view.setOnClickListener { d.dismiss(); actions.add() }
        group.addView(add.view)
        bindRows()
        presence.listen(onPresence)
        d.setOnDismissListener {
            presence.unlisten(onPresence)
            if (dialog === d) dialog = null
            onDismiss()
        }
        d.show()
    }

    private fun bindRows() {
        for (c in computers) rows[c.hostId]?.let { ComputerRows.bindSheet(activity, it, c, presence.of(c.hostId), c.hostId == connected) }
    }

    fun dismiss() { dialog?.dismiss() }
}

/** S13 Connect by USB (spec 5.13), Windows only. */
class UsbSheet(private val activity: Activity, private val io: ExecutorService, private val found: (String) -> Unit) {
    var dialog: Dialog? = null
        private set
    private var generation = 0

    fun show(onDismiss: () -> Unit) {
        dialog?.dismiss()
        val (d, content) = Sheets.create(activity, R.layout.sheet_usb, 560f)
        dialog = d
        val steps = content.findViewById<LinearLayout>(R.id.usb_steps)
        val message = content.findViewById<TextView>(R.id.usb_message)
        listOf(R.string.usb_step1, R.string.usb_step2, R.string.usb_step3).forEachIndexed { i, res ->
            val step = activity.layoutInflater.inflate(R.layout.item_usb_step, steps, false)
            step.findViewById<TextView>(R.id.usb_step_number).text = (i + 1).toString()
            val text = activity.getString(res)
            step.findViewById<TextView>(R.id.usb_step_text).text =
                if (i == 1) Ui.rich(activity, text, strong = listOf(activity.getString(R.string.usb_step2_bold))) else text
            step.contentDescription = "${i + 1}. $text"
            steps.addView(step, i)
        }
        content.findViewById<View>(R.id.usb_settings).setOnClickListener { Sheets.openSettings(activity, Settings.ACTION_WIRELESS_SETTINGS) }
        val find = content.findViewById<View>(R.id.usb_find)
        val spinner = content.findViewById<ProgressBar>(R.id.usb_spinner)
        val findText = content.findViewById<TextView>(R.id.usb_find_text)
        find.setOnClickListener {
            if (spinner.visibility == View.VISIBLE) return@setOnClickListener
            spinner.visibility = View.VISIBLE
            findText.setText(R.string.usb_searching)
            message.setTextColor(activity.getColor(R.color.text_3))
            message.setText(R.string.usb_data)
            val run = ++generation
            io.execute {
                val networks = LocalNetwork.available()
                // USB mode never silently falls back to Wi-Fi.
                val endpoint = if (networks.none { it.wired }) null
                else Discovery.find({ HostClient.probe(it) is HostClient.Result.Answer }, usbOnly = true, networks = networks)
                activity.runOnUiThread {
                    if (run != generation || dialog !== d) return@runOnUiThread
                    spinner.visibility = View.GONE
                    findText.setText(R.string.usb_find)
                    if (endpoint == null) {
                        message.setTextColor(activity.getColor(R.color.danger_text))
                        message.setText(R.string.usb_not_found)
                    } else { d.dismiss(); found(endpoint) }
                }
            }
        }
        d.setOnDismissListener { generation++; if (dialog === d) dialog = null; onDismiss() }
        d.show()
    }

    fun dismiss() { dialog?.dismiss() }
}

/** S14 This phone: the existing display options, restyled as a bottom sheet. */
object PhoneSheet {
    fun show(activity: Activity, saved: () -> Unit, onDismiss: () -> Unit): Dialog {
        val (d, content) = Sheets.create(activity, R.layout.sheet_phone, 560f)
        val current = PhonePreferences.display(activity)
        val dim = content.findViewById<Spinner>(R.id.dim_delay)
        val level = content.findViewById<Spinner>(R.id.dim_level)
        fun adapter(labels: Array<String>) = object : ArrayAdapter<String>(activity, android.R.layout.simple_spinner_item, labels) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getView(position, convertView, parent) as TextView).apply { setTextColor(activity.getColor(R.color.text)); textSize = 15f }
            override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getDropDownView(position, convertView, parent) as TextView).apply {
                    setTextColor(activity.getColor(R.color.text)); textSize = 15f
                    minHeight = Ui.dp(activity, 48f).toInt(); gravity = Gravity.CENTER_VERTICAL
                    setPadding(Ui.dp(activity, 16f).toInt(), 0, Ui.dp(activity, 16f).toInt(), 0)
                }
        }.apply { setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        dim.adapter = adapter(activity.resources.getStringArray(R.array.dim_delays))
        dim.setSelection(DisplayPolicy.DIM_TIMES.indexOf(current.dimAfterMs).coerceAtLeast(0))
        level.adapter = adapter(arrayOf("5%", "10%", "20%"))
        level.setSelection(DisplayPolicy.DIM_LEVELS.indexOf(current.dimPercent).coerceAtLeast(0))
        content.findViewById<View>(R.id.phone_display_settings).setOnClickListener { Sheets.openSettings(activity, Settings.ACTION_DISPLAY_SETTINGS) }
        content.findViewById<View>(R.id.phone_cancel).setOnClickListener { d.dismiss() }
        content.findViewById<View>(R.id.phone_save).setOnClickListener {
            PhonePreferences.saveDisplay(activity, DisplayPolicy(
                DisplayPolicy.DIM_TIMES[dim.selectedItemPosition], DisplayPolicy.DIM_LEVELS[level.selectedItemPosition]))
            saved()
            d.dismiss()
        }
        d.setOnDismissListener { onDismiss() }
        d.show()
        return d
    }
}

/**
 * The system camera, which reads the QR code and offers the `windock://pair` link
 * (HOST-CONTROL-PAGE 10.3, decision D10): no scanner library and no camera permission.
 */
object QrCamera {
    private fun intent() = Intent(android.provider.MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA)

    fun available(activity: Activity): Boolean = try {
        intent().resolveActivity(activity.packageManager) != null
    } catch (_: Exception) { false }

    fun open(activity: Activity): Boolean = try {
        activity.startActivity(intent()); true
    } catch (_: ActivityNotFoundException) { false } catch (_: SecurityException) { false }
}

/** Q3 Scan with your camera (spec 10.3): 560 wide, like S13. */
class CameraSheet(private val activity: Activity) {
    var dialog: Dialog? = null
        private set

    fun show(onDismiss: () -> Unit) {
        dialog?.dismiss()
        val (d, content) = Sheets.create(activity, R.layout.sheet_camera, 560f)
        dialog = d
        val steps = content.findViewById<LinearLayout>(R.id.camera_steps)
        listOf(R.string.cam_sheet_step1, R.string.cam_sheet_step2, R.string.cam_sheet_step3).forEachIndexed { i, res ->
            val step = activity.layoutInflater.inflate(R.layout.item_usb_step, steps, false)
            step.findViewById<TextView>(R.id.usb_step_number).text = (i + 1).toString()
            val text = activity.getString(res)
            step.findViewById<TextView>(R.id.usb_step_text).text =
                if (i == 0) Ui.rich(activity, text, strong = listOf(activity.getString(R.string.cam_sheet_step1_bold))) else text
            step.contentDescription = "${i + 1}. $text"
            steps.addView(step, i)
        }
        content.findViewById<View>(R.id.camera_pin).setOnClickListener { d.dismiss() }
        val open = content.findViewById<View>(R.id.camera_open)
        // No camera app that can take the intent: the button is hidden (spec 10.3).
        open.visibility = if (QrCamera.available(activity)) View.VISIBLE else View.GONE
        open.setOnClickListener { if (QrCamera.open(activity)) d.dismiss() else open.visibility = View.GONE }
        d.setOnDismissListener { if (dialog === d) dialog = null; onDismiss() }
        d.show()
    }

    fun dismiss() { dialog?.dismiss() }
}
