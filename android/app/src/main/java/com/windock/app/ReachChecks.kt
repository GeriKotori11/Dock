package com.windock.app

/** S8 "Can't reach" checks, ordered by what the phone can actually detect (spec 4.10, 5.8). */
object ReachChecks {
    enum class Check { SUBNET, RUNNING, ISOLATION, FIREWALL }

    data class Result(val checks: List<Check>, val likely: Check?, val phoneIp: String?)

    fun diagnose(networks: List<LocalNetwork>, hostIp: String?, failure: ProbeFailure?,
                 discoverySawAny: Boolean, platform: String): Result {
        val mac = DisplayName.normalizePlatform(platform) == "macos"
        val phone = networks.firstOrNull { !it.wired } ?: networks.firstOrNull()
        val mismatch = hostIp != null && networks.isNotEmpty() && networks.none { it.contains(hostIp) }
        val likely = when {
            mismatch -> Check.SUBNET
            failure == ProbeFailure.REFUSED -> Check.RUNNING
            failure == ProbeFailure.TIMEOUT && !discoverySawAny -> Check.ISOLATION
            else -> null
        }
        val order = buildList {
            likely?.let(::add)
            add(Check.RUNNING)
            if (mac) add(Check.FIREWALL)
            add(Check.ISOLATION)
        }.distinct().take(3)
        return Result(order, likely, phone?.address)
    }
}
