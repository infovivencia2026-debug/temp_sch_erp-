package com.schoolerp.bustracker.ui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import com.schoolerp.bustracker.data.repo.PairOutcome
import com.schoolerp.bustracker.ui.pair.PairScreen
import com.schoolerp.bustracker.ui.pair.PairViewModel
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

/**
 * The screen a driver meets at ten to seven in the morning, standing next to
 * the bus. Everything asserted here is something that, if it broke, would end
 * with a driver who cannot start the run and an office that cannot see why.
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
class PairScreenTest {

    @get:Rule
    val compose = createComposeRule()

    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun show(repository: com.schoolerp.bustracker.data.repo.TrackerRepository) {
        val viewModel = PairViewModel(repository, fakeSettingsStore(), fakeEngine())
        compose.setContent { PairScreen(viewModel) }
    }

    @Test
    fun `the sign-in button stays disabled until both fields are filled`() {
        show(fakeRepository())

        // A press with an empty password is a no-op inside the ViewModel, so
        // without this the driver gets a button that appears to do nothing.
        compose.onAllNodesWithText("Sign in").onLast().assertIsNotEnabled()

        compose.onNodeWithText("Mobile number or email").performTextInput("9876543210")
        compose.onAllNodesWithText("Sign in").onLast().assertIsNotEnabled()

        compose.onNodeWithText("Password").performTextInput("hunter2")
        compose.onAllNodesWithText("Sign in").onLast().assertIsEnabled()
    }

    @Test
    fun `signing in sends exactly what the driver typed`() {
        val repository = fakeRepository()
        coEvery { repository.driverSignIn(any(), any(), any()) } returns
            PairOutcome.Paired("TN 09 AB 1234", null)
        show(repository)

        // An email login, not a phone number: the office issues logins, and the
        // field used to strip everything that was not a digit.
        compose.onNodeWithText("Mobile number or email").performTextInput("driver@school.example")
        compose.onNodeWithText("Password").performTextInput("Passw0rd!")
        compose.onAllNodesWithText("Sign in").onLast().performScrollTo().performClick()

        coVerify { repository.driverSignIn(any(), "driver@school.example", "Passw0rd!") }
    }

    @Test
    fun `a paired handset shows the driver which bus it thinks it is`() {
        val repository = fakeRepository()
        coEvery { repository.driverSignIn(any(), any(), any()) } returns
            PairOutcome.Paired("TN 09 AB 1234", "Vivencia School")
        show(repository)

        compose.onNodeWithText("Mobile number or email").performTextInput("9876543210")
        compose.onNodeWithText("Password").performTextInput("Passw0rd!")
        compose.onAllNodesWithText("Sign in").onLast().performScrollTo().performClick()

        // The confirmation is the only chance to catch a driver who has been
        // paired to the wrong vehicle, before the wrong bus moves on the map.
        compose.onNodeWithText("This phone is now").assertExists()
        compose.onNodeWithText("TN 09 AB 1234").assertExists()
        compose.onNodeWithText("Vivencia School").assertExists()
        compose.onNodeWithText("Is that the bus you are driving today?").assertExists()
    }

    @Test
    fun `a rejected sign-in shows the server's own sentence, not a status code`() {
        val repository = fakeRepository()
        coEvery { repository.driverSignIn(any(), any(), any()) } returns PairOutcome.Rejected(
            "No bus is assigned to you yet. Ask the office to put you against a vehicle.",
        )
        show(repository)

        compose.onNodeWithText("Mobile number or email").performTextInput("9876543210")
        compose.onNodeWithText("Password").performTextInput("Passw0rd!")
        compose.onAllNodesWithText("Sign in").onLast().performScrollTo().performClick()

        compose.onNodeWithText(
            "No bus is assigned to you yet. Ask the office to put you against a vehicle.",
        ).assertExists()
    }

    @Test
    fun `answering no to the wrong bus unpairs the handset`() {
        val repository = fakeRepository()
        coEvery { repository.driverSignIn(any(), any(), any()) } returns
            PairOutcome.Paired("TN 09 AB 1234", null)
        show(repository)

        compose.onNodeWithText("Mobile number or email").performTextInput("9876543210")
        compose.onNodeWithText("Password").performTextInput("Passw0rd!")
        compose.onAllNodesWithText("Sign in").onLast().performScrollTo().performClick()
        compose.onNodeWithText("No, stop").performScrollTo().performClick()

        coVerify { repository.unpair() }
    }
}
