package com.windock.app

import android.content.Context

/**
 * Saved computers as one JSON document (spec section 12). Storage is abstract so the
 * JVM tests can run it without Android; [ComputerStore.of] binds it to SharedPreferences.
 */
class ComputerStore(private val storage: Storage, private val clock: () -> Long = System::currentTimeMillis) {
    interface Storage {
        fun get(key: String): String?
        fun put(key: String, value: String?)
    }

    /** Paired computers, most recently connected first (spec 5.3 ordering). */
    fun all(): List<Computer> = ComputerCodec.decode(storage.get(KEY_LIST))
        .sortedWith(compareByDescending<Computer> { it.lastConnectedAt ?: 0L }.thenByDescending { it.addedAt })

    fun get(hostId: String?): Computer? = hostId?.let { id -> all().firstOrNull { it.hostId == id } }

    /** "Last computer": the paired computer with the latest lastConnectedAt. */
    fun last(): Computer? = all().firstOrNull()

    fun isEmpty(): Boolean = all().isEmpty()

    fun save(computer: Computer) {
        val rest = all().filter { it.hostId != computer.hostId }
        storage.put(KEY_LIST, ComputerCodec.encode(rest + computer))
    }

    fun update(hostId: String, change: (Computer) -> Computer): Computer? {
        val current = get(hostId) ?: return null
        return change(current).also { save(it) }
    }

    fun remove(hostId: String) {
        storage.put(KEY_LIST, ComputerCodec.encode(all().filter { it.hostId != hostId }))
    }

    fun markConnected(hostId: String, endpoint: String) = update(hostId) {
        it.copy(endpoint = EndpointPolicy.normalize(endpoint) ?: it.endpoint, lastConnectedAt = clock(), needsPin = false)
    }

    /** Endpoints from the pre-computers app that still need one probe to learn their host ID. */
    fun pendingLegacy(): List<String> =
        storage.get(KEY_PENDING)?.split('\n')?.mapNotNull { EndpointPolicy.normalize(it) }.orEmpty()

    fun clearPendingLegacy() = storage.put(KEY_PENDING, null)

    /**
     * One-time move from the single remembered Wi-Fi/USB address and PinStore. Runs
     * without the network so the user's current pairing survives an offline launch.
     */
    fun migrateIfNeeded(legacy: List<String>, pins: Map<String, String>) {
        if (storage.get(KEY_MIGRATED) != null) return
        val plan = LegacyMigration.plan(legacy, pins, clock())
        if (all().isEmpty()) plan.computers.forEach(::save)
        if (plan.pending.isNotEmpty()) storage.put(KEY_PENDING, plan.pending.joinToString("\n"))
        storage.put(KEY_MIGRATED, "1")
    }

    companion object {
        private const val KEY_LIST = "computers"
        private const val KEY_PENDING = "legacyPending"
        private const val KEY_MIGRATED = "migrated"

        fun of(context: Context): ComputerStore {
            val prefs = context.applicationContext.getSharedPreferences("computers", Context.MODE_PRIVATE)
            return ComputerStore(object : Storage {
                override fun get(key: String): String? = prefs.getString(key, null)
                // commit: the list must survive a force-stop right after pairing.
                override fun put(key: String, value: String?) {
                    prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.commit()
                }
            })
        }

        /** Today's remembered endpoints, the last-used transport first. */
        fun legacyEndpoints(context: Context): List<String> {
            val prefs = context.getSharedPreferences("windock", Context.MODE_PRIVATE)
            val usbFirst = PhonePreferences.usbOnly(context)
            val keys = if (usbFirst) listOf("usbEndpoint", "wifiEndpoint", "endpoint") else listOf("wifiEndpoint", "usbEndpoint", "endpoint")
            return keys.mapNotNull { prefs.getString(it, null)?.let(EndpointPolicy::normalize) }.distinct()
        }
    }
}

object LegacyMigration {
    class Plan(val computers: List<Computer>, val pending: List<String>)

    /**
     * The old app stored the https form of an endpoint only after it verified the
     * certificate pinned for that host. With exactly one pin, that endpoint belongs
     * to that host ID, so it becomes a Computer with no probe. Anything ambiguous
     * waits for one probe ([accept]) and never prompts.
     */
    fun plan(legacy: List<String>, pins: Map<String, String>, now: Long): Plan {
        val endpoints = legacy.mapNotNull { EndpointPolicy.normalize(it) }.distinct()
        if (endpoints.isEmpty()) return Plan(emptyList(), emptyList())
        val first = endpoints.first()
        val only = pins.entries.singleOrNull()?.takeIf { PinStore.isHostId(it.key) && Fingerprint.isValid(it.value) }
        if (only != null && first.startsWith("https://")) {
            return Plan(listOf(Computer(hostId = only.key, hostName = "", endpoint = first,
                lastConnectedAt = now, addedAt = now)), emptyList())
        }
        return Plan(emptyList(), endpoints)
    }

    /** A pending legacy endpoint answered: keep it only when it needs no prompt at all. */
    fun accept(probe: Probe, pins: Map<String, String>, now: Long): Computer? {
        val hostId = probe.hostId?.takeIf(PinStore::isHostId) ?: return null
        val pinned = pins[hostId]
        val ok = if (pinned != null) probe.presented == pinned && probe.endpoint.startsWith("https://")
        else probe.presented == null && !probe.tlsAdvertised && probe.endpoint.startsWith("http://")
        if (!ok) return null
        return Computer(hostId = hostId, hostName = probe.hostName, platform = probe.platform,
            endpoint = probe.endpoint, lastConnectedAt = now, addedAt = now)
    }
}
