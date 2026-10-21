package com.windock.app

import org.junit.Assert.*
import org.junit.Test

class LargeTextTest {
    @Test fun twoColumnsUpToAFontScaleOf1Point3() {
        assertFalse(LargeText.stacks(1.0f))
        assertFalse(LargeText.stacks(1.15f))
        assertFalse(LargeText.stacks(1.3f))
    }

    @Test fun oneScrollingColumnAbove1Point3() {
        assertTrue(LargeText.stacks(1.5f))
        assertTrue(LargeText.stacks(2.0f))
    }
}
