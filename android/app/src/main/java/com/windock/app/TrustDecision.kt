package com.windock.app

import java.net.URI

/**
 * What one /health probe learned. `presented` is the leaf certificate fingerprint the
 * TLS handshake actually presented (null for a plain-http answer); `/health.tls` is
 * only a hint (`tlsAdvertised`).
 */
data class Probe(
    val endpoint: String,
    val hostId: String?,
    val hostName: String,
    val platform: String,
    val tlsAdvertised: Boolean,
    val presented: String?,
    val pairingOpen: Boolean,
    /** `/health.hostUi`: the host has its own control page, so copy says "Pair a new phone". */
    val hostUi: Boolean = false,
)

/** How a probe failed, for the Can't reach diagnosis (spec 4.10). */
enum class ProbeFailure { REFUSED, TIMEOUT, OTHER }

sealed class Verdict {
    /** Pin matches (or a legacy plain host at its own address): open the dock. */
    data class Open(val computer: Computer, val endpoint: String, val moved: Boolean) : Verdict()
    /** A host ID seen before presents a different certificate: S10, never a prompt. */
    data class Mismatch(val computer: Computer, val pinned: String?, val presented: String?) : Verdict()
    /**
     * Pairing is needed. `computer` is the saved record when the host ID is known (its pin
     * was forgotten); `pinChecked` means the presented certificate already matches the pin,
     * so pairing starts at the PIN step.
     */
    data class Pair(val probe: Probe, val computer: Computer?, val pinChecked: Boolean) : Verdict()
    /** Something answered, but it is another computer. */
    object Elsewhere : Verdict()
    /** It answered but cannot be verified (no host ID, or TLS advertised but not served). */
    object Unusable : Verdict()
}

/**
 * Identity is the host ID plus its pinned certificate, never an address. A known host ID
 * with a different certificate is always S10; an unknown host ID is always pairing,
 * even at an address a saved computer used to have.
 */
object TrustDecision {
    fun sameOrigin(a: String?, b: String?): Boolean =
        EndpointPolicy.normalize(a) != null && EndpointPolicy.normalize(a) == EndpointPolicy.normalize(b)

    fun sameHost(a: String?, b: String?): Boolean {
        val x = EndpointPolicy.normalize(a) ?: return false
        val y = EndpointPolicy.normalize(b) ?: return false
        return try { URI(x).host == URI(y).host && URI(x).port == URI(y).port } catch (_: Exception) { false }
    }

    /** Opening a saved computer: the probe came from its saved endpoint or from discovery. */
    fun forComputer(computer: Computer, pinned: String?, probe: Probe): Verdict {
        if (probe.hostId != computer.hostId) return Verdict.Elsewhere
        if (pinned != null) {
            val presented = probe.presented
            return when {
                // A trusted host that stopped serving TLS no longer proves its identity.
                presented == null -> Verdict.Mismatch(computer, pinned, null)
                presented == pinned -> Verdict.Open(computer, probe.endpoint, !sameHost(probe.endpoint, computer.endpoint))
                else -> Verdict.Mismatch(computer, pinned, presented)
            }
        }
        if (probe.presented != null) return Verdict.Pair(probe, computer, pinChecked = false)
        if (probe.tlsAdvertised) return Verdict.Unusable
        // Legacy plain-http host (no TLS, nothing pinned): only where it was paired. A plain
        // host ID claimed at another address proves nothing, so that asks for the PIN again.
        return if (sameOrigin(probe.endpoint, computer.endpoint)) Verdict.Open(computer, probe.endpoint, false)
        else Verdict.Pair(probe, computer, pinChecked = false)
    }

    /** Something answered at an address (Add by address, a discovered row): look up by host ID only. */
    fun forAddress(probe: Probe, computer: (String) -> Computer?, pin: (String) -> String?, now: Long): Verdict {
        val hostId = probe.hostId?.takeIf(PinStore::isHostId) ?: return Verdict.Unusable
        computer(hostId)?.let { return forComputer(it, pin(hostId), probe) }
        val pinned = pin(hostId)
        val transient = Computer(hostId = hostId, hostName = probe.hostName, platform = probe.platform,
            endpoint = probe.endpoint, addedAt = now)
        if (pinned != null) return when (probe.presented) {
            pinned -> Verdict.Pair(probe, null, pinChecked = true)
            else -> Verdict.Mismatch(transient, pinned, probe.presented)
        }
        if (probe.presented != null) return Verdict.Pair(probe, null, pinChecked = false)
        if (probe.tlsAdvertised) return Verdict.Unusable
        return Verdict.Pair(probe, null, pinChecked = false)
    }
}
