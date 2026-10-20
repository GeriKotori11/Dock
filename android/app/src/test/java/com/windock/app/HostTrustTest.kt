package com.windock.app

import org.junit.Assert.*
import org.junit.Test
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64

class HostTrustTest {
    // Generated with the host's own src/tls.js generateTlsIdentity; the expected
    // fingerprint and code are what the host printed for it.
    private val pem = """
        -----BEGIN CERTIFICATE-----
        MIIBoDCCAUegAwIBAgIQdakPw+b+0dPrxj/XksNHKzAKBggqhkjOPQQDAjA3MTUw
        MwYDVQQDDCxXaW5Eb2NrIDAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAw
        MDAwMTAeFw0yNTEyMzEwMDAwMDBaFw00NjAxMDEwMDAwMDBaMDcxNTAzBgNVBAMM
        LFdpbkRvY2sgMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxMFkw
        EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE22aKz7N5gwo2hyXt34rrEZE1NMgaSiD1
        A3nJxIRywxsAPkw9UzUFHyN0j/mWLtnsXnC33zAtNYjtJ/AnNgGvBKM1MDMwDAYD
        VR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEw
        CgYIKoZIzj0EAwIDRwAwRAIgYYH3f8zBvZuY22ZaZhcfD+etW29yRWw9gaLmKjqV
        NpUCIH9ofrnCbSOjH4+YExcrXzgIMvBw8PHhV8VPDcH9Zeo2
        -----END CERTIFICATE-----
    """.trimIndent()
    private val fingerprint = "6c12d78d87e6eba15840d4d65ec09e4a4ee9780410c2274b2dbeee22b2701870"
    private val other = "f".repeat(64)

    @Test fun fingerprintAndCodeMatchTheHost() {
        val der = Base64.getMimeDecoder().decode(pem.lines().filter { !it.startsWith("-----") }.joinToString(""))
        assertEquals(fingerprint, Fingerprint.of(der))
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate
        assertEquals(fingerprint, Fingerprint.of(cert.encoded))
        assertEquals("6C12-D78D-87E6", Fingerprint.securityCode(fingerprint))
        assertTrue(Fingerprint.isValid(fingerprint))
        listOf(null, "", fingerprint.uppercase(), fingerprint.dropLast(1), "${fingerprint}0", "g".repeat(64)).forEach {
            assertFalse("Must reject $it", Fingerprint.isValid(it))
        }
        assertThrows(IllegalArgumentException::class.java) { Fingerprint.securityCode("abc") }
    }

    @Test fun firstUseConfirmsAndPinnedHostsMustMatchExactly() {
        assertEquals(Trust.CONFIRM, PinDecision.decide(null, fingerprint))
        assertEquals(Trust.TRUST, PinDecision.decide(fingerprint, fingerprint))
        assertEquals(Trust.MISMATCH, PinDecision.decide(fingerprint, other))
        assertEquals(Trust.MISMATCH, PinDecision.decide(fingerprint, null))
        assertEquals(Trust.MISMATCH, PinDecision.decide(null, null))
        assertEquals(Trust.MISMATCH, PinDecision.decide(null, "not-a-fingerprint"))
        assertEquals(Trust.MISMATCH, PinDecision.decide(fingerprint, fingerprint.uppercase()))
    }

    @Test fun pinStoreAcceptsOnlyHostIdsAndFingerprints() {
        assertTrue(PinStore.isHostId("00000000-0000-4000-8000-000000000001"))
        listOf(null, "", "null", "00000000-0000-4000-8000-00000000000", "00000000-0000-4000-8000-0000000000012",
            "00000000-0000-4000-8000-00000000000G", "00000000000040008000000000000001",
            "00000000-0000-4000-8000-00000000000A", "../../evil").forEach {
            assertFalse("Must reject $it", PinStore.isHostId(it))
        }
    }
}
