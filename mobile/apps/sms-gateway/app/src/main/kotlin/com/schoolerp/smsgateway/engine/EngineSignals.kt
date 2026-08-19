package com.schoolerp.smsgateway.engine

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The live state the running service publishes and the UI reads.
 *
 * It exists as its own singleton so the status screen does not have to depend
 * on the engine, and the engine does not have to know a screen exists.
 */
@Singleton
class EngineSignals @Inject constructor() {

    private val _connection = MutableStateFlow(ConnectionState.NEVER_CONNECTED)
    val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    private val _device = MutableStateFlow(DeviceSnapshot())
    val device: StateFlow<DeviceSnapshot> = _device.asStateFlow()

    val signals = combine(connection, device) { connection, device -> connection to device }

    fun publishConnection(state: ConnectionState) {
        _connection.value = state
    }

    fun publishDevice(snapshot: DeviceSnapshot) {
        _device.value = snapshot
    }

    fun publishServiceRunning(running: Boolean) {
        _device.value = _device.value.copy(serviceRunning = running)
    }
}
