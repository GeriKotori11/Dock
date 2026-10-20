package com.windock.app

import org.junit.Assert.*
import org.junit.Test

class ComputerStoreTest {
    private val idA = "5a0c7e0e-7d1b-4c2a-9f3e-a11d0e5c0de1"
    private val idB = "0b7f2c11-1111-4a2a-8f3e-b22d0e5c0de2"
    private val fpA = "a".repeat(64)
    private val fpB = "b".repeat(64)

    private class MapStorage : ComputerStore.Storage {
        val map = HashMap<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }

    private var now = 1_000L
    private fun store(storage: MapStorage = MapStorage()) = ComputerStore(storage) { now }

    @Test fun roundTripKeepsEveryFieldAndOrdersByLastConnected() {
        val storage = MapStorage()
        val s = store(storage)
        val a = Computer(idA, "DESKTOP-7H2KQ9L", "Studio PC", "windows", "https://192.168.1.20:8620", 500, 100)
        val b = Computer(idB, "Geris-MacBook-Air.local", null, "macos", "https://192.168.1.34:8620", 900, 200, needsPin = true)
        s.save(a); s.save(b)
        val again = store(storage)
        assertEquals(listOf(b, a), again.all())
        assertEquals(b, again.last())
        assertEquals(a, again.get(idA))
        // Saving again replaces, never duplicates.
        s.save(a.copy(nickname = "Desk"))
        assertEquals(2, again.all().size)
        assertEquals("Desk", again.get(idA)!!.displayName)
        s.remove(idB)
        assertEquals(listOf(idA), again.all().map { it.hostId })
    }

    @Test fun markConnectedUpdatesEndpointTimeAndClearsNeedsPin() {
        val s = store()
        s.save(Computer(idA, "PC", endpoint = "https://192.168.1.20:8620", addedAt = 1, needsPin = true))
        now = 5_000
        val c = s.markConnected(idA, "https://192.168.1.47:8620")!!
        assertEquals("https://192.168.1.47:8620", c.endpoint)
        assertEquals(5_000L, c.lastConnectedAt)
        assertFalse(c.needsPin)
    }

    @Test fun malformedDocumentsAndEntriesAreDropped() {
        val storage = MapStorage()
        storage.map["computers"] = "{not json"
        assertTrue(store(storage).all().isEmpty())
        storage.map["computers"] = """{"v":1,"computers":[{"hostId":"nope","endpoint":"https://192.168.1.2:8620"},
            {"hostId":"$idA","endpoint":"https://8.8.8.8:8620"},
            {"hostId":"$idB","hostName":"PC\u0007","endpoint":"https://192.168.1.2:8620","addedAt":3}]}"""
        val list = store(storage).all()
        assertEquals(listOf(idB), list.map { it.hostId })
        assertEquals("PC", list[0].hostName)
    }

    @Test fun migrationWithOnePinKeepsTheCurrentPairingWithoutTheNetwork() {
        val storage = MapStorage()
        store(storage).migrateIfNeeded(listOf("https://192.168.1.20:8620", "http://192.168.42.10:8620"), mapOf(idA to fpA))
        val c = store(storage).last()!!
        assertEquals(idA, c.hostId)
        assertEquals("https://192.168.1.20:8620", c.endpoint)
        assertEquals("192.168.1.20", c.displayName)
        assertTrue(store(storage).pendingLegacy().isEmpty())
        // It runs once: a later forget is not undone by migrating again.
        store(storage).remove(idA)
        store(storage).migrateIfNeeded(listOf("https://192.168.1.20:8620"), mapOf(idA to fpA))
        assertTrue(store(storage).all().isEmpty())
    }

    @Test fun ambiguousMigrationWaitsForOneProbeThatNeverPrompts() {
        val storage = MapStorage()
        store(storage).migrateIfNeeded(listOf("https://192.168.1.20:8620"), mapOf(idA to fpA, idB to fpB))
        assertTrue(store(storage).all().isEmpty())
        assertEquals(listOf("https://192.168.1.20:8620"), store(storage).pendingLegacy())
        val pins = mapOf(idA to fpA, idB to fpB)
        fun probe(id: String, presented: String?, tls: Boolean, endpoint: String) =
            Probe(endpoint, id, "Studio", "windows", tls, presented, true)
        assertEquals(idB, LegacyMigration.accept(probe(idB, fpB, true, "https://192.168.1.20:8620"), pins, 9)!!.hostId)
        assertNull("a changed certificate is never migrated", LegacyMigration.accept(probe(idB, fpA, true, "https://192.168.1.20:8620"), pins, 9))
        // A pre-TLS host the old app used over plain http.
        assertNotNull(LegacyMigration.accept(probe("0c7f2c11-1111-4a2a-8f3e-b22d0e5c0de3", null, false, "http://192.168.1.9:8620"), emptyMap(), 9))
        // TLS advertised but never pinned: that needs pairing, so it is not migrated.
        assertNull(LegacyMigration.accept(probe("0c7f2c11-1111-4a2a-8f3e-b22d0e5c0de3", fpA, true, "https://192.168.1.9:8620"), emptyMap(), 9))
    }

    @Test fun plainLegacyEndpointIsPendingAndNothingIsInvented() {
        val plan = LegacyMigration.plan(listOf("http://192.168.1.20:8620"), mapOf(idA to fpA), 1)
        assertTrue(plan.computers.isEmpty())
        assertEquals(listOf("http://192.168.1.20:8620"), plan.pending)
        assertTrue(LegacyMigration.plan(emptyList(), mapOf(idA to fpA), 1).pending.isEmpty())
    }

    @Test fun displayNameRules() {
        assertEquals("Studio PC", DisplayName.of("  Studio PC ", "DESKTOP-7H2KQ9L"))
        assertEquals("Geris-MacBook-Air", DisplayName.of(null, "Geris-MacBook-Air.local"))
        assertEquals("Geris-MacBook-Air", DisplayName.of("", "Geris-MacBook-Air.LOCAL"))
        assertEquals(60, DisplayName.of(null, "x".repeat(200)).length)
        assertEquals("192.168.1.20", DisplayName.of(null, " ", "https://192.168.1.20:8620"))
        assertEquals(40, DisplayName.nickname("n".repeat(80))!!.length)
        assertNull("empty restores the computer's own name", DisplayName.nickname("   "))
        assertEquals("PC", DisplayName.of("P\u0000C", "x"))
        assertEquals("macOS", DisplayName.platformLabel("macos"))
        assertEquals("Windows", DisplayName.platformLabel("windows"))
        assertEquals("", DisplayName.platformLabel("beos"))
    }

    @Test fun miniJsonRoundTrip() {
        val value = mapOf("a" to "q\"uo\\te\n\u0001é", "n" to 12L, "f" to 1.5, "b" to true, "z" to null, "l" to listOf(1L, "x"))
        assertEquals(value, MiniJson.parse(MiniJson.write(value)))
        assertEquals("\u00e9", MiniJson.parse("\"\\u00e9\""))
        for (bad in listOf("", "{", "[1,]", "{\"a\" 1}", "tru", "\"\\x\"", "1 2", "{\"a\":1}x")) {
            assertThrows(IllegalArgumentException::class.java) { MiniJson.parse(bad) }
        }
    }
}
