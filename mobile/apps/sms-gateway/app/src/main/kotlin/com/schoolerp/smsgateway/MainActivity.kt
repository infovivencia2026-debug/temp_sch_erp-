package com.schoolerp.smsgateway

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
import com.schoolerp.smsgateway.ui.PermissionPrompt
import com.schoolerp.smsgateway.ui.RootViewModel
import com.schoolerp.smsgateway.ui.pair.PairScreen
import com.schoolerp.smsgateway.ui.status.StatusScreen
import com.schoolerp.smsgateway.ui.theme.SmsGatewayTheme
import dagger.hilt.android.AndroidEntryPoint

/**
 * Two screens: pair, and status. There is nothing else for anyone to do here,
 * and a gateway with a settings maze is a gateway nobody can fix at 8:45am.
 */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            SmsGatewayTheme { GatewayApp() }
        }
    }
}

@Composable
private fun GatewayApp(viewModel: RootViewModel = hiltViewModel()) {
    val paired by viewModel.paired.collectAsStateWithLifecycle()

    Scaffold(modifier = Modifier.fillMaxSize()) { insets ->
        Box(Modifier.padding(insets)) {
            if (paired) {
                StatusScreen(onUnpaired = {})
            } else {
                PairScreen(onPaired = {})
            }
        }
        // Asked once the operator is looking at the app, never from a service.
        PermissionPrompt(onFinished = viewModel::refreshDeviceSnapshot)
    }
}
