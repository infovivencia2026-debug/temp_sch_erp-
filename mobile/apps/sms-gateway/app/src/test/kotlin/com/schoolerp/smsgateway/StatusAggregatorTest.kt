package com.schoolerp.smsgateway

import app.cash.turbine.test
import com.schoolerp.smsgateway.data.local.FailureRow
import com.schoolerp.smsgateway.data.prefs.GatewaySettings
import com.schoolerp.smsgateway.engine.Blocker
import com.schoolerp.smsgateway.engine.ConnectionState
import com.schoolerp.smsgateway.engine.DeviceSnapshot
import com.schoolerp.smsgateway.engine.EngineSignals
import com.schoolerp.smsgateway.engine.StatusAggregator
import com.schoolerp.smsgateway.engine.StatusSources
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class StatusAggregatorTest {

    private class FakeSources : StatusSources {
        val settingsFlow = MutableStateFlow(
            GatewaySettings(
                baseUrl = "https://school.example.in",
                institutionName = "Vivencia High",
                institutionId = "inst_1",
                deviceId = "dev_1",
                pollSeconds = 30,
                maxPerMinute = 10,
                pausedByServer = false,
                allowInsecureHttp = false,
                lastPollAt = 5_000L,
                lastHeartbeatAt = 5_000L,
                lastServerError = null,
            ),
        )
        val pairedFlow = MutableStateFlow(true)
        val depth = MutableStateFlow(0)
        val pending = MutableStateFlow(0)
        val sent = MutableStateFlow(0)
        val failed = MutableStateFlow(0)
        val failures = MutableStateFlow(emptyList<FailureRow>())

        override val settings: Flow<GatewaySettings> get() = settingsFlow
        override val paired: StateFlow<Boolean> get() = pairedFlow
        override fun observeQueueDepth(): Flow<Int> = depth
        override fun observePendingReceipts(): Flow<Int> = pending
        override fun observeSentToday(): Flow<Int> = sent
        override fun observeFailedToday(): Flow<Int> = failed
        override fun observeRecentFailures(limit: Int): Flow<List<FailureRow>> = failures
    }

    private fun healthyDevice() = DeviceSnapshot(
        smsPermission = true,
        phoneStatePermission = true,
        simReady = true,
        notificationsAllowed = true,
        ignoringBatteryOptimisations = true,
        hasNetwork = true,
        serviceRunning = true,
    )

    @Test
    fun `the first emission describes a healthy paired gateway`() = runTest {
        val sources = FakeSources()
        val signals = EngineSignals().apply {
            publishConnection(ConnectionState.CONNECTED)
            publishDevice(healthyDevice())
        }

        StatusAggregator(sources, signals).status.test {
            val status = awaitItem()
            assertEquals("Vivencia High", status.institutionName)
            assertEquals(ConnectionState.CONNECTED, status.connection)
            assertTrue(status.blockers.isEmpty())
            assertTrue(status.healthy)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `pulling the SIM turns into a blocker on the very next emission`() = runTest {
        val sources = FakeSources()
        val signals = EngineSignals().apply {
            publishConnection(ConnectionState.CONNECTED)
            publishDevice(healthyDevice())
        }

        StatusAggregator(sources, signals).status.test {
            assertTrue(awaitItem().healthy)

            signals.publishDevice(healthyDevice().copy(simReady = false))

            val status = awaitItem()
            assertTrue(status.blockers.contains(Blocker.SIM_NOT_READY))
            assertFalse(status.healthy)
            assertEquals(Blocker.SIM_NOT_READY.headline, status.summary)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `a queued message and then a send move the counts`() = runTest {
        val sources = FakeSources()
        val signals = EngineSignals().apply {
            publishConnection(ConnectionState.CONNECTED)
            publishDevice(healthyDevice())
        }

        StatusAggregator(sources, signals).status.test {
            assertEquals(0, awaitItem().queueDepth)

            sources.depth.value = 3
            assertEquals(3, awaitItem().queueDepth)

            sources.depth.value = 0
            sources.sent.value = 3
            // Two independent flows changed, so allow for either ordering and
            // assert on the state that settles.
            var latest = awaitItem()
            while (latest.sentToday != 3 || latest.queueDepth != 0) latest = awaitItem()
            assertEquals("Ready — 3 sent today", latest.summary)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `unpaired collapses to the pairing blocker`() = runTest {
        val sources = FakeSources()
        val signals = EngineSignals().apply {
            publishConnection(ConnectionState.NEVER_CONNECTED)
            publishDevice(healthyDevice())
        }

        StatusAggregator(sources, signals).status.test {
            awaitItem()
            sources.pairedFlow.value = false

            var latest = awaitItem()
            while (latest.paired) latest = awaitItem()
            assertTrue(latest.blockers.contains(Blocker.NOT_PAIRED))
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `unreported receipts are surfaced, because the server will re-send`() = runTest {
        val sources = FakeSources()
        val signals = EngineSignals().apply {
            publishConnection(ConnectionState.CONNECTED)
            publishDevice(healthyDevice())
        }

        StatusAggregator(sources, signals).status.test {
            assertEquals(0, awaitItem().pendingReceipts)
            sources.pending.value = 7
            var latest = awaitItem()
            while (latest.pendingReceipts != 7) latest = awaitItem()
            assertEquals(7, latest.pendingReceipts)
            cancelAndIgnoreRemainingEvents()
        }
    }
}
