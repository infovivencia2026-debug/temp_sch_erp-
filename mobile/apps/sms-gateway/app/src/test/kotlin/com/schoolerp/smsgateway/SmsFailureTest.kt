package com.schoolerp.smsgateway

import android.app.Activity
import com.schoolerp.smsgateway.sms.SmsFailure
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SmsFailureTest {

    @Test
    fun `RESULT_OK is not a failure`() {
        assertNull(SmsFailure.reasonFor(Activity.RESULT_OK))
    }

    @Test
    fun `the codes a school actually hits are named`() {
        assertEquals("generic_failure", SmsFailure.reasonFor(1))
        assertEquals("radio_off", SmsFailure.reasonFor(2))
        assertEquals("no_service", SmsFailure.reasonFor(4))
        assertEquals("limit_exceeded", SmsFailure.reasonFor(5))
    }

    @Test
    fun `an unknown code is reported rather than swallowed`() {
        // Reporting `failed` with an opaque code beats reporting `sent`.
        assertEquals("result_999", SmsFailure.reasonFor(999))
        assertNotNull(SmsFailure.explain("result_999"))
    }

    @Test
    fun `carrier throttling is explained in words an office understands`() {
        val explanation = SmsFailure.explain("limit_exceeded")
        assertTrue(explanation.contains("throttling"))
        assertTrue(explanation.contains("SIM"))
    }

    @Test
    fun `a lost send result is described honestly`() {
        val explanation = SmsFailure.explain(SmsFailure.NO_RESULT)
        assertTrue(explanation.contains("may or may not"))
    }

    @Test
    fun `every named reason has a human explanation`() {
        val reasons = (1..32).mapNotNull { SmsFailure.reasonFor(it) }
        reasons.forEach { assertTrue(it, SmsFailure.explain(it).isNotBlank()) }
    }
}
