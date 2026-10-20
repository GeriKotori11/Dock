package com.windock.app

import android.content.res.Configuration
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.webkit.WebView
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.windock.app.Fixture.awaitJs
import com.windock.app.Fixture.awaitUi
import com.windock.app.Fixture.js
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL

/**
 * Runs only against scripts/android-smoke-host.mjs; it never launches real PC apps.
 * First launch → Add by address → security code → native PIN → dock → Back opens the
 * Switch computer sheet → the app reopens straight into the dock.
 */
@RunWith(AndroidJUnit4::class)
class DockSmokeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val port = InstrumentationRegistry.getArguments().getString("smokePort") ?: "18622"
    private val endpoint = "http://10.0.2.2:$port"
    private val device = UiDevice.getInstance(instrumentation)

    private fun gesture(x1: Float, y1: Float, x2: Float, y2: Float, hold: Long = 0) {
        val start = SystemClock.uptimeMillis()
        fun send(action: Int, x: Float, y: Float) {
            val event = MotionEvent.obtain(start, SystemClock.uptimeMillis(), action, x, y, 0)
            instrumentation.sendPointerSync(event)
            event.recycle()
        }
        send(MotionEvent.ACTION_DOWN, x1, y1)
        if (hold > 0) SystemClock.sleep(hold)
        for (i in 1..10) {
            send(MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * i / 10, y1 + (y2 - y1) * i / 10)
            SystemClock.sleep(25)
        }
        send(MotionEvent.ACTION_UP, x2, y2)
    }

    /** The code the fixture advertises; the app must show the same one, computed from the handshake. */
    private fun advertisedCode(): String {
        val conn = URL("$endpoint/health").openConnection() as HttpURLConnection
        return try { JSONObject(conn.inputStream.bufferedReader().readText()).getJSONObject("tls").getString("code") }
        finally { conn.disconnect() }
    }

    private fun text(activity: MainActivity, id: Int): String = activity.findViewById<TextView>(id)?.text?.toString().orEmpty()

    @Test fun installedAppPairsNativelyRendersSwipesAndSwitches() {
        // The fixture makes a new certificate per run: start from "never paired".
        Fixture.reset(context)
        val code = advertisedCode()
        val secure = EndpointPolicy.withScheme(endpoint, "https")!!
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var web: WebView
            scenario.onActivity { activity ->
                web = activity.findViewById(R.id.web)
                assertEquals(Configuration.ORIENTATION_LANDSCAPE, activity.resources.configuration.orientation)
            }
            // S2 first launch: the welcome rail and discovery.
            awaitUi(scenario, what = "first-launch hub") { it.findViewById<View>(R.id.rail_add)?.isShown == true }
            scenario.onActivity { assertEquals("Your computer.\nWithin reach.", text(it, R.id.hub_display)) }
            Fixture.screenshot(context, "s2-first-launch.png")
            scenario.onActivity { it.findViewById<View>(R.id.rail_add).performClick() }

            // S7: an address with no WinDock stays recoverable.
            awaitUi(scenario, what = "add by address") { it.findViewById<View>(R.id.address_input)?.isShown == true }
            scenario.onActivity {
                it.findViewById<EditText>(R.id.address_input).setText("127.0.0.1:1")
                it.findViewById<View>(R.id.address_connect).performClick()
            }
            awaitUi(scenario, what = "no-answer message") {
                text(it, R.id.address_message) == it.getString(R.string.address_no_answer, "127.0.0.1:1")
            }
            scenario.onActivity {
                it.findViewById<EditText>(R.id.address_input).setText("8.8.8.8")
                it.findViewById<View>(R.id.address_connect).performClick()
                assertEquals(it.getString(R.string.address_public), text(it, R.id.address_message))
                it.findViewById<EditText>(R.id.address_input).setText("10.0.2.2:$port")
            }
            Fixture.screenshot(context, "s7-add-by-address.png")
            scenario.onActivity { it.findViewById<View>(R.id.address_connect).performClick() }

            // S5: the code from the TLS handshake equals the one the host advertises.
            awaitUi(scenario, what = "security code") { text(it, R.id.pair_code) == code && it.findViewById<View>(R.id.pair_match).isShown }
            Fixture.screenshot(context, "s5-security-code.png")
            scenario.onActivity { it.findViewById<View>(R.id.pair_match).performClick() }

            // S6: a wrong PIN is refused natively, the right one pairs.
            awaitUi(scenario, what = "PIN entry") { it.findViewById<View>(R.id.pin_input).isShown }
            scenario.onActivity { it.findViewById<EditText>(R.id.pin_input).setText("000000") }
            awaitUi(scenario, what = "wrong PIN message") {
                text(it, R.id.pin_message) == it.getString(R.string.pin_wrong, text(it, R.id.pair_name))
            }
            Fixture.screenshot(context, "s6-pin-wrong.png")
            scenario.onActivity { it.findViewById<EditText>(R.id.pin_input).setText("864200") }

            awaitUi(scenario, 20000, "dock after pairing") { Fixture.dockShown(it) }
            awaitJs(web, "!document.getElementById('app').hidden && document.querySelectorAll('.tile').length === 5")
            awaitJs(web, "document.getElementById('conn').textContent === 'Connected'")
            assertEquals("\"$secure\"", js(web, "location.origin"))
            assertEquals("The web PIN page never showed", "true", js(web, "document.getElementById('pair').hidden"))
            val saved = ComputerStore.of(context).last()!!
            assertEquals("5a0c7e0e-7d1b-4c2a-9f3e-a11d0e5c0de1", saved.hostId)
            assertEquals(secure, saved.endpoint)
            assertNotNull("The certificate is pinned for the host ID", PinStore.get(context, saved.hostId))
            // The native capabilities object reached the page.
            awaitJs(web, "window.WinDockNative && window.WinDockNative.platform === 'android' && window.WinDockNative.switcher === true")
            assertEquals("\"${saved.displayName}\"", js(web, "window.WinDockNative.computerName"))

            // A fresh Android image explains immersive mode with a system overlay.
            device.wait(Until.findObject(By.text("Got it")), 3000)?.click()
            assertEquals("true", js(web, "innerWidth > innerHeight && document.body.classList.contains('is-immersive')"))
            assertEquals("2", js(web, "document.querySelectorAll('.dock-page').length"))
            js(web, "document.querySelector('.tile[data-key=\"smoke-1\"]').click()")
            awaitJs(web, "document.querySelector('.tile[data-key=\"smoke-1\"]').classList.contains('is-running')")
            js(web, "document.querySelector('.tile[data-key=\"smoke-1\"]').click()")

            var width = 0; var height = 0
            scenario.onActivity { width = web.width; height = web.height }
            gesture(width * .82f, height * .52f, width * .18f, height * .52f)
            awaitJs(web, "document.getElementById('dock').scrollLeft > document.getElementById('dock').clientWidth / 2")
            gesture(width * .18f, height * .52f, width * .82f, height * .52f)
            awaitJs(web, "document.getElementById('dock').scrollLeft < 10")
            gesture(width * .5f, height * .88f, width * .5f, height * .3f)
            awaitJs(web, "document.getElementById('drawer').open")
            // The drawer's connection row is the native switcher.
            awaitJs(web, "!!document.getElementById('drawer-switch')")
            Fixture.screenshot(context, "s12-drawer-row.png")
            // Back closes the web sheet first.
            instrumentation.runOnMainSync { @Suppress("DEPRECATION") (web.context as MainActivity).onBackPressed() }
            awaitJs(web, "!document.getElementById('drawer').open")
            SystemClock.sleep(600)
            // Hold empty canvas: editing must start without dispatching an app action.
            gesture(width * .5f, height * .5f, width * .5f, height * .5f, 600)
            awaitJs(web, "document.querySelectorAll('.tile.is-editing').length === 5")
            js(web, "document.getElementById('edit-done').click()")
            awaitJs(web, "document.querySelectorAll('.tile.is-editing').length === 0")
            Fixture.screenshot(context, "dock-smoke.png")

            // With nothing open, Back opens the Switch computer sheet over the live dock.
            scenario.onActivity { @Suppress("DEPRECATION") it.onBackPressed() }
            assertTrue("Switch sheet", device.wait(Until.hasObject(By.text("Switch computer")), 5000))
            assertTrue(device.hasObject(By.text("Connected")))
            Fixture.screenshot(context, "s12-switch-sheet.png")
            device.pressBack()
            assertTrue(device.wait(Until.gone(By.text("Switch computer")), 5000))
            scenario.onActivity { assertTrue("The dock stayed open", Fixture.dockShown(it)) }
            assertEquals("\"$secure\"", js(web, "location.origin"))
            // The drawer row opens the same sheet through the bridge.
            js(web, "document.getElementById('drawer').showModal(); document.getElementById('drawer-switch').click()")
            assertTrue("Switch sheet from the drawer", device.wait(Until.hasObject(By.text("Switch computer")), 5000))
            device.findObject(By.text("Manage")).click()
            awaitUi(scenario, what = "hub over the dock") { it.findViewById<View>(R.id.hub_close)?.isShown == true }
            Fixture.screenshot(context, "s3-computers.png")
            scenario.onActivity { it.findViewById<View>(R.id.hub_close).performClick() }
            awaitUi(scenario, what = "dock again") { Fixture.dockShown(it) }

            // Recreating the Activity reopens the last computer: no code, no PIN.
            scenario.recreate()
            scenario.onActivity { web = it.findViewById(R.id.web) }
            awaitUi(scenario, 20000, "dock after recreate") { Fixture.dockShown(it) }
            awaitJs(web, "!!document.getElementById('app') && !document.getElementById('app').hidden && document.querySelectorAll('.tile').length === 5")
        }
    }
}
