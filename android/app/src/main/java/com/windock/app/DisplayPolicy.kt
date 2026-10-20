package com.windock.app

/** Idle dimming only: the screen itself stays on while WinDock is open. Zero never dims. */
data class DisplayPolicy(val dimAfterMs: Long = 30_000, val dimPercent: Int = 10) {
    enum class Stage { AWAKE, DIMMED }

    fun stage(elapsedMs: Long): Stage =
        if (dimAfterMs > 0 && elapsedMs >= dimAfterMs) Stage.DIMMED else Stage.AWAKE

    fun nextDeadline(elapsedMs: Long): Long? = dimAfterMs.takeIf { it > 0 && it > elapsedMs }

    companion object {
        val DIM_TIMES = listOf(0L, 15_000L, 30_000L, 60_000L, 120_000L)
        val DIM_LEVELS = listOf(5, 10, 20)
    }
}
