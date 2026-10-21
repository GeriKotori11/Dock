package com.windock.app

import org.junit.Assert.*
import org.junit.Test

class ChangedForgetTest {
    private val idA = "5a0c7e0e-7d1b-4c2a-9f3e-a11d0e5c0de1"
    private val idB = "0b7f2c11-1111-4a2a-8f3e-b22d0e5c0de2"
    private val studio = Computer(idA, "DESKTOP-7H2KQ9L", "Studio PC", "windows", "https://192.168.1.20:8620", 10, 1)
    private val laptop = Computer(idB, "LAPTOP", null, "windows", "https://192.168.1.30:8620", 10, 1)

    @Test fun neverDeletesOnTheHostBecauseTheChangedCertificateCannotCarryTheSession() {
        assertFalse(ChangedForget.plan(studio, studio.endpoint, emptyList()).deleteOnHost)
        assertFalse(ChangedForget.plan(studio, "https://192.168.1.47:8620", listOf(laptop)).deleteOnHost)
    }

    @Test fun clearsTheCookieAtTheSavedAddress() {
        assertEquals(listOf(studio.endpoint), ChangedForget.plan(studio, studio.endpoint, emptyList()).clearCookies)
        // The same host over plain http is the same cookie host.
        assertEquals(listOf(studio.endpoint), ChangedForget.plan(studio, "http://192.168.1.20:8620", emptyList()).clearCookies)
    }

    @Test fun alsoClearsTheCookieWhereTheChangedCertificateAnswered() {
        val at = "https://192.168.1.47:8620"
        assertEquals(listOf(studio.endpoint, at), ChangedForget.plan(studio, at, listOf(laptop)).clearCookies)
    }

    @Test fun keepsTheCookieOfAnotherSavedComputerOnTheSameHost() {
        val sameHost = laptop.copy(endpoint = "https://192.168.1.20:8621")
        assertEquals(emptyList<String>(), ChangedForget.plan(studio, studio.endpoint, listOf(sameHost)).clearCookies)
        // The computer itself in the saved list does not protect its own cookie.
        assertEquals(listOf(studio.endpoint), ChangedForget.plan(studio, studio.endpoint, listOf(studio)).clearCookies)
    }
}
