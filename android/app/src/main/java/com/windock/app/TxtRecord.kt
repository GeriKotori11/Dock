package com.windock.app

/**
 * Bonjour `_windock._tcp` TXT hints (PROTOCOL.md): `id, api, tls, addr, name, os`.
 * Anyone on the LAN can advertise anything, so these only choose where to probe and
 * what to show before the probe; the pinned HTTPS /health decides everything else.
 */
data class TxtRecord(
    val hostId: String? = null,
    val name: String? = null,
    val os: String = "",
    val addr: String? = null,
    val api: Int? = null,
    val tls: Boolean? = null,
) {
    /** Where to probe: the advertised `addr` when it is a local IPv4, else the resolved host. */
    fun endpoint(resolvedHost: String?, port: Int): String? {
        if (port !in 1..65535) return null
        val host = listOfNotNull(addr, resolvedHost?.removePrefix("/"))
            .firstOrNull { EndpointPolicy.normalize("$it:$port") != null } ?: return null
        return EndpointPolicy.normalize("http://$host:$port")
    }

    companion object {
        private val CONTROL = Regex("[\\p{Cc}\\p{Cf}]")

        fun parse(attributes: Map<String, ByteArray?>?): TxtRecord {
            val values = attributes.orEmpty().entries.associate { (k, v) ->
                k.lowercase() to v?.let { String(it, Charsets.UTF_8).replace(CONTROL, "").trim() }
            }
            fun text(key: String, max: Int) = values[key]?.take(max)?.takeIf { it.isNotEmpty() }
            return TxtRecord(
                hostId = text("id", 64)?.lowercase()?.takeIf(PinStore::isHostId),
                name = text("name", 255)?.let { DisplayName.clean(it, DisplayName.NAME_MAX) }?.takeIf { it.isNotEmpty() },
                os = DisplayName.normalizePlatform(text("os", 16)),
                addr = text("addr", 15)?.takeIf { EndpointPolicy.normalize(it) != null && !it.equals("localhost", true) },
                api = text("api", 4)?.toIntOrNull(),
                tls = when (text("tls", 1)) { "1" -> true; "0" -> false; else -> null },
            )
        }
    }
}
