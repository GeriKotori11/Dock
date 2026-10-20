package com.windock.app

import org.junit.Assert.*
import org.junit.Test

class TrustDecisionTest {
    private val idA = "5a0c7e0e-7d1b-4c2a-9f3e-a11d0e5c0de1"
    private val idB = "0b7f2c11-1111-4a2a-8f3e-b22d0e5c0de2"
    private val fpA = "a".repeat(64)
    private val fpX = "c".repeat(64)
    private val studio = Computer(idA, "DESKTOP-7H2KQ9L", "Studio PC", "windows", "https://192.168.1.20:8620", 10, 1)

    private fun probe(id: String?, presented: String?, endpoint: String = "https://192.168.1.20:8620", tls: Boolean = true) =
        Probe(endpoint, id, "DESKTOP-7H2KQ9L", "windows", tls, presented, true)

    @Test fun pinnedMatchAtSavedEndpointOpens() {
        assertEquals(Verdict.Open(studio, "https://192.168.1.20:8620", false), TrustDecision.forComputer(studio, fpA, probe(idA, fpA)))
    }

    @Test fun pinnedMismatchIsAlwaysTheFullScreenWarning() {
        val v = TrustDecision.forComputer(studio, fpA, probe(idA, fpX))
        assertEquals(Verdict.Mismatch(studio, fpA, fpX), v)
        // A trusted host that answers only over plain http no longer proves its identity.
        assertTrue(TrustDecision.forComputer(studio, fpA, probe(idA, null, "http://192.168.1.20:8620", tls = false)) is Verdict.Mismatch)
        // Found by Add by address, the same rule applies: never a confirm prompt.
        assertEquals(Verdict.Mismatch(studio, fpA, fpX),
            TrustDecision.forAddress(probe(idA, fpX), { if (it == idA) studio else null }, { if (it == idA) fpA else null }, 0))
    }

    @Test fun ipChangeWithMatchingPinOpensAtTheNewAddress() {
        val v = TrustDecision.forComputer(studio, fpA, probe(idA, fpA, "https://192.168.1.47:8620"))
        assertEquals(Verdict.Open(studio, "https://192.168.1.47:8620", true), v)
    }

    @Test fun newHostIdAtAnOldAddressIsANewComputer() {
        // Opening Studio PC: whoever answers at its old address is not it.
        assertEquals(Verdict.Elsewhere, TrustDecision.forComputer(studio, fpA, probe(idB, fpX)))
        // Entering that address: identity comes from the host ID, so it is pairing (step 1), not a prompt or a pass.
        val v = TrustDecision.forAddress(probe(idB, fpX), { if (it == idA) studio else null }, { if (it == idA) fpA else null }, 0)
        assertTrue(v is Verdict.Pair && v.computer == null && !v.pinChecked)
    }

    @Test fun knownHostIdWithoutComputerRecordStillChecksThePin() {
        val pins = { id: String -> if (id == idB) fpA else null }
        val ok = TrustDecision.forAddress(probe(idB, fpA), { null }, pins, 0)
        assertTrue(ok is Verdict.Pair && ok.pinChecked)
        assertTrue(TrustDecision.forAddress(probe(idB, fpX), { null }, pins, 0) is Verdict.Mismatch)
    }

    @Test fun forgottenPinMeansPairingAgainKeepingTheRecord() {
        val v = TrustDecision.forComputer(studio, null, probe(idA, fpX))
        assertTrue(v is Verdict.Pair && v.computer == studio && !v.pinChecked)
    }

    @Test fun legacyPlainHostOpensOnlyWhereItWasPaired() {
        val plain = studio.copy(endpoint = "http://192.168.1.20:8620")
        assertTrue(TrustDecision.forComputer(plain, null, probe(idA, null, "http://192.168.1.20:8620", tls = false)) is Verdict.Open)
        assertTrue(TrustDecision.forComputer(plain, null, probe(idA, null, "http://192.168.1.47:8620", tls = false)) is Verdict.Pair)
        // TLS advertised but the handshake failed: unverifiable.
        assertEquals(Verdict.Unusable, TrustDecision.forComputer(plain, null, probe(idA, null, "http://192.168.1.20:8620", tls = true)))
    }

    @Test fun answersWithoutAHostIdAreUnusable() {
        assertEquals(Verdict.Unusable, TrustDecision.forAddress(probe(null, fpA), { null }, { null }, 0))
        assertEquals(Verdict.Unusable, TrustDecision.forAddress(probe("not-an-id", fpA), { null }, { null }, 0))
    }

    @Test fun reachChecksPutTheDetectedCauseFirst() {
        val wifi = listOf(LocalNetwork("10.0.4.17", "10.0.4.255", 24, false))
        val subnet = ReachChecks.diagnose(wifi, "192.168.1.20", ProbeFailure.TIMEOUT, false, "windows")
        assertEquals(ReachChecks.Check.SUBNET, subnet.likely)
        assertEquals(listOf(ReachChecks.Check.SUBNET, ReachChecks.Check.RUNNING, ReachChecks.Check.ISOLATION), subnet.checks)
        assertEquals("10.0.4.17", subnet.phoneIp)
        val same = listOf(LocalNetwork("192.168.1.30", "192.168.1.255", 24, false))
        assertEquals(ReachChecks.Check.RUNNING, ReachChecks.diagnose(same, "192.168.1.20", ProbeFailure.REFUSED, false, "windows").likely)
        assertEquals(ReachChecks.Check.ISOLATION, ReachChecks.diagnose(same, "192.168.1.20", ProbeFailure.TIMEOUT, false, "windows").checks.first())
        val mac = ReachChecks.diagnose(same, "192.168.1.20", ProbeFailure.TIMEOUT, true, "macos")
        assertNull(mac.likely)
        assertEquals(listOf(ReachChecks.Check.RUNNING, ReachChecks.Check.FIREWALL, ReachChecks.Check.ISOLATION), mac.checks)
    }
}
