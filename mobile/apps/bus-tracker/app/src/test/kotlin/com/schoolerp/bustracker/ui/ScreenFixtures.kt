package com.schoolerp.bustracker.ui

import com.schoolerp.bustracker.data.prefs.SettingsStore
import com.schoolerp.bustracker.data.prefs.TrackerSettings
import com.schoolerp.bustracker.data.repo.TrackerRepository
import com.schoolerp.bustracker.engine.StatusAggregator
import com.schoolerp.bustracker.engine.TrackerStatus
import com.schoolerp.bustracker.engine.TripEngine
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf

/**
 * The seams these screens do not have.
 *
 * Neither PairScreen nor RunScreen takes state and callbacks — each takes its
 * ViewModel — and every collaborator behind those ViewModels is a final class
 * with no interface. So a screen test has to hand the real ViewModel mocked
 * collaborators, and the two that must never be built for real are TokenStore,
 * which opens an AndroidKeyStore master key, and SettingsStore, whose DataStore
 * delegate is process-wide and leaks between tests in the same JVM.
 */

fun settings(
    baseUrl: String = "https://school.example",
    allowInsecureHttp: Boolean = false,
    routeBook: List<com.schoolerp.bustracker.data.prefs.SavedRoute> = emptyList(),
    activeTrip: com.schoolerp.bustracker.data.prefs.ActiveTrip? = null,
) = TrackerSettings(
    baseUrl = baseUrl,
    institution = null,
    deviceId = "device-1",
    vehicleId = "vehicle-1",
    vehicleRegistration = "TN 09 AB 1234",
    pingSeconds = TrackerSettings.DEFAULT_PING_SECONDS,
    paused = false,
    allowInsecureHttp = allowInsecureHttp,
    lastPushAt = 0L,
    lastHeartbeatAt = 0L,
    lastServerError = null,
    activeTrip = activeTrip,
    routeBook = routeBook,
)

fun fakeSettingsStore(value: TrackerSettings = settings()): SettingsStore =
    mockk<SettingsStore>(relaxed = true).also {
        every { it.settings } returns flowOf(value)
    }

/**
 * A repository that answers the reads every screen makes on composition. Each
 * test stubs the one call it is actually about on top of this.
 */
fun fakeRepository(
    value: TrackerSettings = settings(),
    signedIn: Boolean = false,
    paired: Boolean = true,
): TrackerRepository = mockk<TrackerRepository>(relaxed = true).also {
    every { it.settings } returns flowOf(value)
    every { it.bufferDepth } returns flowOf(0)
    every { it.signedIn } returns MutableStateFlow(signedIn)
    every { it.paired } returns MutableStateFlow(paired)
    every { it.driverName() } returns null
    every { it.observeStops(any()) } returns flowOf(emptyList())
}

fun fakeAggregator(status: TrackerStatus): StatusAggregator =
    mockk<StatusAggregator>(relaxed = true).also {
        every { it.status } returns flowOf(status)
    }

/** An engine that never emits: the run screen only collects its events. */
fun fakeEngine(): TripEngine = mockk<TripEngine>(relaxed = true).also {
    every { it.events } returns MutableSharedFlow()
}
