package dev.pi.remote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.pi.remote.model.ConnectionStatus
import dev.pi.remote.model.PiRemoteState

@Composable
fun ConnectionScreen(state: PiRemoteState, viewModel: PiRemoteViewModel) {
	var baseUrl by remember(state.config.baseUrl) { mutableStateOf(state.config.baseUrl) }
	var token by remember(state.config.token) { mutableStateOf(state.config.token) }
	val connecting = state.connectionStatus == ConnectionStatus.CONNECTING

	Column(
		modifier = Modifier
			.fillMaxSize()
			.verticalScroll(rememberScrollState())
			.padding(24.dp),
		verticalArrangement = Arrangement.Center,
	) {
		Text("Pi Remote", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
		Text(
			"连接本机 Pi orchestrator",
			style = MaterialTheme.typography.titleMedium,
			color = MaterialTheme.colorScheme.onSurfaceVariant,
			modifier = Modifier.padding(top = 4.dp, bottom = 28.dp),
		)
		OutlinedTextField(
			value = baseUrl,
			onValueChange = { baseUrl = it },
			label = { Text("网关地址") },
			placeholder = { Text("http://127.0.0.1:8787") },
			singleLine = true,
			modifier = Modifier.fillMaxWidth(),
		)
		Spacer(Modifier.height(12.dp))
		OutlinedTextField(
			value = token,
			onValueChange = { token = it },
			label = { Text("访问令牌") },
			visualTransformation = PasswordVisualTransformation(),
			singleLine = true,
			modifier = Modifier.fillMaxWidth(),
		)
		if (state.error != null) {
			Text(
				state.error,
				color = MaterialTheme.colorScheme.error,
				style = MaterialTheme.typography.bodyMedium,
				modifier = Modifier.padding(top = 12.dp),
			)
		}
		Button(
			onClick = { viewModel.connect(baseUrl, token) },
			enabled = !connecting && baseUrl.isNotBlank() && token.isNotBlank(),
			modifier = Modifier
				.fillMaxWidth()
				.padding(top = 20.dp),
		) {
			Text(if (connecting) "连接中…" else "连接 Pi")
		}
		if (connecting) {
			LinearProgressIndicator(
				modifier = Modifier
					.fillMaxWidth()
					.padding(top = 12.dp),
			)
		}
		Card(modifier = Modifier.padding(top = 28.dp)) {
			Column(modifier = Modifier.padding(16.dp)) {
				Text("模拟器连接", fontWeight = FontWeight.SemiBold)
				Text(
					"电脑运行 orchestrator serve --remote，然后执行 adb reverse tcp:8787 tcp:8787。",
					style = MaterialTheme.typography.bodyMedium,
					modifier = Modifier.padding(top = 6.dp),
				)
				Text(
					"真机应通过 Tailscale HTTPS 地址连接，禁止直接暴露公网端口。",
					style = MaterialTheme.typography.bodyMedium,
					modifier = Modifier.padding(top = 6.dp),
				)
			}
		}
		Row(
			modifier = Modifier.fillMaxWidth(),
			horizontalArrangement = Arrangement.End,
		) {
			TextButton(onClick = viewModel::clearSavedConnection) {
				Text("清除保存的连接")
			}
		}
	}
}
