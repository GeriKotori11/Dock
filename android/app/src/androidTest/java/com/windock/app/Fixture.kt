package com.windock.app

import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Shared emulator-test setup: a clean phone, or one already paired with a fixture host. */
object Fixture {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    /** Never paired: no computers, pins, remembered addresses or sessions. */
    fun reset(context: Context) {
        for (name in listOf("computers", "pins", "windock")) context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        // Migration already ran: an empty list stays empty.
        context.getSharedPreferences("computers", Context.MODE_PRIVATE).edit().putString("migrated", "1").commit()
        val done = CountDownLatch(1)
        instrumentation.runOnMainSync { CookieManager.getInstance().removeAllCookies { CookieManager.getInstance().flush(); done.countDown() } }
        assertTrue(done.await(5, TimeUnit.SECONDS))
    }

    /** Pair natively with the fixture's PIN, the way PairingScreen does, before the app starts. */
    fun pair(context: Context, endpoint: String, pin: String = "864200"): Computer {
        reset(context)
        val probe = (HostClient.probe(endpoint, 5000) as? HostClient.Result.Answer)?.probe
        assertNotNull("The fixture host answers /health at $endpoint", probe)
        val hostId = probe!!.hostId!!
        val result = HostClient.pair(probe.endpoint, probe.presented, pin, "Android test")
        assertTrue("Pairing with the fixture PIN: $result", result is HostClient.Auth.Paired)
        probe.presented?.let { assertTrue(PinStore.save(context, hostId, it)) }
        val computer = Computer(hostId, probe.hostName, null, probe.platform, probe.endpoint, System.currentTimeMillis(), System.currentTimeMillis())
        ComputerStore.of(context).save(computer)
        val installed = CountDownLatch(1)
        instrumentation.runOnMainSync { SessionCookies.install(probe.endpoint, (result as HostClient.Auth.Paired).cookie) { installed.countDown() } }
        assertTrue(installed.await(5, TimeUnit.SECONDS))
        return computer
    }

    fun js(web: WebView, expression: String): String {
        val done = CountDownLatch(1)
        var result = "null"
        instrumentation.runOnMainSync { web.evaluateJavascript(expression) { result = it; done.countDown() } }
        assertTrue("JavaScript callback", done.await(5, TimeUnit.SECONDS))
        return result
    }

    fun awaitJs(web: WebView, expression: String, timeout: Long = 15000) {
        val deadline = SystemClock.uptimeMillis() + timeout
        while (SystemClock.uptimeMillis() < deadline) {
            if (js(web, expression) == "true") return
            SystemClock.sleep(100)
        }
        fail("Timed out: $expression")
    }

    fun awaitUi(scenario: ActivityScenario<MainActivity>, timeout: Long = 15000, what: String = "native state", check: (MainActivity) -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeout
        while (SystemClock.uptimeMillis() < deadline) {
            var ready = false
            scenario.onActivity { ready = check(it) }
            if (ready) return
            SystemClock.sleep(100)
        }
        fail("Timed out waiting for $what")
    }

    /** The native overlay is gone and the dock is in front. */
    fun dockShown(activity: MainActivity): Boolean =
        activity.findViewById<View>(R.id.screens).visibility == View.GONE &&
            activity.findViewById<WebView>(R.id.web).visibility == View.VISIBLE

    fun nativeShown(activity: MainActivity): Boolean = activity.findViewById<View>(R.id.screens).visibility == View.VISIBLE

    fun screenshot(context: Context, name: String) {
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(context.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
