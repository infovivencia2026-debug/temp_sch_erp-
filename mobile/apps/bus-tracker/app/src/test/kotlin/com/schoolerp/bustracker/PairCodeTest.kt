package com.schoolerp.bustracker

import com.schoolerp.bustracker.core.PairCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairCodeTest {

    @Test
    fun `a grouped code typed by a human normalises to six digits`() {
        assertEquals("123456", PairCode.normalise("123-456"))
        assertEquals("123456", PairCode.normalise(" 123 456 "))
    }

    @Test
    fun `letters that look like digits are not folded`() {
        // The contract does not say which alphabet the server draws codes from,
        // and this app has been through two. Folding O to 0 would turn a valid
        // code into a mysterious failure the moment that changed again.
        assertEquals("O0I1LM", PairCode.normalise("o0i1lm"))
    }

    @Test
    fun `completeness is six characters, not six keystrokes`() {
        assertFalse(PairCode.isComplete("123-45"))
        assertTrue(PairCode.isComplete("123-456"))
    }
}
