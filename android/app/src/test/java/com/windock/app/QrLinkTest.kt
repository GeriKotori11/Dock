package com.windock.app

import org.junit.Assert.*
import org.junit.Test

class QrLinkTest {
    private val id1 = "Ww6POixBTX6aFnPCvk2R8A"
    private val fp1 = "biG08JOtXwx6EunUs4bxoMJefZtPYwGKLOV7lNPg9qE"
    private val sample1 = "windock://pair?v=1&id=$id1&addr=192.168.1.34:8620&fp=$fp1&pin=482913&name=Geris-MacBook-Air"
    private val sample2 = "windock://pair?v=1&id=0FvYxz2KR1yUq3nE8iWbPg&addr=192.168.1.20:8620&fp=o_BcHojSSRew5sNa8o0ed0C5xqXSH4Pgm0xX1qIefAk&pin=315780&name=DESKTOP-7H2KQ9L"

    private fun ok(raw: String): PairLink = (QrLink.parse(raw) as? LinkResult.Ok)?.link ?: throw AssertionError("expected a valid link")
    private fun invalid(raw: String?) = assertSame(LinkResult.Invalid, QrLink.parse(raw))
    private fun link(v: String = "1", id: String = id1, addr: String = "192.168.1.34:8620", fp: String = fp1,
                     pin: String = "482913", name: String = "Geris-MacBook-Air") =
        "windock://pair?v=$v&id=$id&addr=$addr&fp=$fp&pin=$pin&name=$name"

    @Test fun specSamplesParse() {
        val a = ok(sample1)
        assertEquals("5b0e8f3a-2c41-4d7e-9a16-73c2be4d91f0", a.hostId)
        assertEquals("https://192.168.1.34:8620", a.endpoint)
        assertEquals("192.168.1.34:8620", a.address)
        assertEquals("6e21b4f093ad5f0c7a12e9d4b386f1a0c25e7d9b4f63018a2ce57b94d3e0f6a1", a.fingerprint)
        assertEquals("6E21-B4F0-93AD", a.securityCode)
        assertEquals("482913", a.pin)
        assertEquals("Geris-MacBook-Air", a.displayName)
        val b = ok(sample2)
        assertEquals("d05bd8c7-3d8a-475c-94ab-79c4f2259b3e", b.hostId)
        assertEquals("A3F0-5C1E-88D2", b.securityCode)
        assertEquals("315780", b.pin)
        assertEquals("DESKTOP-7H2KQ9L", b.name)
    }

    @Test fun toStringNeverContainsThePin() {
        val a = ok(sample1)
        assertFalse(a.toString().contains("482913"))
        assertFalse(a.toString().contains(fp1))
    }

    @Test fun anyOrderAndUnknownKeysAreAccepted() {
        val reordered = "windock://pair?name=Geris-MacBook-Air&pin=482913&fp=$fp1&addr=192.168.1.34:8620&id=$id1&v=1"
        assertEquals(ok(sample1), ok(reordered))
        assertEquals(ok(sample1), ok("$sample1&future=thing&x"))
        assertEquals(ok(sample1), ok("WINDOCK://PAIR?" + sample1.substringAfter('?')))
        assertEquals(ok(sample1), ok("windock://pair/?" + sample1.substringAfter('?')))
    }

    @Test fun nameIsOptionalAndPercentDecoded() {
        assertEquals("192.168.1.34", ok(link(name = "")).displayName)
        assertEquals("192.168.1.34", ok(sample1.substringBefore("&name=")).displayName)
        assertEquals("Geri’s PC", ok(link(name = "Geri%E2%80%99s%20PC")).name)
        // Control characters are removed from the display name.
        assertEquals("ab", ok(link(name = "a%0Ab")).name)
        invalid(link(name = "bad%zz"))
        invalid(link(name = "half%E2%80"))
    }

    @Test fun duplicateKnownKeysReject() {
        for (key in listOf("v=1", "id=$id1", "addr=192.168.1.34:8620", "fp=$fp1", "pin=482913", "name=x")) invalid("$sample1&$key")
        // Even a different value for the second copy.
        invalid("$sample1&pin=111111")
    }

    @Test fun newerVersionsAskForAnUpdate() {
        assertSame(LinkResult.Newer, QrLink.parse(link(v = "2")))
        assertSame(LinkResult.Newer, QrLink.parse("windock://pair?v=7&whatever=1"))
        invalid(link(v = "0"))
        invalid(link(v = "01"))
        invalid(link(v = "x"))
        invalid(sample1.replace("v=1&", ""))
    }

    @Test fun eachInvalidFieldRejects() {
        invalid(sample1.replace("id=$id1&", ""))
        invalid(sample1.replace("&addr=192.168.1.34:8620", ""))
        invalid(sample1.replace("&fp=$fp1", ""))
        invalid(sample1.replace("&pin=482913", ""))
        invalid(link(pin = "48291"))
        invalid(link(pin = "4829131"))
        invalid(link(pin = "48291a"))
        invalid(link(pin = "%34%38%32%39%31%33x"))
        invalid(link(pin = "٤٨٢٩١٣")) // non-ASCII digits
        invalid(link(addr = "192.168.1.34"))
        invalid(link(addr = "192.168.1.34:0"))
        invalid(link(addr = "192.168.1.34:65536"))
        invalid(link(addr = "192.168.1.34:08620"))
        invalid(link(addr = "192.168.01.34:8620"))
        invalid(link(addr = "192.168.1.256:8620"))
        invalid(link(addr = "pc.local:8620"))
        invalid(link(addr = "[fe80::1]:8620"))
        invalid(link(addr = "user@192.168.1.34:8620"))
    }

    @Test fun onlyPrivateAddresses() {
        assertEquals("https://10.0.0.5:8620", ok(link(addr = "10.0.0.5:8620")).endpoint)
        assertEquals("https://172.16.0.1:1", ok(link(addr = "172.16.0.1:1")).endpoint)
        assertEquals("https://172.31.255.254:65535", ok(link(addr = "172.31.255.254:65535")).endpoint)
        invalid(link(addr = "8.8.8.8:8620"))
        invalid(link(addr = "172.32.0.1:8620"))
        invalid(link(addr = "172.15.0.1:8620"))
        invalid(link(addr = "192.169.1.1:8620"))
        invalid(link(addr = "127.0.0.1:8620"))
        invalid(link(addr = "0.0.0.0:8620"))
    }

    @Test fun base64UrlMustBeExactUnpaddedAndCanonical() {
        invalid(link(id = "$id1=="))
        invalid(link(fp = "$fp1="))
        invalid(link(id = id1.dropLast(1)))
        invalid(link(id = id1 + "A"))
        invalid(link(fp = fp1.dropLast(1)))
        invalid(link(id = id1.replace('W', '+')))
        invalid(link(fp = fp1.replace('_', '/').replace('b', '/')))
        invalid(link(id = id1.replace('W', '.')))
        // Last char 'A' -> 'B' sets a trailing bit that does not belong to any byte.
        invalid(link(id = id1.dropLast(1) + "B"))
        invalid(link(fp = fp1.dropLast(1) + "r"))
        // The URL-safe characters themselves decode.
        assertEquals("a3f05c1e88d24917b0e6c35af28d1e7740b9c6a5d21f83e09b4c57d6a21e7c09", ok(sample2).fingerprint)
        assertNotNull(QrLink.base64Url("-_-_-_-_-_-_-_-_-_-_-w", 16))
    }

    @Test fun otherSchemesHostsAndShapesReject() {
        invalid(null)
        invalid("")
        invalid(sample1.replace("windock://", "https://"))
        invalid(sample1.replace("windock://pair", "windock://pairing"))
        invalid(sample1.replace("windock://pair", "windock://pair/x"))
        invalid(sample1.replace("windock://pair", "windock://evil@pair"))
        invalid(sample1.replace("windock://pair", "windock://pair:80"))
        invalid("$sample1#frag")
        invalid("windock://pair")
        invalid(sample1 + "&pad=" + "x".repeat(600))
    }

    // ---- decision before any network traffic ----

    private val now = 1_000L
    private val known = Computer("5b0e8f3a-2c41-4d7e-9a16-73c2be4d91f0", "Geris-MacBook-Air", null, "macos",
        "https://192.168.1.30:8620", 10, 1)
    private val scanned get() = ok(sample1)
    private val otherFp = "c".repeat(64)

    @Test fun unknownHostConfirms() {
        assertEquals(QrStart.Confirm(again = false), QrDecision.decide(scanned, null, null, false, now))
    }

    @Test fun savedPinDifferentFromTheScannedOneIsTheSecurityWarning() {
        assertEquals(QrStart.Changed(known, otherFp), QrDecision.decide(scanned, known, otherFp, true, now))
        // A pin with no saved computer (forgotten list entry) still never re-pins silently.
        val v = QrDecision.decide(scanned, null, otherFp, false, now) as QrStart.Changed
        assertEquals(scanned.hostId, v.computer.hostId)
        assertEquals(otherFp, v.pinned)
    }

    @Test fun samePinWithSessionOpensTheDock() {
        assertEquals(QrStart.OpenDock(known), QrDecision.decide(scanned, known, scanned.fingerprint, true, now))
    }

    @Test fun samePinWithoutSessionAsksToPairAgain() {
        assertEquals(QrStart.Confirm(again = true), QrDecision.decide(scanned, known, scanned.fingerprint, false, now))
        assertEquals(QrStart.Confirm(again = true), QrDecision.decide(scanned, known.copy(needsPin = true), scanned.fingerprint, true, now))
        assertEquals(QrStart.Confirm(again = true), QrDecision.decide(scanned, null, scanned.fingerprint, false, now))
        // A legacy plain-http computer (nothing pinned) pairs again over TLS.
        assertEquals(QrStart.Confirm(again = true), QrDecision.decide(scanned, known, null, true, now))
    }

    @Test fun onlyTheScannedIdentityIsAccepted() {
        val good = Probe("https://192.168.1.34:8620", scanned.hostId, "Geris-MacBook-Air", "macos", true, scanned.fingerprint, true)
        assertTrue(QrDecision.accepts(scanned, good))
        assertFalse(QrDecision.accepts(scanned, good.copy(presented = otherFp)))
        assertFalse(QrDecision.accepts(scanned, good.copy(presented = null)))
        assertFalse(QrDecision.accepts(scanned, good.copy(hostId = "0b7f2c11-1111-4a2a-8f3e-b22d0e5c0de2")))
        assertFalse(QrDecision.accepts(scanned, good.copy(endpoint = "http://192.168.1.34:8620")))
    }

    @Test fun fingerprintMatchIsExact() {
        val a = "a".repeat(64)
        assertTrue(Fingerprint.matches(a, a))
        assertFalse(Fingerprint.matches(a, "a".repeat(63) + "b"))
        assertFalse(Fingerprint.matches(a, null))
        assertFalse(Fingerprint.matches("A".repeat(64), "A".repeat(64)))
    }
}
