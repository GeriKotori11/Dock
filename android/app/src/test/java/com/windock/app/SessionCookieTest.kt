package com.windock.app

import org.junit.Assert.*
import org.junit.Test

class SessionCookieTest {
    @Test fun hostSetCookieKeepsEveryAttribute() {
        // Exactly what src/auth.js sessionCookie() sends over HTTPS.
        val header = "windock_session=Zm9vYmFy_-123; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000; Secure"
        val c = SessionCookie.parse(header)!!
        assertEquals("Zm9vYmFy_-123", c.value)
        assertEquals(SessionCookie("Zm9vYmFy_-123", "/", 15552000, httpOnly = true, secure = true, sameSite = "Lax"), c)
        assertEquals("windock_session=Zm9vYmFy_-123; Path=/; Max-Age=15552000; HttpOnly; Secure; SameSite=Lax", c.format())
        assertEquals("windock_session=Zm9vYmFy_-123", c.requestHeader())
    }

    @Test fun plainHttpCookieHasNoSecureAndDomainIsDropped() {
        val c = SessionCookie.parse("windock_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Domain=evil.example")!!
        assertFalse(c.secure)
        assertFalse(c.format().contains("Domain"))
        assertEquals("windock_session=abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax", c.format())
    }

    @Test fun foreignOrMalformedCookiesAreRejected() {
        assertNull(SessionCookie.parse("other=abc; Path=/"))
        assertNull(SessionCookie.parse("windock_session=; Path=/"))
        assertNull(SessionCookie.parse("windock_session=a b; Path=/"))
        assertNull(SessionCookie.parse("windock_session=a,b"))
        assertNull(SessionCookie.parse(null))
        assertEquals("abc", SessionCookie.fromHeaders(listOf("x=1", "windock_session=abc; Path=/"))!!.value)
    }

    @Test fun cookieFromTheStoreIsRebuiltForANewOrigin() {
        val moved = SessionCookie.fromJar("theme=dark; windock_session=tok123", secure = true)!!
        assertEquals("windock_session=tok123; Path=/; Max-Age=15552000; HttpOnly; Secure; SameSite=Lax", moved.format())
        assertNull(SessionCookie.fromJar("theme=dark", true))
        assertNull(SessionCookie.fromJar(null, true))
        assertEquals("windock_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax", SessionCookie.expired(true))
    }

    @Test fun txtRecordHintsAreValidated() {
        fun b(s: String) = s.toByteArray()
        val txt = TxtRecord.parse(mapOf("id" to b("5A0C7E0E-7D1B-4C2A-9F3E-A11D0E5C0DE1"), "api" to b("1"), "tls" to b("1"),
            "addr" to b("192.168.1.20"), "name" to b("DESKTOP-7H2KQ9L\u0007"), "os" to b("windows")))
        assertEquals("5a0c7e0e-7d1b-4c2a-9f3e-a11d0e5c0de1", txt.hostId)
        assertEquals("DESKTOP-7H2KQ9L", txt.name)
        assertEquals("windows", txt.os)
        assertEquals(true, txt.tls)
        assertEquals(1, txt.api)
        assertEquals("http://192.168.1.20:8620", txt.endpoint("192.168.1.99", 8620))
        // A public or junk addr is ignored in favour of the resolved local address.
        val junk = TxtRecord.parse(mapOf("addr" to b("8.8.8.8"), "id" to b("nope"), "os" to b("plan9"), "tls" to null))
        assertNull(junk.addr); assertNull(junk.hostId); assertEquals("", junk.os); assertNull(junk.tls)
        assertEquals("http://192.168.1.99:8620", junk.endpoint("/192.168.1.99", 8620))
        assertNull(junk.endpoint("8.8.4.4", 8620))
        assertNull(junk.endpoint("192.168.1.99", 0))
        assertEquals("macos", TxtRecord.parse(mapOf("OS" to b("macos"))).os)
    }
}
