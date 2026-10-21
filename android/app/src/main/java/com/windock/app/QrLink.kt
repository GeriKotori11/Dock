package com.windock.app

import java.io.ByteArrayOutputStream

/**
 * A scanned `windock://pair` link (docs/design/HOST-CONTROL-PAGE.md 9.1). It carries a
 * one-time PIN, so it is never logged: [toString] leaves the PIN out, and the parser
 * never puts the input into an exception or a message.
 */
data class PairLink(
    /** Canonical lowercase host ID UUID. */
    val hostId: String,
    /** `https://<private ipv4>:<port>`, normalized by [EndpointPolicy]. */
    val endpoint: String,
    /** Lowercase hex SHA-256 of the leaf certificate, as [Fingerprint] uses everywhere. */
    val fingerprint: String,
    val pin: String,
    /** Display only, already cleaned; may be empty. */
    val name: String,
) {
    val address: String get() = endpoint.removePrefix("https://")
    val displayName: String get() = DisplayName.of(null, name, endpoint)
    val securityCode: String get() = Fingerprint.securityCode(fingerprint)

    override fun toString(): String = "PairLink(hostId=$hostId, endpoint=$endpoint)"
}

sealed class LinkResult {
    data class Ok(val link: PairLink) : LinkResult()
    /** Malformed: "This isn't a WinDock pairing code". */
    object Invalid : LinkResult()
    /** `v` above 1: "This code needs a newer WinDock app". */
    object Newer : LinkResult()
}

/**
 * Strict parser for 9.1: any field order, unknown keys ignored, a repeated known key
 * rejects the whole link. `id` and `fp` are unpadded base64url of exactly 16 and 32 bytes;
 * `addr` is a private IPv4 address with an explicit port; `pin` is six ASCII digits.
 */
object QrLink {
    private const val MAX_LENGTH = 512
    private val KNOWN = setOf("v", "id", "addr", "fp", "pin", "name")
    private val VERSION = Regex("[1-9][0-9]{0,8}")
    private val ADDR = Regex("((?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}):([1-9][0-9]{0,4})")
    private val PIN = Regex("[0-9]{6}")
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun parse(raw: String?): LinkResult = try { parseOrNull(raw) } catch (_: Exception) { LinkResult.Invalid }

    private fun parseOrNull(raw: String?): LinkResult {
        if (raw == null || raw.length > MAX_LENGTH) return LinkResult.Invalid
        val schemeEnd = raw.indexOf("://")
        if (schemeEnd < 0 || !raw.substring(0, schemeEnd).equals("windock", ignoreCase = true)) return LinkResult.Invalid
        val rest = raw.substring(schemeEnd + 3)
        if ('#' in rest) return LinkResult.Invalid
        val q = rest.indexOf('?')
        if (q < 0) return LinkResult.Invalid
        // Only host "pair": no user info, port or path.
        val target = rest.substring(0, q)
        if (!target.equals("pair", ignoreCase = true) && !target.equals("pair/", ignoreCase = true)) return LinkResult.Invalid

        val fields = HashMap<String, String>()
        for (part in rest.substring(q + 1).split('&')) {
            if (part.isEmpty()) continue
            val eq = part.indexOf('=')
            val key = if (eq < 0) part else part.substring(0, eq)
            if (key !in KNOWN) continue
            if (key in fields) return LinkResult.Invalid
            fields[key] = percentDecode(if (eq < 0) "" else part.substring(eq + 1)) ?: return LinkResult.Invalid
        }

        val version = fields["v"]?.takeIf { VERSION.matches(it) }?.toInt() ?: return LinkResult.Invalid
        if (version > 1) return LinkResult.Newer

        val hostId = fields["id"]?.let { base64Url(it, 16) }?.let(::uuid)?.takeIf(PinStore::isHostId) ?: return LinkResult.Invalid
        val endpoint = fields["addr"]?.let(::endpoint) ?: return LinkResult.Invalid
        val fingerprint = fields["fp"]?.let { base64Url(it, 32) }?.let(::hex)?.takeIf(Fingerprint::isValid) ?: return LinkResult.Invalid
        val pin = fields["pin"]?.takeIf { PIN.matches(it) } ?: return LinkResult.Invalid
        val name = DisplayName.clean(fields["name"], DisplayName.NAME_MAX)
        return LinkResult.Ok(PairLink(hostId, endpoint, fingerprint, pin, name))
    }

    /** `a.b.c.d:port` on 10/8, 172.16/12 or 192.168/16 only, port 1 to 65535. */
    private fun endpoint(addr: String): String? {
        val m = ADDR.matchEntire(addr) ?: return null
        val octets = m.groupValues[1].split('.').map { it.toInt() }
        if (octets.any { it > 255 }) return null
        val isPrivate = octets[0] == 10 ||
            (octets[0] == 172 && octets[1] in 16..31) ||
            (octets[0] == 192 && octets[1] == 168)
        if (!isPrivate) return null
        val port = m.groupValues[2].toInt()
        if (port !in 1..65535) return null
        return EndpointPolicy.normalize("https://${m.groupValues[1]}:$port")
    }

    /** Unpadded base64url of exactly [bytes] bytes, with zero trailing bits (one spelling per value). */
    internal fun base64Url(text: String, bytes: Int): ByteArray? {
        if (text.length != (bytes * 8 + 5) / 6) return null
        val out = ByteArrayOutputStream(bytes)
        var buffer = 0
        var bits = 0
        for (c in text) {
            val v = ALPHABET.indexOf(c)
            if (v < 0) return null
            buffer = (buffer shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buffer shr bits) and 0xff)
                buffer = buffer and ((1 shl bits) - 1)
            }
        }
        if (buffer != 0) return null
        return out.toByteArray().takeIf { it.size == bytes }
    }

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    private fun uuid(bytes: ByteArray): String = hex(bytes).let {
        "${it.substring(0, 8)}-${it.substring(8, 12)}-${it.substring(12, 16)}-${it.substring(16, 20)}-${it.substring(20)}"
    }

    /** RFC 3986 percent-decoding as UTF-8; a malformed escape or invalid UTF-8 rejects the value. */
    private fun percentDecode(value: String): String? {
        if ('%' !in value) return value
        val out = ByteArrayOutputStream(value.length)
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c == '%') {
                if (i + 2 >= value.length) return null
                val hi = Character.digit(value[i + 1], 16)
                val lo = Character.digit(value[i + 2], 16)
                if (hi < 0 || lo < 0) return null
                out.write(hi * 16 + lo)
                i += 3
            } else {
                out.write(c.toString().toByteArray(Charsets.UTF_8))
                i++
            }
        }
        val decoder = Charsets.UTF_8.newDecoder()
        return try { decoder.decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString() } catch (_: Exception) { null }
    }
}

/** What to do with a valid link before anything touches the network (spec 10.5). */
sealed class QrStart {
    /** Q5: confirm first. `again` when this host ID was paired before. */
    data class Confirm(val again: Boolean) : QrStart()
    /** Already paired with this certificate and a session: open the dock, no PIN (10.5). */
    data class OpenDock(val computer: Computer) : QrStart()
    /** Q11: a known host ID with a different certificate. Never re-pinned silently. */
    data class Changed(val computer: Computer, val pinned: String) : QrStart()
}

object QrDecision {
    /**
     * `computer` and `pinned` are what this phone saved for the link's host ID; `hasSession`
     * whether the WebView still holds a session for the computer's saved address.
     */
    fun decide(link: PairLink, computer: Computer?, pinned: String?, hasSession: Boolean, now: Long): QrStart {
        if (pinned != null && !Fingerprint.matches(pinned, link.fingerprint)) {
            val shown = computer ?: Computer(hostId = link.hostId, hostName = link.name, endpoint = link.endpoint, addedAt = now)
            return QrStart.Changed(shown, pinned)
        }
        if (computer != null && pinned != null && hasSession && !computer.needsPin) return QrStart.OpenDock(computer)
        return QrStart.Confirm(again = computer != null || pinned != null)
    }

    /** Step 1 or 2 of 10.6 answered: only the scanned host ID behind the scanned certificate counts. */
    fun accepts(link: PairLink, probe: Probe): Boolean =
        probe.hostId == link.hostId && Fingerprint.matches(probe.presented, link.fingerprint) &&
            probe.endpoint.startsWith("https://")
}
