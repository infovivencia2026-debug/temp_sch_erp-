package com.schoolerp.bustracker.ui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
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
 * the bus. It is one field and one button now: he was handed a code, he types
 * the code. The sign-in with a number and PIN moved to the run screen, and is
 * asserted there. Everything here is something that, if it broke, would end
 * with a driver who cannot pair the handset and an office that cannot see why.
 */
@OptIn(ExperimentalCoroutinesApi::class)

/* A realistic handset, and every press scrolled into view first.
 *
 * Robolectric's default screen is 320x470px. The screens scroll, so a button
 * below the fold is present in the semantics tree but outside the viewport,
 * and an injected touch lands on nothing -- the press silently does not
 * happen and the assertion that follows blames the app. */
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
    fun `the pair button stays disabled until the whole code is typed`() {
        show(fakeRepository())

        // A press with a half-typed code is a no-op inside the ViewModel, so
        // without this the driver gets a button that appears to do nothing.
        compose.onNodeWithText("Pair this phone").assertIsNotEnabled()

        compose.onNodeWithText("Pairing code").performTextInput("ABCD")
        compose.onNodeWithText("Pair this phone").assertIsNotEnabled()

        compose.onNodeWithText("Pairing code").performTextInput("23456")
        compose.onNodeWithText("Pair this phone").assertIsEnabled()
    }

    @Test
    fun `pairing sends the code the driver typed, tidied the way the office wrote it`() {
        val repository = fakeRepository()
        coEvery { repository.pair(any(), any()) } returns PairOutcome.Paired("TN 09 AB 1234", null)
        show(repository)

        // Lower case with a dash, as a code read off a printout gets typed.
        compose.onNodeWithText("Pairing code").performTextInput("abcd-23456")
        compose.onNodeWithText("Pair this phone").performScrollTo().performClick()

        coVerify { repository.pair(any(), "ABCD23456") }
    }

    @Test
    fun `a rejected code shows the server's own sentence, not a status code`() {
        val repository = fakeRepository()
        coEvery { repository.pair(any(), any()) } returns PairOutcome.Rejected(
            "That code has expired. Ask the office for a fresh one.",
        )
        show(repository)

        compose.onNodeWithText("Pairing code").performTextInput("ABCD23456")
        compose.onNodeWithText("Pair this phone").performScrollTo().performClick()

        compose.onNodeWithText("That code has expired. Ask the office for a fresh one.").assertExists()
    }
}
