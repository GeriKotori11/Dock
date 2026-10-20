package com.windock.app

import java.net.URI

/**
 * A paired computer (spec section 12). The host ID is the identity; the endpoint is only
 * where it answered last with the pinned certificate. No secrets: the pin stays in
 * PinStore and the session lives in the WebView's own store.
 */
data class Computer(
    val hostId: String,
    val hostName: String,
    val nickname: String? = null,
    val platform: String = "",
    val endpoint: String,
    val lastConnectedAt: Long? = null,
    val addedAt: Long,
    /** Phone-side note that the computer revoked this phone and a new PIN is needed. */
    val needsPin: Boolean = false,
) {
    val displayName: String get() = DisplayName.of(nickname, hostName, endpoint)
    val address: String get() = DisplayName.hostOf(endpoint)
    val secure: Boolean get() = endpoint.startsWith("https://")
}

object DisplayName {
    const val NICKNAME_MAX = 40
    const val NAME_MAX = 60
    private val CONTROL = Regex("[\\p{Cc}\\p{Cf}]")

    fun clean(value: String?, max: Int): String =
        value.orEmpty().replace(CONTROL, "").trim().take(max).trim()

    /** nickname ?? host name without a trailing `.local`, max 60; the address when both are empty. */
    fun of(nickname: String?, hostName: String, endpoint: String? = null): String {
        clean(nickname, NICKNAME_MAX).takeIf { it.isNotEmpty() }?.let { return it }
        val host = clean(hostName, 255).let { if (it.endsWith(".local", ignoreCase = true)) it.dropLast(6) else it }
            .trim().take(NAME_MAX).trim()
        return host.ifEmpty { hostOf(endpoint) }
    }

    /** A rename: empty restores the computer's own name. */
    fun nickname(input: String?): String? = clean(input, NICKNAME_MAX).takeIf { it.isNotEmpty() }

    fun hostOf(endpoint: String?): String = try { URI(endpoint ?: "").host.orEmpty() } catch (_: Exception) { "" }

    fun platformLabel(platform: String?): String = when (platform?.lowercase()) {
        "windows" -> "Windows"
        "macos", "darwin", "mac" -> "macOS"
        "linux" -> "Linux"
        else -> ""
    }

    fun normalizePlatform(platform: String?): String = when (platform?.lowercase()) {
        "windows", "win32" -> "windows"
        "macos", "darwin", "mac" -> "macos"
        "linux" -> "linux"
        else -> ""
    }
}

object ComputerCodec {
    fun encode(list: List<Computer>): String = MiniJson.write(mapOf("v" to 1L, "computers" to list.map { c ->
        linkedMapOf<String, Any?>(
            "hostId" to c.hostId, "hostName" to c.hostName, "nickname" to c.nickname,
            "platform" to c.platform, "endpoint" to c.endpoint,
            "lastConnectedAt" to c.lastConnectedAt, "addedAt" to c.addedAt, "needsPin" to c.needsPin,
        )
    }))

    /** Malformed entries are dropped one by one; a malformed document reads as empty. */
    fun decode(text: String?): List<Computer> {
        if (text.isNullOrBlank()) return emptyList()
        val root = try { MiniJson.parse(text) as? Map<*, *> } catch (_: Exception) { null } ?: return emptyList()
        val items = root["computers"] as? List<*> ?: return emptyList()
        return items.mapNotNull { item ->
            val m = item as? Map<*, *> ?: return@mapNotNull null
            val hostId = (m["hostId"] as? String)?.takeIf(PinStore::isHostId) ?: return@mapNotNull null
            val endpoint = (m["endpoint"] as? String)?.let { EndpointPolicy.normalize(it) } ?: return@mapNotNull null
            Computer(
                hostId = hostId,
                hostName = DisplayName.clean(m["hostName"] as? String, 255),
                nickname = DisplayName.nickname(m["nickname"] as? String),
                platform = DisplayName.normalizePlatform(m["platform"] as? String),
                endpoint = endpoint,
                lastConnectedAt = (m["lastConnectedAt"] as? Number)?.toLong(),
                addedAt = (m["addedAt"] as? Number)?.toLong() ?: 0L,
                needsPin = m["needsPin"] == true,
            )
        }.distinctBy { it.hostId }
    }
}
