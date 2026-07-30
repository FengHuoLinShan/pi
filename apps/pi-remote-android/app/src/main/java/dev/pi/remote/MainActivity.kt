package dev.pi.remote

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.pi.remote.ui.PiRemoteApp
import dev.pi.remote.ui.PiRemoteViewModel
import dev.pi.remote.ui.theme.PiRemoteTheme

class MainActivity : ComponentActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		if (
			Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
			checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
		) {
			requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
		}
		setContent {
			PiRemoteTheme {
				val viewModel: PiRemoteViewModel = viewModel()
				val state by viewModel.state.collectAsStateWithLifecycle()
				PiRemoteApp(state = state, viewModel = viewModel)
			}
		}
	}

	private companion object {
		const val NOTIFICATION_PERMISSION_REQUEST = 1001
	}
}
