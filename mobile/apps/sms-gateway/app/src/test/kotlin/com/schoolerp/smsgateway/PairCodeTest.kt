package com.schoolerp.smsgateway

import com.schoolerp.smsgateway.core.PairCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/* Written against PairCode.LENGTH rather than a literal. The code has been
   eight, nine and six characters long in the space of a week, and each change
   left this test asserting the previous length. */
class PairCodeTest {

    private val full = "ABCD1234EFGH".take(PairCode.LENGTH)
    private val grouped = full.chunked(3).joinToString("-")

    @Test
    fun `spaces and hyphens from a grouped code are dropped`() {
        assertEquals(full, PairCode.normalise(grouped))
        assertEquals(full, PairCode.normalise(full.lowercase().chunked(2).joinToString(" ")))
        assertEquals(full, PairCode.normalise(" ${full.replace("1", "_1")} "))
    }

    @Test
    fun `letters that look like digits are left alone`() {
        // Folding O to 0 would be friendly right up until the server issues a
        // code containing a genuine O, and then pairing fails for a reason
        // nobody in the office can see.
        val lookalikes = "O0I1L1OI".take(PairCode.LENGTH)
        assertEquals(lookalikes, PairCode.normalise(lookalikes.lowercase()))
    }

    @Test
    fun `a code is complete at exactly LENGTH characters`() {
        assertFalse(PairCode.isComplete(full.dropLast(1)))
        assertTrue(PairCode.isComplete(full))
        assertTrue(PairCode.isComplete(grouped))
    }

    @Test
    fun `extra characters are trimmed rather than accepted`() {
        assertEquals(PairCode.LENGTH, PairCode.normalise(full + "EXTRA").length)
    }
}
