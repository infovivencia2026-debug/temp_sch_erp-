package com.schoolerp.bustracker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
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

@Composable
private fun TrackerApp(viewModel: RootViewModel = hiltViewModel()) {
    val paired by viewModel.paired.collectAsStateWithLifecycle()

    Scaffold(modifier = Modifier.fillMaxSize()) { insets ->
        Box(Modifier.padding(insets)) {
            if (paired) RunScreen() else PairScreen()
        }
    }
}
