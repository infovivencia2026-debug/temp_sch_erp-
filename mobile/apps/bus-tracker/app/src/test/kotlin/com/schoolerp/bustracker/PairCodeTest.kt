package com.schoolerp.bustracker

import com.schoolerp.bustracker.core.PairCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairCodeTest {

    @Test
    fun `a grouped code typed by a human normalises to eight characters`() {
        assertEquals("ABCD2345", PairCode.normalise("abcd-2345"))
        assertEquals("ABCD2345", PairCode.normalise(" ABCD 2345 "))
    }

    @Test
    fun `letters that look like digits are not folded`() {
        // The contract does not say which alphabet the server draws codes from.
        // Folding O to 0 would turn a valid code into a mysterious failure.
        assertEquals("O0I1LMNP", PairCode.normalise("o0i1lmnp"))
    }

    @Test
    fun `completeness is eight characters, not eight keystrokes`() {
        assertFalse(PairCode.isComplete("ABC-123"))
        assertTrue(PairCode.isComplete("ABC-12345"))
    }
}
