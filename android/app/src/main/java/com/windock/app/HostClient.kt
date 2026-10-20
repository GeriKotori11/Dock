package com.windock.app

import org.json.JSONObject
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URL
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * The phone's native calls to a host: `/health` probes (HTTPS first), `POST /api/auth`
 * and `DELETE /api/session`. Blocking; call from a background thread.
 *
 * Trust: a probe reads only public `/health` data, so its handshake records whichever
 * certificate is presented and TrustDecision compares that fingerprint with the pin
 * afterwards. The calls that carry a secret (the PIN, the session) use a trust manager
 * that accepts exactly the pinned certificate and nothing else.
 */
object HostClient {
    sealed class Result {
        data class Answer(val probe: Probe) : Result()
        data class Failed(val why: ProbeFailure) : Result()
    }

    sealed class Auth {
        data class Paired(val cookie: SessionCookie) : Auth()
        object Wrong : Auth()
        data class Locked(val retryInMs: Long) : Auth()
        object Closed : Auth()
        object Invalid : Auth()
        object Failed : Auth()
    }

    private const val LIMIT = 4096

    /** Probe one endpoint: HTTPS with the presented certificate recorded, else plain http for TLS-less hosts. */
    fun probe(endpoint: String, timeoutMs: Int = 2500): Result {
        val https = EndpointPolicy.withScheme(endpoint, "https") ?: return Result.Failed(ProbeFailure.OTHER)
        var leaf: String? = null
        val recording = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
                throw CertificateException("client certificates are not used")
            // Records only; nothing secret is sent on this connection (see the class comment).
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                leaf = chain?.firstOrNull()?.let { Fingerprint.of(it.encoded) } ?: throw CertificateException("no certificate")
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        try {
            val conn = open(https, "/health", recording) { leaf }
            try {
                conn.connectTimeout = timeoutMs; conn.readTimeout = timeoutMs
                val health = readHealth(conn) ?: return Result.Failed(ProbeFailure.OTHER)
                val presented = leaf ?: return Result.Failed(ProbeFailure.OTHER)
                return Result.Answer(toProbe(https, health, presented))
            } finally { conn.disconnect() }
        } catch (e: Exception) {
            // Connected, but the TLS handshake failed or got no answer: a plain-only port.
            val connectedThenSilent = e is SocketTimeoutException && e.message?.contains("connect", ignoreCase = true) != true
            when (failureOf(e)) {
                ProbeFailure.REFUSED -> return Result.Failed(ProbeFailure.REFUSED)
                ProbeFailure.TIMEOUT -> if (!connectedThenSilent) return Result.Failed(ProbeFailure.TIMEOUT)
                ProbeFailure.OTHER -> if (e !is SSLException) return Result.Failed(ProbeFailure.OTHER)
            }
        }
        // The port answered but not with TLS: a host with WINDOCK_TLS=0 or an old version.
        val plain = EndpointPolicy.withScheme(endpoint, "http") ?: return Result.Failed(ProbeFailure.OTHER)
        return try {
            val conn = URL("$plain/health").openConnection() as HttpURLConnection
            try {
                conn.connectTimeout = timeoutMs; conn.readTimeout = timeoutMs
                val health = readHealth(conn) ?: return Result.Failed(ProbeFailure.OTHER)
                // It says it serves TLS but the handshake failed: never accept that as a TLS-less answer.
                if (health.optJSONObject("tls") != null) Result.Failed(ProbeFailure.OTHER)
                else Result.Answer(toProbe(plain, health, null))
            } finally { conn.disconnect() }
        } catch (e: Exception) { Result.Failed(failureOf(e)) }
    }

    private fun toProbe(endpoint: String, health: JSONObject, presented: String?) = Probe(
        endpoint = endpoint,
        hostId = health.optString("hostId").lowercase().takeIf(PinStore::isHostId),
        hostName = DisplayName.clean(health.optString("hostName"), 255),
        platform = DisplayName.normalizePlatform(health.optString("platform")),
        tlsAdvertised = health.optJSONObject("tls") != null,
        presented = presented,
        pairingOpen = health.optBoolean("pairingOpen", true),
    )

    private fun failureOf(e: Exception): ProbeFailure = when (e) {
        is ConnectException -> ProbeFailure.REFUSED
        is SocketTimeoutException -> ProbeFailure.TIMEOUT
        else -> if (e.cause is ConnectException) ProbeFailure.REFUSED else ProbeFailure.OTHER
    }

    /** `POST /api/auth` with `{ pin, deviceName }` over the pinned connection; no Origin header. */
    fun pair(endpoint: String, pinned: String?, pin: String, deviceName: String): Auth {
        if (!pin.matches(Regex("[0-9]{6}"))) return Auth.Invalid
        return try {
            val conn = connect(endpoint, "/api/auth", pinned) ?: return Auth.Failed
            try {
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                val body = JSONObject().put("pin", pin).put("deviceName", deviceName).toString().toByteArray()
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
                val code = conn.responseCode
                val json = try { readJson(if (code < 400) conn.inputStream else conn.errorStream) } catch (_: Exception) { null }
                when (code) {
                    200 -> SessionCookie.fromHeaders(header(conn, "Set-Cookie"))?.let { Auth.Paired(it) } ?: Auth.Failed
                    401 -> Auth.Wrong
                    429 -> Auth.Locked(json?.optLong("retryInMs", 60_000L)?.coerceIn(1_000L, 3_600_000L) ?: 60_000L)
                    403 -> if (json?.optString("error") == "pairing closed") Auth.Closed else Auth.Failed
                    400 -> Auth.Invalid
                    else -> Auth.Failed
                }
            } finally { conn.disconnect() }
        } catch (_: Exception) { Auth.Failed }
    }

    /** `DELETE /api/session` with this phone's session, so Forget also removes it from the computer. */
    fun forgetSession(endpoint: String, pinned: String?, session: SessionCookie): Boolean = try {
        val conn = connect(endpoint, "/api/session", pinned)
        if (conn == null) false else try {
            conn.requestMethod = "DELETE"
            conn.setRequestProperty("Cookie", session.requestHeader())
            // 401: the computer no longer knows this session, which is what Forget wants.
            conn.responseCode in 200..299 || conn.responseCode == 401
        } finally { conn.disconnect() }
    } catch (_: Exception) { false }

    /** A connection that carries a secret: https accepts only the pinned certificate; http only when nothing is pinned. */
    private fun connect(endpoint: String, path: String, pinned: String?): HttpURLConnection? {
        val normalized = EndpointPolicy.normalize(endpoint) ?: return null
        val conn: HttpURLConnection = if (normalized.startsWith("https://")) {
            if (!Fingerprint.isValid(pinned)) return null
            var leaf: String? = null
            val strict = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
                    throw CertificateException("client certificates are not used")
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                    val presented = chain?.firstOrNull()?.let { Fingerprint.of(it.encoded) } ?: throw CertificateException("no certificate")
                    if (presented != pinned) throw CertificateException("certificate changed")
                    leaf = presented
                }
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            }
            open(normalized, path, strict) { leaf }
        } else {
            if (pinned != null) return null
            URL("$normalized$path").openConnection() as HttpURLConnection
        }
        conn.connectTimeout = 4000
        conn.readTimeout = 6000
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        return conn
    }

    /** An https connection whose trust manager is installed on this connection only. */
    private fun open(https: String, path: String, trust: X509TrustManager, leaf: () -> String?): HttpsURLConnection {
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), null) }
        val endpoint = URI(https)
        val conn = URL("$https$path").openConnection() as HttpsURLConnection
        conn.sslSocketFactory = context.socketFactory
        // The certificate is self-signed for a LAN IP: the name check is the fingerprint check.
        conn.hostnameVerifier = HostnameVerifier { host, session ->
            val peer = session.peerCertificates.firstOrNull() as? X509Certificate
            host == endpoint.host && peer != null && leaf() != null && Fingerprint.of(peer.encoded) == leaf()
        }
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        return conn
    }

    private fun header(conn: HttpURLConnection, name: String): List<String> =
        conn.headerFields.entries.filter { it.key != null && it.key.equals(name, ignoreCase = true) }.flatMap { it.value }

    private fun readHealth(conn: HttpURLConnection): JSONObject? {
        conn.instanceFollowRedirects = false
        conn.requestMethod = "GET"
        if (conn.responseCode != 200) return null
        return readJson(conn.inputStream)?.takeIf { it.optString("app") == "windock" }
    }

    private fun readJson(stream: java.io.InputStream?): JSONObject? {
        stream ?: return null
        return stream.bufferedReader().use { reader ->
            val body = CharArray(LIMIT + 1)
            var count = 0
            while (count < body.size) {
                val read = reader.read(body, count, body.size - count)
                if (read == -1) break
                count += read
            }
            if (count > LIMIT) null else JSONObject(String(body, 0, count))
        }
    }
}
