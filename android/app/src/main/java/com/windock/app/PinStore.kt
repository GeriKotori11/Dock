package com.windock.app

import android.content.Context

/**
 * Host ID -> pinned certificate fingerprint (trust on first use). Fingerprints
 * are public, so plain SharedPreferences is enough; malformed entries read as
 * "not pinned" and are never written.
 */
object PinStore {
    private const val PREFS = "pins"
    private val HOST_ID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

    fun isHostId(value: String?): Boolean = value != null && HOST_ID.matches(value)

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun get(context: Context, hostId: String?): String? {
        if (!isHostId(hostId)) return null
        return prefs(context).getString(hostId, null)?.takeIf { Fingerprint.isValid(it) }
    }

    fun save(context: Context, hostId: String, fingerprint: String): Boolean {
        if (!isHostId(hostId) || !Fingerprint.isValid(fingerprint)) return false
        return prefs(context).edit().putString(hostId, fingerprint).commit()
    }

    fun remove(context: Context, hostId: String) {
        if (isHostId(hostId)) prefs(context).edit().remove(hostId).commit()
    }
}
