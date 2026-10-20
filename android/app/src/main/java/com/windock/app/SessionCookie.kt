package com.windock.app

/**
 * The host's session cookie (PROTOCOL.md "Session"): parsing the `Set-Cookie` that
 * `POST /api/auth` returns and writing it back in the form the WebView cookie store
 * accepts, keeping HttpOnly, Secure, SameSite, Path and Max-Age. Pure; the store
 * itself is only touched by SessionCookies.
 */
data class SessionCookie(
    val value: String,
    val path: String = "/",
    val maxAgeSeconds: Long? = DEFAULT_MAX_AGE,
    val httpOnly: Boolean = true,
    val secure: Boolean = false,
    val sameSite: String? = "Lax",
) {
    /** A `Set-Cookie`-style string for CookieManager.setCookie. Host-only: never a Domain. */
    fun format(): String = buildString {
        append(NAME).append('=').append(value)
        append("; Path=").append(path)
        maxAgeSeconds?.let { append("; Max-Age=").append(it) }
        if (httpOnly) append("; HttpOnly")
        if (secure) append("; Secure")
        sameSite?.let { append("; SameSite=").append(it) }
    }

    /** The request header a native call sends (`DELETE /api/session`). */
    fun requestHeader(): String = "$NAME=$value"

    companion object {
        const val NAME = "windock_session"
        const val DEFAULT_MAX_AGE = 15_552_000L
        private val VALUE = Regex("[\\x21\\x23-\\x2B\\x2D-\\x3A\\x3C-\\x5B\\x5D-\\x7E]{1,4096}")
        private val PATH = Regex("/[\\x21-\\x3A\\x3C-\\x7E]{0,255}")

        fun validValue(value: String?): Boolean = value != null && VALUE.matches(value)

        /** Parses one `Set-Cookie` header; null unless it is a well-formed windock_session. */
        fun parse(header: String?): SessionCookie? {
            if (header == null || header.length > 8192) return null
            val parts = header.split(';').map { it.trim() }
            val pair = parts.firstOrNull() ?: return null
            val eq = pair.indexOf('=')
            if (eq <= 0 || pair.substring(0, eq).trim() != NAME) return null
            val value = pair.substring(eq + 1).trim().removeSurrounding("\"")
            if (!validValue(value)) return null
            var cookie = SessionCookie(value, path = "/", maxAgeSeconds = null, httpOnly = false, secure = false, sameSite = null)
            for (attr in parts.drop(1)) {
                if (attr.isEmpty()) continue
                val i = attr.indexOf('=')
                val key = (if (i < 0) attr else attr.substring(0, i)).trim().lowercase()
                val v = if (i < 0) "" else attr.substring(i + 1).trim()
                cookie = when (key) {
                    "path" -> if (PATH.matches(v)) cookie.copy(path = v) else cookie
                    "max-age" -> v.toLongOrNull()?.let { cookie.copy(maxAgeSeconds = it.coerceIn(0, 400L * 24 * 3600)) } ?: cookie
                    "httponly" -> cookie.copy(httpOnly = true)
                    "secure" -> cookie.copy(secure = true)
                    "samesite" -> when (v.lowercase()) {
                        "lax" -> cookie.copy(sameSite = "Lax"); "strict" -> cookie.copy(sameSite = "Strict")
                        "none" -> cookie.copy(sameSite = "None"); else -> cookie
                    }
                    else -> cookie // Domain and Expires are dropped: the cookie stays host-only.
                }
            }
            return cookie
        }

        /** The first `windock_session` Set-Cookie among a response's headers. */
        fun fromHeaders(values: List<String>?): SessionCookie? = values.orEmpty().firstNotNullOfOrNull { parse(it) }

        /**
         * The session found in the store's `name=value; name=value` string for an origin.
         * The store does not return attributes, so they are rebuilt as the host sets them.
         */
        fun fromJar(jar: String?, secure: Boolean): SessionCookie? {
            val value = jar.orEmpty().split(';').map { it.trim() }
                .firstOrNull { it.startsWith("$NAME=") }?.substringAfter('=')?.trim() ?: return null
            if (!validValue(value)) return null
            return SessionCookie(value, secure = secure)
        }

        /** Removes the session for an origin. */
        fun expired(secure: Boolean): String =
            "$NAME=; Path=/; Max-Age=0; HttpOnly" + (if (secure) "; Secure" else "") + "; SameSite=Lax"
    }
}
