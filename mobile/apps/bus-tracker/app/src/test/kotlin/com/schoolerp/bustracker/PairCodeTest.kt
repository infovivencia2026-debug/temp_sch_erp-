package com.schoolerp.bustracker

import com.schoolerp.bustracker.core.PairCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairCodeTest {

    @Test
    fun `a grouped code typed by a human normalises to nine digits`() {
        assertEquals("123456789", PairCode.normalise("123-456-789"))
        assertEquals("123456789", PairCode.normalise(" 123 456 789 "))
    }

    @Test
    fun `letters that look like digits are not folded`() {
        // The contract does not say which alphabet the server draws codes from,
        // and this app has been through two. Folding O to 0 would turn a valid
        // code into a mysterious failure the moment that changed again.
        assertEquals("O0I1LMNP", PairCode.normalise("o0i1lmnp"))
    }

    @Test
    fun `completeness is nine characters, not nine keystrokes`() {
        assertFalse(PairCode.isComplete("123-456"))
        assertTrue(PairCode.isComplete("123-456-789"))
    }
}
