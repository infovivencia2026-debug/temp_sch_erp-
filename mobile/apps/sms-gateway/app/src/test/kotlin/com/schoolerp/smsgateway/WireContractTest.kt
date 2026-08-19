package com.schoolerp.smsgateway

import com.schoolerp.smsgateway.core.MessageBody
import com.schoolerp.smsgateway.core.MessageBodySerializer
import com.schoolerp.smsgateway.data.remote.ClaimRequest
import com.schoolerp.smsgateway.data.remote.ClaimResponse
import com.schoolerp.smsgateway.data.remote.HeartbeatRequest
import com.schoolerp.smsgateway.data.remote.HeartbeatResponse
import com.schoolerp.smsgateway.data.remote.OutboxResponse
import com.schoolerp.smsgateway.data.remote.Receipt
import com.schoolerp.smsgateway.data.remote.ReceiptsRequest
import com.schoolerp.smsgateway.data.remote.ReceiptsResponse
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * These are the shapes in `docs/SMS_GATEWAY_CONTRACT.md`, written out by hand.
 *
 * The server half is built by someone else against the same document, so a
 * field name drifting on either side is the most likely way this app breaks —
 * and the least visible, because a missing field just deserialises to a
 * default. These tests fail loudly instead.
 */
class WireContractTest {

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

    @Test
    fun `claim response parses with institution as an object`() {
        val body = """
            {"device_id":"dev_7","device_token":"tok_abc","institution":{"id":"inst_1","name":"Vivencia High"},"poll_seconds":30}
        """.trimIndent()

        val response = json.decodeFromString<ClaimResponse>(body)

        assertEquals("dev_7", response.deviceId)
        assertEquals("tok_abc", response.deviceToken)
        assertEquals("inst_1", response.institution.id)
        assertEquals("Vivencia High", response.institution.name)
        assertEquals(30, response.pollSeconds)
    }

    @Test
    fun `claim response parses with institution as a bare name`() {
        // The contract does not fix the shape, so both readings must work
        // rather than pairing failing on a field mismatch in an office.
        val body = """{"device_id":"dev_7","device_token":"tok_abc","institution":"Vivencia High"}"""

        val response = json.decodeFromString<ClaimResponse>(body)

        assertEquals("Vivencia High", response.institution.name)
        assertNull(response.institution.id)
    }

    @Test
    fun `the token never appears in a claim response toString`() {
        val response = json.decodeFromString<ClaimResponse>(
            """{"device_id":"dev_7","device_token":"tok_secret","institution":"X"}""",
        )
        assertTrue(!response.toString().contains("tok_secret"))
    }

    @Test
    fun `claim request uses the contract's field names`() {
        val encoded = json.encodeToString(
            ClaimRequest("ABCD1234", "Redmi 9A", "Android 12 (API 31)", "Jio"),
        )
        assertTrue(encoded.contains("\"pair_code\""))
        assertTrue(encoded.contains("\"device_name\""))
        assertTrue(encoded.contains("\"android_version\""))
        assertTrue(encoded.contains("\"sim_operator\""))
    }

    @Test
    fun `outbox response parses`() {
        val body = """
            {"messages":[{"id":"m1","to":"+919812345678","body":"Fees due","attempt":1}],"poll_seconds":45}
        """.trimIndent()

        val response = json.decodeFromString<OutboxResponse>(body)

        assertEquals(1, response.messages.size)
        assertEquals("m1", response.messages[0].id)
        assertEquals("Fees due", response.messages[0].body.expose())
        assertEquals(1, response.messages[0].attempt)
        assertEquals(45, response.pollSeconds)
    }

    @Test
    fun `an empty outbox parses`() {
        val response = json.decodeFromString<OutboxResponse>("""{"messages":[],"poll_seconds":30}""")
        assertTrue(response.messages.isEmpty())
    }

    @Test
    fun `an outbox message with no attempt field defaults rather than throwing`() {
        val response = json.decodeFromString<OutboxResponse>(
            """{"messages":[{"id":"m1","to":"+919812345678","body":"Hi"}]}""",
        )
        assertEquals(0, response.messages[0].attempt)
    }

    @Test
    fun `receipts request uses the contract's field names`() {
        val encoded = json.encodeToString(
            ReceiptsRequest(
                listOf(
                    Receipt("m1", Receipt.STATUS_SENT, "2026-08-19T10:15:00+05:30", null, 2),
                    Receipt("m2", Receipt.STATUS_FAILED, "2026-08-19T10:16:00+05:30", "no_service", 1),
                ),
            ),
        )
        assertTrue(encoded.contains("\"receipts\""))
        assertTrue(encoded.contains("\"sent_at\""))
        assertTrue(encoded.contains("\"status\":\"sent\""))
        assertTrue(encoded.contains("\"status\":\"failed\""))
        assertTrue(encoded.contains("\"error\":\"no_service\""))
        assertTrue(encoded.contains("\"parts\":2"))
    }

    @Test
    fun `a nulled error is omitted rather than sent as null`() {
        val encoded = json.encodeToString(
            ReceiptsRequest(listOf(Receipt("m1", Receipt.STATUS_SENT, "2026-08-19T10:15:00+05:30"))),
        )
        assertTrue(!encoded.contains("\"error\""))
    }

    @Test
    fun `receipts response parses`() {
        assertEquals(3, json.decodeFromString<ReceiptsResponse>("""{"accepted":3}""").accepted)
    }

    @Test
    fun `heartbeat request uses the contract's field names`() {
        val encoded = json.encodeToString(
            HeartbeatRequest(72, true, -91, true, "1.0.0", 41),
        )
        assertTrue(encoded.contains("\"battery_pct\":72"))
        assertTrue(encoded.contains("\"charging\":true"))
        assertTrue(encoded.contains("\"signal_dbm\":-91"))
        assertTrue(encoded.contains("\"sim_ready\":true"))
        assertTrue(encoded.contains("\"app_version\":\"1.0.0\""))
        assertTrue(encoded.contains("\"sent_today\":41"))
    }

    @Test
    fun `heartbeat response parses and paused defaults to false`() {
        val response = json.decodeFromString<HeartbeatResponse>("""{"poll_seconds":60}""")
        assertEquals(60, response.pollSeconds)
        assertEquals(false, response.paused)
    }

    @Test
    fun `unknown server fields do not break the phone`() {
        // The server half may ship a field before this app knows about it.
        val response = json.decodeFromString<OutboxResponse>(
            """{"messages":[],"poll_seconds":30,"something_new":true}""",
        )
        assertEquals(30, response.pollSeconds)
    }

    @Test
    fun `a body containing a comma and quotes survives the round trip`() {
        val text = "Aarav's fee, Rs 12,500 — due \"today\""
        val encoded = json.encodeToString(MessageBodySerializer, MessageBody(text))
        assertEquals(text, json.decodeFromString(MessageBodySerializer, encoded).expose())
    }
}
