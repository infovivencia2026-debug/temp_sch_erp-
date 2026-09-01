package com.schoolerp.bustracker.ui

import android.Manifest
import android.app.Application
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import com.schoolerp.bustracker.data.prefs.ActiveTrip
import com.schoolerp.bustracker.data.prefs.DIRECTION_PICKUP
import com.schoolerp.bustracker.data.prefs.SavedRoute
import com.schoolerp.bustracker.data.repo.SignInOutcome
import com.schoolerp.bustracker.data.repo.StartOutcome
import com.schoolerp.bustracker.data.repo.TrackerRepository
import com.schoolerp.bustracker.device.LocationBlocker
import com.schoolerp.bustracker.engine.TrackerStatus
import com.schoolerp.bustracker.ui.run.RunScreen
import com.schoolerp.bustracker.ui.run.RunViewModel
import io.mockk.coEvery
import io.mockk.coVerify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.Shadows.shadowOf

/**
 * The screen the driver actually works from. The cases here are the ones where
 * a wrong answer costs a school a bus it cannot see.
 */
@OptIn(ExperimentalCoroutinesApi::class)

/* A realistic handset, and every press scrolled into view first.
 *
 * Robolectric's default screen is 320x470px. Both screens are taller than that
 * and scroll, so a button below the fold is present in the semantics tree but
 * outside the viewport, and an injected touch lands on nothing -- the press
 * silently does not happen and the assertion that follows blames the app. */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w411dp-h891dp")
class RunScreenTest {

    @get:Rule
    val compose = createComposeRule()

    private val route = SavedRoute("route-1", "Morning — Anna Nagar")

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        // Without both grants the permission prompt composes a dialog over the
        // whole screen and every assertion below reads it instead.
        shadowOf(ApplicationProvider.getApplicationContext<Application>()).grantPermissions(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_BACKGROUND_LOCATION,
        )
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun show(
        repository: TrackerRepository,
        status: TrackerStatus = TrackerStatus(vehicleRegistration = "TN 09 AB 1234"),
    ) {
        val viewModel = RunViewModel(
            fakeAggregator(status),
            repository,
            fakeSettingsStore(),
            fakeEngine(),
            ApplicationProvider.getApplicationContext(),
        )
        compose.setContent { RunScreen(viewModel) }
    }

    /* THE GAP BETWEEN PAIRING AND DRIVING.
     *
     * A handset can be paired, showing its bus and its routes, with Start fully
     * enabled, and still have no driver session — the driver sign-in endpoint
     * returns a device token and no session. This pins what the driver sees
     * when they press Start in that state: a sentence telling them what to do,
     * and emphatically not a 401. If this ever regresses to silence, the run
     * simply never opens and nobody in the office knows why.
     */
    @Test
    fun `pressing Start with nobody signed in says so instead of failing quietly`() {
        val repository = fakeRepository(settings(routeBook = listOf(route)), signedIn = false)
        coEvery { repository.startTrip(any(), any(), any(), any()) } returns StartOutcome.NotSignedIn
        show(repository)

        compose.onNodeWithText("Start Run, Morning — Anna Nagar").performScrollTo().performClick()

        compose.onNodeWithText("Sign in before starting the run").assertExists()
        compose.onNodeWithText(
            "The school records who drove each run, so the phone needs your number and " +
                "PIN before it can open one. Use Sign in on this screen. The office " +
                "issued the PIN with your login.",
        ).assertExists()
    }

    @Test
    fun `the sign-in form sends the number and PIN the driver typed`() {
        val repository = fakeRepository(settings(routeBook = listOf(route)), signedIn = false)
        coEvery { repository.signIn(any(), any()) } returns SignInOutcome.SignedIn("R. Kumar")
        show(repository)

        compose.onNodeWithText("Mobile number or email").performTextInput("9876543210")
        compose.onNodeWithText("Password").performTextInput("4321")
        compose.onNodeWithText("Sign in").performScrollTo().performClick()

        coVerify { repository.signIn("9876543210", "4321") }
        compose.onNodeWithText("Signed in as R. Kumar").assertExists()
    }

    @Test
    fun `a refused PIN shows the office instruction, not a status code`() {
        val repository = fakeRepository(settings(routeBook = listOf(route)), signedIn = false)
        coEvery { repository.signIn(any(), any()) } returns SignInOutcome.Rejected(
            "Too many wrong PINs. Wait a few minutes, or ask the office to unlock it.",
        )
        show(repository)

        compose.onNodeWithText("Mobile number or email").performTextInput("9876543210")
        compose.onNodeWithText("Password").performTextInput("0000")
        compose.onNodeWithText("Sign in").performScrollTo().performClick()

        compose.onNodeWithText("Could not sign in").assertExists()
        compose.onNodeWithText(
            "Too many wrong PINs. Wait a few minutes, or ask the office to unlock it.",
        ).assertExists()
    }

    /* The card is the whole product in one line: it must never say the school
       can see the bus when it cannot. */
    @Test
    fun `a run with the service up reads as visible to the school`() {
        show(
            fakeRepository(settings(routeBook = listOf(route)), signedIn = true),
            TrackerStatus(
                vehicleRegistration = "TN 09 AB 1234",
                trip = ActiveTrip("t1", "route-1", "Morning", DIRECTION_PICKUP, 0L),
                serviceRunning = true,
            ),
        )

        compose.onNodeWithText("The school can see this bus").assertExists()
        compose.onNodeWithText("Reporting every 20s").assertExists()
        compose.onNodeWithText("End Run").assertExists()
    }

    @Test
    fun `a revoked location permission reads as not visible, however healthy the rest is`() {
        show(
            fakeRepository(settings(routeBook = listOf(route)), signedIn = true),
            TrackerStatus(
                vehicleRegistration = "TN 09 AB 1234",
                trip = ActiveTrip("t1", "route-1", "Morning", DIRECTION_PICKUP, 0L),
                serviceRunning = true,
                locationBlocker = LocationBlocker.FOREGROUND_ONLY,
            ),
        )

        compose.onNodeWithText("The school cannot see this bus").assertExists()
        // Twice on purpose: the blocker is the card's headline and it is also
        // what the one-line summary above it reports, because a blocked phone
        // has nothing more useful to say about itself.
        compose.onAllNodesWithText(LocationBlocker.FOREGROUND_ONLY.headline).assertCountEquals(2)
        compose.onNodeWithText(LocationBlocker.FOREGROUND_ONLY.detail).assertExists()
        compose.onNodeWithText("App permissions").assertExists()
    }

    /* Buffered fixes are the promise that a dead zone costs nothing. The
       driver has to be told they are held, not lost. */
    @Test
    fun `fixes held through a dead zone are reported as saved, not lost`() {
        show(
            fakeRepository(settings(routeBook = listOf(route)), signedIn = true),
            TrackerStatus(
                vehicleRegistration = "TN 09 AB 1234",
                trip = ActiveTrip("t1", "route-1", "Morning", DIRECTION_PICKUP, 0L),
                serviceRunning = true,
                bufferedFixes = 42,
                hasNetwork = false,
            ),
        )

        compose.onNodeWithText("No signal, holding 42 fixes").assertExists()
        compose.onNodeWithText(
            "42 positions are saved on this phone and will be sent when there is signal. " +
                "Nothing has been lost.",
        ).assertExists()
    }
}
