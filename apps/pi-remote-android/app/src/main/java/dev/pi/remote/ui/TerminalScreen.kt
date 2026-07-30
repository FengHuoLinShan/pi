package dev.pi.remote.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.pi.remote.model.PiRemoteState
import dev.pi.remote.model.TerminalEntry

@Composable
fun TerminalScreen(state: PiRemoteState, viewModel: PiRemoteViewModel) {
	var command by remember { mutableStateOf("") }
	BackHandler(onBack = viewModel::closeTerminal)
	Column(
		modifier = Modifier
			.fillMaxSize()
			.background(Color(0xFF101318))
			.imePadding(),
	) {
		Row(
			modifier = Modifier
				.fillMaxWidth()
				.padding(horizontal = 12.dp, vertical = 8.dp),
			horizontalArrangement = Arrangement.SpaceBetween,
		) {
			TextButton(onClick = viewModel::closeTerminal) {
				Text("返回", color = Color(0xFFB8C8E8))
			}
			Text("Pi 远程终端", color = Color.White, fontWeight = FontWeight.SemiBold)
			if (state.terminalEntries.any { it.running }) {
				TextButton(onClick = viewModel::abortTerminalCommand) {
					Text("停止", color = Color(0xFFFFB4AB))
				}
			} else {
				Text("RPC", color = Color(0xFF8F9BAD), modifier = Modifier.padding(12.dp))
			}
		}
		if (state.terminalEntries.isEmpty()) {
			Column(
				modifier = Modifier
					.weight(1f)
					.padding(20.dp),
				verticalArrangement = Arrangement.Center,
			) {
				Text("命令在当前 Pi 工作目录执行。", color = Color(0xFFB8C0CC))
				Text(
					"高风险命令仍应由 Pi 的权限策略或隔离环境约束。",
					color = Color(0xFF8F9BAD),
					modifier = Modifier.padding(top = 6.dp),
				)
			}
		} else {
			LazyColumn(
				modifier = Modifier.weight(1f),
				contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
				verticalArrangement = Arrangement.spacedBy(14.dp),
			) {
				items(state.terminalEntries, key = { it.id }) { entry ->
					TerminalEntryView(entry)
				}
			}
		}
		Column(
			modifier = Modifier
				.fillMaxWidth()
				.background(Color(0xFF191D24))
				.padding(10.dp),
		) {
			OutlinedTextField(
				value = command,
				onValueChange = { command = it },
				label = { Text("shell 命令") },
				textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
				minLines = 1,
				maxLines = 4,
				modifier = Modifier.fillMaxWidth(),
			)
			Button(
				onClick = {
					viewModel.runTerminalCommand(command)
					command = ""
				},
				enabled = command.isNotBlank(),
				colors = ButtonDefaults.buttonColors(
					containerColor = Color(0xFF4F6FAF),
					contentColor = Color.White,
					disabledContainerColor = Color(0xFF303844),
					disabledContentColor = Color(0xFF9DA8B8),
				),
				modifier = Modifier
					.fillMaxWidth()
					.padding(top = 8.dp),
			) {
				Text("执行")
			}
		}
	}
}

@Composable
private fun TerminalEntryView(entry: TerminalEntry) {
	Column(modifier = Modifier.fillMaxWidth()) {
		Text(
			"$ ${entry.command}",
			color = Color(0xFF8ED0A4),
			fontFamily = FontFamily.Monospace,
			fontWeight = FontWeight.Medium,
		)
		Text(
			when {
				entry.running -> "运行中…"
				entry.output.isBlank() -> "(无输出)"
				else -> entry.output
			},
			color = if (entry.failed) Color(0xFFFFB4AB) else Color(0xFFD9E2F2),
			fontFamily = FontFamily.Monospace,
			modifier = Modifier.padding(top = 4.dp),
		)
		if (!entry.running) {
			Text(
				"exit ${entry.exitCode ?: "-"}",
				color = Color(0xFF8F9BAD),
				style = MaterialTheme.typography.labelSmall,
				modifier = Modifier.padding(top = 3.dp),
			)
		}
	}
}
