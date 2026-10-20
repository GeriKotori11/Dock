package com.windock.app

import android.webkit.CookieManager

/**
 * The only place that touches the WebView cookie store (verify-android.mjs enforces it).
 * The session cookie is HttpOnly and host-scoped; native code moves it only between a
 * computer's own origins (pairing, a verified new address, forget).
 */
object SessionCookies {
    private val store: CookieManager get() = CookieManager.getInstance()

    /** After `POST /api/auth`: hand the session to the WebView, then persist it. */
    fun install(endpoint: String, cookie: SessionCookie, done: (Boolean) -> Unit) {
        val origin = EndpointPolicy.normalize(endpoint) ?: return done(false)
        store.setAcceptCookie(true)
        store.setCookie(origin, cookie.format()) { ok ->
            store.flush()
            done(ok)
        }
    }

    fun current(endpoint: String): SessionCookie? {
        val origin = EndpointPolicy.normalize(endpoint) ?: return null
        return SessionCookie.fromJar(store.getCookie(origin), secure = origin.startsWith("https://"))
    }

    fun has(endpoint: String): Boolean = current(endpoint) != null

    /**
     * The computer answered at a new address with its pinned certificate: move its session
     * there and remove it from the old address, which may now belong to another device.
     */
    fun migrate(from: String, to: String, done: () -> Unit) {
        val target = EndpointPolicy.normalize(to)
        val cookie = current(from)
        if (target == null || cookie == null || DisplayName.hostOf(from) == DisplayName.hostOf(to)) return done()
        store.setCookie(target, cookie.copy(secure = target.startsWith("https://")).format()) {
            remove(from)
            done()
        }
    }

    /** Removes the session for an endpoint's host (both schemes; a Secure cookie needs https). */
    fun remove(endpoint: String) {
        for (scheme in listOf("https", "http")) {
            val origin = EndpointPolicy.withScheme(endpoint, scheme) ?: continue
            store.setCookie(origin, SessionCookie.expired(secure = scheme == "https"))
        }
        store.flush()
    }

    fun flush() = store.flush()
}
