package com.windock.app

import org.junit.Assert.*
import org.junit.Test

class DisplayPolicyTest {
    @Test fun dimsAfterIdleAndNeverRests() {
        val policy = DisplayPolicy(15_000, 10)
        assertEquals(DisplayPolicy.Stage.AWAKE, policy.stage(14_999))
        assertEquals(DisplayPolicy.Stage.DIMMED, policy.stage(15_000))
        assertEquals(DisplayPolicy.Stage.DIMMED, policy.stage(Long.MAX_VALUE))
        assertEquals(15_000L, policy.nextDeadline(0))
        assertNull(policy.nextDeadline(15_000))
        assertEquals(listOf(DisplayPolicy.Stage.AWAKE, DisplayPolicy.Stage.DIMMED), DisplayPolicy.Stage.values().toList())
    }

    @Test fun neverDimStaysAwakeWithNoDeadline() {
        val never = DisplayPolicy(0)
        assertEquals(DisplayPolicy.Stage.AWAKE, never.stage(Long.MAX_VALUE))
        assertNull(never.nextDeadline(0))
    }

    @Test fun defaultsAreUnchanged() {
        assertEquals(DisplayPolicy(30_000, 10), DisplayPolicy())
        assertTrue(DisplayPolicy().dimAfterMs in DisplayPolicy.DIM_TIMES)
        assertTrue(DisplayPolicy().dimPercent in DisplayPolicy.DIM_LEVELS)
    }
}
