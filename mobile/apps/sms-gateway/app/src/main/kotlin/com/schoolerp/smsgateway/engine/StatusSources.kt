package com.schoolerp.smsgateway.engine

import com.schoolerp.smsgateway.data.local.FailureRow
import com.schoolerp.smsgateway.data.prefs.GatewaySettings
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/**
 * What the status screen needs to observe.
 *
 * The repository implements this. It exists as an interface only so
 * [StatusAggregator] — where the "why is nothing sending" logic lives — can be
 * tested against fake flows without a database, a network or an emulator.
 */
interface StatusSources {
    val settings: Flow<GatewaySettings>
    val paired: StateFlow<Boolean>
    fun observeQueueDepth(): Flow<Int>
    fun observePendingReceipts(): Flow<Int>
    fun observeSentToday(): Flow<Int>
    fun observeFailedToday(): Flow<Int>
    fun observeRecentFailures(limit: Int = 20): Flow<List<FailureRow>>
}
