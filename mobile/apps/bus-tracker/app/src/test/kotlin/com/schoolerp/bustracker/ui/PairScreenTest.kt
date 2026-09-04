package com.schoolerp.bustracker.ui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
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
 * the bus. It opens on the number-and-PIN sign-in; the office's six-digit
 * pairing code is one quiet line away. Everything here is something that,
 * if it broke, would end with a driver who cannot get in and an office that
 * cannot see why.
 */
@OptIn(ExperimentalCoroutinesApi::class)

/* A realistic handset. Robolectric's default screen is 320x470px; the one
 * button that matters sits in a bottom bar, which on a screen that small
 * would cover the fields. */
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
        val viewModel = PairViewModel(
            repository, fakeSettingsStore(), fakeEngine(), ApplicationProvider.getApplicationContext(),
        )
        compose.setContent { PairScreen(viewModel) }
    }

    /** The heading and the button say the same word; the button is the one that presses. */
    private fun button(text: String) = compose.onNode(hasText(text) and hasClickAction())

    /** The code path is behind one line; every code test starts by taking it. */
    private fun switchToCode() {
        compose.onNodeWithText("I was given a pairing code").performClick()
    }

    @Test
    fun `the pair button stays disabled until all six boxes are filled`() {
        show(fakeRepository())
        switchToCode()

        // A press with a half-typed code is a no-op inside the ViewModel, so
        // without this the driver gets a button that appears to do nothing.
        button("Pair this phone").assertIsNotEnabled()

        compose.onNodeWithTag("Pairing code").performTextInput("1234")
        button("Pair this phone").assertIsNotEnabled()

        compose.onNodeWithTag("Pairing code").performTextInput("56")
        button("Pair this phone").assertIsEnabled()
    }

    @Test
    fun `pairing sends the code the driver typed, tidied the way the office wrote it`() {
        val repository = fakeRepository()
        coEvery { repository.pair(any(), any()) } returns PairOutcome.Paired("TN 09 AB 1234", null)
        show(repository)
        switchToCode()

        // Lower case with a dash, as a code read off a printout gets typed;
        // the boxes hold six and drop the rest.
        compose.onNodeWithTag("Pairing code").performTextInput("abcd-23456")
        button("Pair this phone").performClick()

        coVerify { repository.pair(any(), "ABCD23") }
    }

    @Test
    fun `a rejected code shows the server's own sentence, not a status code`() {
        val repository = fakeRepository()
        coEvery { repository.pair(any(), any()) } returns PairOutcome.Rejected(
            "That code has expired. Ask the office for a fresh one.",
        )
        show(repository)
        switchToCode()

        compose.onNodeWithTag("Pairing code").performTextInput("123456")
        button("Pair this phone").performClick()

        compose.onNodeWithText("That code has expired. Ask the office for a fresh one.").assertExists()
        // And who to ring, under it.
        compose.onNodeWithText("Stuck? Ask the school office.").assertExists()
    }

    @Test
    fun `the sign-in sends the number and PIN from the boxes`() {
        val repository = fakeRepository()
        coEvery { repository.driverSignIn(any(), any(), any()) } returns PairOutcome.Paired("TN 09 AB 1234", null)
        show(repository)

        button("Sign in").assertIsNotEnabled()
        compose.onNodeWithTag("Mobile number").performTextInput("9876543210")
        compose.onNodeWithTag("PIN").performTextInput("123456")
        button("Sign in").assertIsEnabled().performClick()

        coVerify { repository.driverSignIn(any(), "9876543210", "123456") }
    }
}
