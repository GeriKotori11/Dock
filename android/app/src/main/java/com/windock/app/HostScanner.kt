package com.windock.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future

/**
 * Finds WinDock hosts while a connection screen is visible: Bonjour (NsdManager) and the
 * UDP v1 broadcast, merged by host ID. Every endpoint is probed over HTTPS before it is
 * reported, so `Found.probe.presented` is the certificate that host actually presented.
 * A host that stops answering is kept for 10 s before it is dropped (spec 5.3).
 */
class HostScanner(context: Context, private val io: ExecutorService, private val onChange: (Map<String, Found>) -> Unit) {
    data class Found(val probe: Probe, val txt: TxtRecord?, val seenAt: Long)

    private val main = Handler(Looper.getMainLooper())
    private val nsd = NsdDiscovery(context) { _, endpoint, txt -> main.post { candidate(endpoint, txt) } }
    private val candidates = LinkedHashMap<String, TxtRecord?>()
    private val found = LinkedHashMap<String, Found>()
    private val inFlight = HashSet<String>()
    private var udp: Future<*>? = null
    var running = false
        private set
    /** Whether anything at all answered recently (for the "network isolation" hint). */
    val sawAny: Boolean get() = found.isNotEmpty() || candidates.isNotEmpty()

    private val cycle = object : Runnable {
        override fun run() {
            if (!running) return
            scanUdp()
            candidates.keys.toList().forEach { probe(it) }
            prune()
            main.postDelayed(this, CYCLE_MS)
        }
    }

    fun start() {
        if (running) return
        running = true
        nsd.start()
        main.post(cycle)
    }

    fun stop() {
        if (!running) return
        running = false
        main.removeCallbacks(cycle)
        nsd.stop()
        udp?.cancel(true)
        udp = null
    }

    fun snapshot(): Map<String, Found> = LinkedHashMap(found)

    /** An endpoint learnt elsewhere (a saved computer's address) joins the probe rounds. */
    fun candidate(endpoint: String, txt: TxtRecord? = null) {
        val normalized = EndpointPolicy.withScheme(endpoint, "http") ?: return
        val known = candidates.containsKey(normalized)
        if (!known || txt != null) candidates[normalized] = txt ?: candidates[normalized]
        if (!known && running) probe(normalized)
    }

    private fun scanUdp() {
        if (udp?.isDone == false) return
        udp = io.submit {
            val replies = try { Discovery.scan() } catch (_: Exception) { emptySet() }
            main.post { if (running) replies.forEach { candidate(it) } }
        }
    }

    private fun probe(endpoint: String) {
        if (!inFlight.add(endpoint)) return
        val txt = candidates[endpoint]
        try {
            io.execute {
                val result = HostClient.probe(endpoint)
                main.post {
                    inFlight.remove(endpoint)
                    if (!running) return@post
                    val probe = (result as? HostClient.Result.Answer)?.probe ?: return@post
                    val hostId = probe.hostId ?: return@post
                    // A TXT record claiming another host ID than /health is ignored, not merged.
                    found[hostId] = Found(probe, txt?.takeIf { it.hostId == null || it.hostId == hostId }, SystemClock.uptimeMillis())
                    onChange(snapshot())
                }
            }
        } catch (_: Exception) { inFlight.remove(endpoint) }
    }

    private fun prune() {
        val now = SystemClock.uptimeMillis()
        val stale = found.filterValues { now - it.seenAt > KEEP_MS + CYCLE_MS }.keys
        if (stale.isNotEmpty()) {
            stale.forEach { found.remove(it) }
            onChange(snapshot())
        }
    }

    companion object {
        private const val CYCLE_MS = 4_000L
        private const val KEEP_MS = 10_000L
    }
}
