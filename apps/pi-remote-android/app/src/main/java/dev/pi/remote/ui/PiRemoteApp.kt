package dev.pi.remote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.pi.remote.model.ConnectionStatus
import dev.pi.remote.model.MainSection
import dev.pi.remote.model.PiRemoteState

@Composable
fun PiRemoteApp(state: PiRemoteState, viewModel: PiRemoteViewModel) {
	val needsConnection = state.connectionStatus in setOf(
		ConnectionStatus.DISCONNECTED,
		ConnectionStatus.CONNECTING,
		ConnectionStatus.FAILED,
	) && state.tasks.isEmpty()
	if (needsConnection) {
		ConnectionScreen(state, viewModel)
		return
	}
	ConnectedApp(state, viewModel)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConnectedApp(state: PiRemoteState, viewModel: PiRemoteViewModel) {
	val snackbar = remember { SnackbarHostState() }
	LaunchedEffect(state.error) {
		state.error?.let {
			snackbar.showSnackbar(it)
			viewModel.clearError()
		}
	}
	Scaffold(
		topBar = {
			TopAppBar(
				title = {
					Column {
						Text("Pi Remote", fontWeight = FontWeight.SemiBold)
						Text(
							state.tasks.firstOrNull { it.id == state.selectedInstanceId }?.label ?: "未选择任务",
							style = MaterialTheme.typography.labelMedium,
						)
					}
				},
				actions = {
					ConnectionBadge(state.connectionStatus)
				},
			)
		},
		bottomBar = {
			if (!state.terminalOpen) {
				NavigationBar {
					MainSection.entries.forEach { section ->
						NavigationBarItem(
							selected = state.activeSection == section,
							onClick = { viewModel.selectSection(section) },
							icon = {
								Text(
									when (section) {
										MainSection.TASKS -> "列"
										MainSection.TIMELINE -> "话"
										MainSection.CHANGES -> "改"
										MainSection.CONTROL -> "控"
									},
								)
							},
							label = { Text(section.label) },
						)
					}
				}
			}
		},
		snackbarHost = { SnackbarHost(snackbar) },
	) { padding ->
		Box(
			modifier = Modifier
				.fillMaxSize()
				.padding(padding),
		) {
			if (state.terminalOpen) {
				TerminalScreen(state, viewModel)
			} else {
				when (state.activeSection) {
					MainSection.TASKS -> TaskListScreen(state, viewModel)
					MainSection.TIMELINE -> TimelineScreen(state, viewModel)
					MainSection.CHANGES -> ChangesScreen(state, viewModel)
					MainSection.CONTROL -> ControlScreen(state, viewModel)
				}
			}
			if (state.busy) {
				LinearProgressIndicator(
					modifier = Modifier
						.fillMaxWidth()
						.align(Alignment.TopCenter),
				)
			}
		}
	}
}

@Composable
private fun ConnectionBadge(status: ConnectionStatus) {
	val (label, color) = when (status) {
		ConnectionStatus.CONNECTED -> "已连接" to MaterialTheme.colorScheme.primaryContainer
		ConnectionStatus.RECONNECTING -> "重连中" to MaterialTheme.colorScheme.tertiaryContainer
		ConnectionStatus.CONNECTING -> "连接中" to MaterialTheme.colorScheme.secondaryContainer
		ConnectionStatus.FAILED -> "失败" to MaterialTheme.colorScheme.errorContainer
		ConnectionStatus.DISCONNECTED -> "未连接" to MaterialTheme.colorScheme.surfaceVariant
	}
	Surface(
		color = color,
		shape = MaterialTheme.shapes.large,
		modifier = Modifier.padding(end = 12.dp),
	) {
		Text(label, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
	}
}

@Composable
fun EmptyState(
	title: String,
	detail: String,
	modifier: Modifier = Modifier,
	contentPadding: PaddingValues = PaddingValues(24.dp),
) {
	Column(
		modifier = modifier
			.fillMaxSize()
			.padding(contentPadding),
		horizontalAlignment = Alignment.CenterHorizontally,
		verticalArrangement = Arrangement.Center,
	) {
		Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
		Text(
			detail,
			style = MaterialTheme.typography.bodyMedium,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
			modifier = Modifier.padding(top = 8.dp),
		)
	}
}
