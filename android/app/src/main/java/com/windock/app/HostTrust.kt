package com.windock.app

import java.security.MessageDigest

/**
 * Certificate identity as the host reports it (src/tls.js): the fingerprint is
 * the lowercase hex SHA-256 of the certificate DER, and the security code is
 * its first 6 bytes as uppercase hex, `XXXX-XXXX-XXXX`.
 */
object Fingerprint {
    private val HEX = Regex("[0-9a-f]{64}")

    fun of(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

    fun isValid(value: String?): Boolean = value != null && HEX.matches(value)

    /** Constant-time equality of two valid fingerprints (the TLS pin checks). */
    fun matches(a: String?, b: String?): Boolean =
        isValid(a) && isValid(b) && MessageDigest.isEqual(a!!.toByteArray(Charsets.US_ASCII), b!!.toByteArray(Charsets.US_ASCII))

    fun securityCode(fingerprint: String): String {
        require(isValid(fingerprint)) { "not a fingerprint" }
        val head = fingerprint.substring(0, 12).uppercase()
        return "${head.substring(0, 4)}-${head.substring(4, 8)}-${head.substring(8, 12)}"
    }
}

/** What to do with the certificate a host presented in the TLS handshake. */
enum class Trust { TRUST, CONFIRM, MISMATCH }

object PinDecision {
    /** `pinned` is the stored fingerprint for this host ID, or null if never paired. */
    fun decide(pinned: String?, presented: String?): Trust = when {
        !Fingerprint.isValid(presented) -> Trust.MISMATCH
        pinned == null -> Trust.CONFIRM
        pinned == presented -> Trust.TRUST
        else -> Trust.MISMATCH
    }
}
