package com.schoolerp.smsgateway

import com.schoolerp.smsgateway.core.MessageBody
import com.schoolerp.smsgateway.data.local.MessageEntity
import com.schoolerp.smsgateway.data.remote.OutboxMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one rule this app cannot get wrong: a body must not be reachable through
 * a `toString`. These are the paths by which it would otherwise reach logcat,
 * a crash report, or an exception message.
 */
class RedactionTest {

    private val secret = "Dear parent, Aarav's fee of Rs 12,500 is overdue."

    @Test
    fun `MessageBody toString does not contain the text`() {
        val body = MessageBody(secret)
        assertFalse(body.toString().contains("Aarav"))
        assertFalse(body.toString().contains("12,500"))
        assertTrue(body.toString().contains("redacted"))
        assertEquals(secret, body.expose())
    }

    @Test
    fun `string interpolation of a body is redacted`() {
        val body = MessageBody(secret)
        assertFalse("sending $body".contains("Aarav"))
    }

    @Test
    fun `the Room entity toString does not contain the text`() {
        val row = MessageEntity(
            id = "m-1",
            toAddress = "+919812345678",
            bodyRaw = secret,
            claimedAt = 0L,
        )
        assertFalse(row.toString().contains("Aarav"))
        assertTrue(row.toString().contains("bodyLength=${secret.length}"))
    }

    @Test
    fun `the wire DTO toString contains neither body nor recipient`() {
        val message = OutboxMessage(id = "m-1", to = "+919812345678", body = MessageBody(secret))
        assertFalse(message.toString().contains("Aarav"))
        assertFalse(message.toString().contains("919812345678"))
        assertTrue(message.toString().contains("m-1"))
    }
}
