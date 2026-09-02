package com.schoolerp.smsgateway

import com.schoolerp.smsgateway.core.PairCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairCodeTest {

    @Test
    fun `spaces and hyphens from a grouped code are dropped`() {
        assertEquals("ABCD1234", PairCode.normalise("ABCD-1234"))
        assertEquals("ABCD1234", PairCode.normalise("abcd 1234"))
        assertEquals("ABCD1234", PairCode.normalise(" ABCD_1234 "))
    }

    @Test
    fun `letters that look like digits are left alone`() {
        // Folding O to 0 would be friendly right up until the server issues a
        // code containing a genuine O, and then pairing fails for a reason
        // nobody in the office can see.
        assertEquals("O0I1L1AB", PairCode.normalise("o0i1l1ab"))
    }

    @Test
    fun `a code is complete at exactly nine characters`() {
        assertFalse(PairCode.isComplete("ABCD1234"))
        assertTrue(PairCode.isComplete("ABCD12345"))
        assertTrue(PairCode.isComplete("ABCD-12345"))
    }

    @Test
    fun `extra characters are trimmed rather than accepted`() {
        assertEquals(PairCode.LENGTH, PairCode.normalise("ABCD12345EXTRA").length)
    }
}
