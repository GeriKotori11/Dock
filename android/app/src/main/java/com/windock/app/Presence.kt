package com.windock.app

import android.os.Handler
import android.os.Looper
import java.util.concurrent.ExecutorService

/**
 * Live status of paired computers for the hub and the switch sheet: one direct probe of
 * each saved endpoint plus verified discovery results. Status is never trust: opening a
 * computer always goes through ConnectionCoordinator again.
 */
class Presence(private val io: ExecutorService, private val pin: (String) -> String?) {
    enum class State { CHECKING, ONLINE, NOT_FOUND, CHANGED }
    data class Entry(val state: State, val address: String? = null)

    private val main = Handler(Looper.getMainLooper())
    private val entries = HashMap<String, Entry>()
    private val listeners = LinkedHashSet<() -> Unit>()
    private var generation = 0

    fun of(hostId: String): Entry = entries[hostId] ?: Entry(State.CHECKING)

    fun listen(listener: () -> Unit) { listeners.add(listener) }
    fun unlisten(listener: () -> Unit) { listeners.remove(listener) }
    private fun changed() = listeners.toList().forEach { it() }

    /** The hub or the sheet opened: show "Checking…" for up to 2 s while every saved endpoint is probed. */
    fun refresh(computers: List<Computer>, connected: String? = null) {
        val run = ++generation
        entries.keys.retainAll(computers.map { it.hostId }.toSet())
        for (c in computers) {
            if (c.hostId == connected) { entries[c.hostId] = Entry(State.ONLINE, c.address); continue }
            if (entries[c.hostId]?.state != State.ONLINE) entries[c.hostId] = Entry(State.CHECKING)
            io.execute {
                val result = HostClient.probe(c.endpoint)
                main.post {
                    if (run != generation) return@post
                    val probe = (result as? HostClient.Result.Answer)?.probe
                    if (probe != null && apply(c, probe)) return@post
                    if (entries[c.hostId]?.state == State.CHECKING) { entries[c.hostId] = Entry(State.NOT_FOUND); changed() }
                }
            }
        }
        main.postDelayed({
            if (run != generation) return@postDelayed
            var any = false
            for (c in computers) if (entries[c.hostId]?.state == State.CHECKING) { entries[c.hostId] = Entry(State.NOT_FOUND); any = true }
            if (any) changed()
        }, 2_000)
        changed()
    }

    fun markOnline(c: Computer, endpoint: String) {
        entries[c.hostId] = Entry(State.ONLINE, DisplayName.hostOf(endpoint)); changed()
    }

    /** A verified discovery result for a paired computer updates its row. */
    fun discovered(computers: List<Computer>, found: Map<String, HostScanner.Found>) {
        var any = false
        for (c in computers) found[c.hostId]?.let { if (apply(c, it.probe, notify = false)) any = true }
        if (any) changed()
    }

    private fun apply(c: Computer, probe: Probe, notify: Boolean = true): Boolean {
        val entry = when (val v = TrustDecision.forComputer(c, pin(c.hostId), probe)) {
            is Verdict.Open -> Entry(State.ONLINE, DisplayName.hostOf(v.endpoint))
            is Verdict.Pair -> Entry(State.ONLINE, DisplayName.hostOf(probe.endpoint))
            is Verdict.Mismatch -> Entry(State.CHANGED, DisplayName.hostOf(probe.endpoint))
            else -> return false
        }
        if (entries[c.hostId] == entry) return true
        entries[c.hostId] = entry
        if (notify) changed()
        return true
    }

    fun stop() { generation++ }
}
