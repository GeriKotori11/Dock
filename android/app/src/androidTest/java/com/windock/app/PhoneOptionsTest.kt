package com.windock.app

import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.windock.app.Fixture.awaitUi
import com.windock.app.Fixture.js
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Emulator only: start scripts/android-smoke-host.mjs first. */
@RunWith(AndroidJUnit4::class)
class PhoneOptionsTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private val endpoint = "http://10.0.2.2:" + (InstrumentationRegistry.getArguments().getString("smokePort") ?: "18622")

    /** Already paired with the fixture, as after an update: the app opens straight into the dock. */
    private fun prepare() {
        assumeTrue("This fixture must not change a personal phone", Build.MODEL.contains("sdk"))
        device.wakeUp()
        PhonePreferences.saveDisplay(context, DisplayPolicy(0))
        Fixture.pair(context, endpoint)
    }

    private fun loaded(scenario: ActivityScenario<MainActivity>): WebView {
        awaitUi(scenario, 20000, "dock") { Fixture.dockShown(it) }
        lateinit var web: WebView
        scenario.onActivity { web = it.findViewById(R.id.web) }
        val deadline = SystemClock.uptimeMillis() + 10000
        while (js(web, "!!document.getElementById('phone-options-row')") != "true") {
            assertTrue("The shared dock should load", SystemClock.uptimeMillis() < deadline)
            SystemClock.sleep(100)
        }
        device.wait(Until.findObject(By.text("Got it")), 1000)?.click()
        return web
    }

    private fun choose(id: String, label: String) {
        val spinner = device.wait(Until.findObject(By.res("com.windock.app", id)), 5000)
        assertNotNull("Spinner $id", spinner)
        spinner.click()
        val choice = device.wait(Until.findObject(By.text(label)), 5000)
        assertNotNull(label, choice)
        choice.click()
    }

    /** Back in the dock opens the Switch sheet; Manage opens the hub over the dock. */
    private fun openHub(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { @Suppress("DEPRECATION") it.onBackPressed() }
        assertTrue(device.wait(Until.hasObject(By.text("Switch computer")), 5000))
        device.findObject(By.text("Manage")).click()
        awaitUi(scenario, what = "hub") { it.findViewById<View>(R.id.rail_usb)?.isShown == true }
    }

    @Test fun nativeSettingsPersistDimConsumeWakeAndKeepScreenOn() {
        prepare()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                var web = loaded(scenario)
                assertEquals("false", js(web, "document.getElementById('phone-options-row').hidden"))
                js(web, "document.getElementById('phone-options').click()")
                assertTrue(device.wait(Until.hasObject(By.text("This phone")), 5000))
                assertFalse("The Screen off option is gone", device.hasObject(By.text("Screen off")))
                Fixture.screenshot(context, "s14-phone-options.png")
                choose("dim_delay", "After 15 seconds")
                device.findObject(By.res("com.windock.app", "phone_save")).click()
                awaitUi(scenario) { PhonePreferences.display(context) == DisplayPolicy(15_000, 10) }
                assertEquals(DisplayPolicy(15_000, 10), PhonePreferences.display(context))

                scenario.recreate()
                web = loaded(scenario)
                js(web, "window.__wakeClicks=0;document.addEventListener('pointerdown',()=>window.__wakeClicks++,true)")
                awaitUi(scenario, 20000) { it.window.attributes.screenBrightness in 0f..0.1f }
                scenario.onActivity {
                    assertTrue(it.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
                }
                var x = 0; var y = 0
                scenario.onActivity { x = web.width / 2; y = web.height / 2 }
                device.click(x, y)
                awaitUi(scenario) { it.window.attributes.screenBrightness == -1f }
                assertEquals("0", js(web, "window.__wakeClicks"))
                device.click(x, y)
                SystemClock.sleep(300)
                assertEquals("1", js(web, "window.__wakeClicks"))
                // Dimmed for a long while, the screen still stays on.
                awaitUi(scenario, 20000) { it.window.attributes.screenBrightness in 0f..0.1f }
                SystemClock.sleep(2000)
                scenario.onActivity {
                    assertTrue(it.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
                }
                // The native Computers screen keeps the screen on too.
                device.click(x, y)
                awaitUi(scenario) { it.window.attributes.screenBrightness == -1f }
                openHub(scenario)
                scenario.onActivity {
                    assertTrue(it.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
                }
                scenario.moveToState(Lifecycle.State.CREATED)
                scenario.onActivity {
                    assertEquals(-1f, it.window.attributes.screenBrightness)
                    assertEquals(0, it.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
                scenario.moveToState(Lifecycle.State.RESUMED)
                scenario.onActivity {
                    assertTrue(it.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
                }
            }
        } finally { PhonePreferences.saveDisplay(context, DisplayPolicy()) }
    }

    @Test fun usbSheetSearchesOnlyTheCableAndReturnsToTheDock() {
        prepare()
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                loaded(scenario)
                openHub(scenario)
                scenario.onActivity { it.findViewById<View>(R.id.rail_usb).performClick() }
                assertTrue(device.wait(Until.hasObject(By.text("Connect by USB")), 5000))
                assertTrue(device.hasObject(By.text("Windows only")))
                assertTrue(device.hasObject(By.text("Tethering settings")))
                Fixture.screenshot(context, "s13-usb-sheet.png")
                device.findObject(By.res("com.windock.app", "usb_find")).click()
                // Recent emulators expose a virtual wired eth0 next to wlan0. Either nothing
                // answers over the cable, or the sheet hands the answer to the normal checks.
                val deadline = SystemClock.uptimeMillis() + 20000
                var settled = false
                while (!settled && SystemClock.uptimeMillis() < deadline) {
                    val message = device.findObject(By.res("com.windock.app", "usb_message"))?.text
                    settled = message == context.getString(R.string.usb_not_found) || !device.hasObject(By.text("Find computer over USB")) &&
                        !device.hasObject(By.text("Looking over USB…"))
                    SystemClock.sleep(200)
                }
                assertTrue("The USB search settles", settled)
                SystemClock.sleep(3000) // An answer is probed before anything opens.
                var pairing = false
                scenario.onActivity { pairing = it.findViewById<View>(R.id.pair_code)?.isShown == true }
                if (pairing) {
                    // Something answered over the cable: an unknown host goes to step 1, never straight in.
                    assertEquals(1, ComputerStore.of(context).all().size)
                    Fixture.screenshot(context, "s13-usb-found-pairing.png")
                    return@use
                }
                if (device.hasObject(By.text("Windows only"))) device.pressBack()
                assertTrue(device.wait(Until.gone(By.text("Windows only")), 5000))
                // Closing the hub returns to the same dock.
                scenario.onActivity { if (it.findViewById<View>(R.id.hub_close)?.isShown == true) it.findViewById<View>(R.id.hub_close).performClick() }
                awaitUi(scenario, 20000, "dock") { Fixture.dockShown(it) }
            }
        } finally { PhonePreferences.saveDisplay(context, DisplayPolicy()) }
    }
}
