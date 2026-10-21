package com.windock.app

/**
 * "Forget and pair again" on the security-changed screen (S10), decided without Android.
 *
 * S10 is reached only from [Verdict.Mismatch]: the computer answered with a certificate
 * other than the pinned one, or over plain http while one is pinned. The phone's old
 * session belongs to the old identity, and the only connection allowed to carry it is one
 * that presents the pinned certificate ([HostClient] refuses anything else). So the
 * phone cannot authenticate `DELETE /api/session` here: no connection would be accepted,
 * and sending the session to an unverified certificate would hand it to whoever answered.
 * There is no S10 case in which the old identity is still reachable.
 *
 * The forget is therefore phone-side only: the pin and the WebView session cookie go,
 * pairing starts again at step 1, and the old session on the computer expires on its
 * own or is revoked from the computer's paired-phones page.
 */
object ChangedForget {
    data class Plan(
        /** Never true on S10: see the object comment. */
        val deleteOnHost: Boolean,
        /** Endpoints whose host's session cookie must be removed from the WebView. */
        val clearCookies: List<String>,
    )

    /**
     * @param computer the computer whose identity changed
     * @param at where the changed certificate answered (may be a new address)
     * @param others the other saved computers; a host they share keeps its cookie, since
     *   cookies are stored per host, not per port
     */
    fun plan(computer: Computer, at: String, others: List<Computer>): Plan {
        val kept = others.filter { it.hostId != computer.hostId }.map { it.address }.toSet()
        val clear = listOf(computer.endpoint, at)
            .filter { EndpointPolicy.normalize(it) != null }
            .distinctBy { DisplayName.hostOf(it) }
            .filter { DisplayName.hostOf(it).isNotEmpty() && DisplayName.hostOf(it) !in kept }
        return Plan(deleteOnHost = false, clearCookies = clear)
    }
}
