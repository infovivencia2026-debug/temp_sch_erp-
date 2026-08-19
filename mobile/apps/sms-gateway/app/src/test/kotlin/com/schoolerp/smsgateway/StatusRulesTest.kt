package com.schoolerp.smsgateway

import com.schoolerp.smsgateway.data.prefs.GatewaySettings
import com.schoolerp.smsgateway.engine.Blocker
import com.schoolerp.smsgateway.engine.ConnectionState
import com.schoolerp.smsgateway.engine.DeviceSnapshot
import com.schoolerp.smsgateway.engine.QueueCounts
import com.schoolerp.smsgateway.engine.StatusRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** "Why is nothing sending" is the question this screen exists to answer. */
class StatusRulesTest {

    private val healthySettings = GatewaySettings(
        baseUrl = "https://school.example.in",
        institutionName = "Vivencia High",
        institutionId = "inst_1",
        deviceId = "dev_1",
        pollSeconds = 30,
        maxPerMinute = 10,
        pausedByServer = false,
        allowInsecureHttp = false,
        lastPollAt = 1_000L,
        lastHeartbeatAt = 1_000L,
        lastServerError = null,
    )

    private val healthyDevice = DeviceSnapshot(
        smsPermission = true,
        phoneStatePermission = true,
        simReady = true,
        notificationsAllowed = true,
        ignoringBatteryOptimisations = true,
        hasNetwork = true,
        serviceRunning = true,
    )

    @Test
    fun `a healthy gateway reports no blockers at all`() {
        assertTrue(StatusRules.blockers(true, healthySettings, healthyDevice).isEmpty())
    }

    @Test
    fun `a refused SMS permission stops sending and says so`() {
        val blockers = StatusRules.blockers(
            paired = true,
            settings = healthySettings,
            device = healthyDevice.copy(smsPermission = false),
        )
        assertTrue(blockers.contains(Blocker.SMS_PERMISSION_DENIED))
        assertTrue(Blocker.SMS_PERMISSION_DENIED.stopsSending)
    }

    @Test
    fun `a missing SIM stops sending`() {
        val blockers = StatusRules.blockers(true, healthySettings, healthyDevice.copy(simReady = false))
        assertTrue(blockers.contains(Blocker.SIM_NOT_READY))
    }

    @Test
    fun `no network does not stop messages already claimed`() {
        // Anything already on this phone can still be sent over the radio; only
        // claiming new work needs the internet.
        assertFalse(Blocker.NO_NETWORK.stopsSending)
        val blockers = StatusRules.blockers(true, healthySettings, healthyDevice.copy(hasNetwork = false))
        assertTrue(blockers.contains(Blocker.NO_NETWORK))
    }

    @Test
    fun `a paused gateway is reported as paused, not as broken`() {
        val blockers = StatusRules.blockers(
            true,
            healthySettings.copy(pausedByServer = true),
            healthyDevice,
        )
        assertEquals(listOf(Blocker.PAUSED_BY_SERVER), blockers)
    }

    @Test
    fun `an unpaired phone is not also accused of a dead service`() {
        val blockers = StatusRules.blockers(false, healthySettings, healthyDevice.copy(serviceRunning = false))
        assertTrue(blockers.contains(Blocker.NOT_PAIRED))
        assertFalse(
            "an unpaired phone has no service to be running",
            blockers.contains(Blocker.SERVICE_NOT_RUNNING),
        )
    }

    @Test
    fun `the summary leads with the reason nothing is sending`() {
        val status = StatusRules.assemble(
            paired = true,
            settings = healthySettings,
            connection = ConnectionState.CONNECTED,
            device = healthyDevice.copy(simReady = false),
            counts = QueueCounts(queueDepth = 14),
            failures = emptyList(),
        )
        assertEquals(Blocker.SIM_NOT_READY.headline, status.summary)
        assertFalse(status.healthy)
    }

    @Test
    fun `a healthy idle gateway shows today's count`() {
        val status = StatusRules.assemble(
            paired = true,
            settings = healthySettings,
            connection = ConnectionState.CONNECTED,
            device = healthyDevice,
            counts = QueueCounts(sentToday = 41),
            failures = emptyList(),
        )
        assertEquals("Ready — 41 sent today", status.summary)
        assertTrue(status.healthy)
    }

    @Test
    fun `every blocker has an explanation an office can act on`() {
        Blocker.entries.forEach { blocker ->
            assertTrue(blocker.name, blocker.headline.isNotBlank())
            assertTrue(blocker.name, blocker.detail.length > 40)
        }
    }
}
