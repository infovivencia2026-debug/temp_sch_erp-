package com.schoolerp.bustracker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.schoolerp.bustracker.ui.RootViewModel
import com.schoolerp.bustracker.ui.pair.PairScreen
import com.schoolerp.bustracker.ui.run.RunScreen
import com.schoolerp.bustracker.ui.theme.BusTrackerTheme
import dagger.hilt.android.AndroidEntryPoint

/**
 * Two screens: pair, and run. Nothing else belongs here — a driver pulling away
 * from a depot at 6:40 with thirty children waiting cannot navigate a settings
 * maze, and every extra control is one more thing to get wrong.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            BusTrackerTheme { TrackerApp() }
        }
    }
}

/* Each screen carries its own Scaffold, because each has a bottom bar with
   the one button that matters and needs to place it against the keyboard
   and the navigation bar itself. This only paints the background. */
@Composable
private fun TrackerApp(viewModel: RootViewModel = hiltViewModel()) {
    val paired by viewModel.paired.collectAsStateWithLifecycle()

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (paired) RunScreen() else PairScreen()
    }
}
