package dev.pi.remote.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pi.remote.model.ModelOption
import dev.pi.remote.model.PiRemoteState
import dev.pi.remote.model.SessionBranch
import java.util.Locale

@Composable
fun ControlScreen(state: PiRemoteState, viewModel: PiRemoteViewModel) {
	var showModels by remember { mutableStateOf(false) }
	var showAllBranches by remember { mutableStateOf(false) }
	if (showModels) {
		ModelPickerDialog(
			models = state.models,
			selectedKey = state.selectedModelKey,
			onDismiss = { showModels = false },
			onSelect = {
				showModels = false
				viewModel.setModel(it)
			},
		)
	}
	if (state.selectedInstanceId == null) {
		EmptyState("未选择任务", "选择任务后调整模型、上下文和会话。")
		return
	}
	LazyColumn(
		modifier = Modifier.fillMaxSize(),
		contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
		verticalArrangement = Arrangement.spacedBy(14.dp),
	) {
		item {
			ControlCard("模型") {
				Text(
					state.selectedModelKey ?: "未选择",
					style = MaterialTheme.typography.bodyMedium,
					maxLines = 2,
					overflow = TextOverflow.Ellipsis,
				)
				Button(
					onClick = { showModels = true },
					enabled = state.models.isNotEmpty(),
					modifier = Modifier
						.fillMaxWidth()
						.padding(top = 10.dp),
				) {
					Text("切换模型")
				}
			}
		}
		item {
			ControlCard("思考级别") {
				Row(
					modifier = Modifier
						.fillMaxWidth()
						.horizontalScroll(rememberScrollState()),
					horizontalArrangement = Arrangement.spacedBy(8.dp),
				) {
					listOf("off", "minimal", "low", "medium", "high", "xhigh", "max").forEach { level ->
						FilterChip(
							selected = state.thinkingLevel == level,
							onClick = { viewModel.setThinkingLevel(level) },
							label = { Text(level) },
						)
					}
				}
			}
		}
		item {
			ControlCard("上下文") {
				MetricRow("上下文 Token", state.metrics.contextTokens.toString())
				MetricRow("输入 / 输出", "${state.metrics.inputTokens} / ${state.metrics.outputTokens}")
				MetricRow("会话费用", String.format(Locale.US, "$%.4f", state.metrics.cost))
				MetricRow("压缩状态", if (state.isCompacting) "进行中" else "空闲")
				OutlinedButton(
					onClick = viewModel::compact,
					modifier = Modifier
						.fillMaxWidth()
						.padding(top = 8.dp),
				) {
					Text("立即压缩上下文")
				}
			}
		}
		item {
			ControlCard("会话") {
				MetricRow("名称", state.sessionName ?: "未命名")
				Row(
					modifier = Modifier
						.fillMaxWidth()
						.padding(top = 8.dp),
					horizontalArrangement = Arrangement.spacedBy(8.dp),
				) {
					OutlinedButton(onClick = viewModel::newSession, modifier = Modifier.weight(1f)) {
						Text("新会话")
					}
					OutlinedButton(onClick = viewModel::cloneSession, modifier = Modifier.weight(1f)) {
						Text("克隆")
					}
				}
			}
		}
		item {
			ControlCard("终端") {
				Text(
					"通过 Pi RPC 执行命令，输出保留在当前手机会话中。",
					style = MaterialTheme.typography.bodyMedium,
				)
				Button(
					onClick = viewModel::openTerminal,
					modifier = Modifier
						.fillMaxWidth()
						.padding(top = 10.dp),
				) {
					Text("打开远程终端")
				}
			}
		}
		item {
			ControlCard("连接") {
				Text(state.config.baseUrl, style = MaterialTheme.typography.bodySmall)
				OutlinedButton(
					onClick = viewModel::disconnect,
					modifier = Modifier
						.fillMaxWidth()
						.padding(top = 10.dp),
				) {
					Text("断开连接")
				}
			}
		}
		if (state.sessionBranches.isNotEmpty()) {
			item {
				Row(
					modifier = Modifier.fillMaxWidth(),
					horizontalArrangement = Arrangement.SpaceBetween,
				) {
					Text("会话树", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
					if (state.sessionBranches.size > 8) {
						TextButton(onClick = { showAllBranches = !showAllBranches }) {
							Text(if (showAllBranches) "收起" else "查看全部 ${state.sessionBranches.size}")
						}
					}
				}
			}
			val visibleBranches = if (showAllBranches) state.sessionBranches else state.sessionBranches.takeLast(8)
			items(visibleBranches, key = { it.entryId }) { branch ->
				SessionBranchRow(branch) {
					if (!branch.isLeaf) {
						viewModel.forkSession(branch.entryId)
					}
				}
			}
		}
	}
}

@Composable
private fun ControlCard(title: String, content: @Composable ColumnScope.() -> Unit) {
	Card(modifier = Modifier.fillMaxWidth()) {
		Column(modifier = Modifier.padding(16.dp)) {
			Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
			Column(modifier = Modifier.padding(top = 10.dp), content = content)
		}
	}
}

@Composable
private fun MetricRow(label: String, value: String) {
	Row(
		modifier = Modifier
			.fillMaxWidth()
			.padding(vertical = 3.dp),
		horizontalArrangement = Arrangement.SpaceBetween,
	) {
		Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant)
		Text(value, fontWeight = FontWeight.Medium)
	}
}

@Composable
private fun SessionBranchRow(branch: SessionBranch, onFork: () -> Unit) {
	Card(
		modifier = Modifier
			.fillMaxWidth()
			.padding(start = (branch.depth.coerceAtMost(5) * 12).dp)
			.clickable(onClick = onFork),
	) {
		Row(
			modifier = Modifier
				.fillMaxWidth()
				.padding(12.dp),
			horizontalArrangement = Arrangement.SpaceBetween,
		) {
			Text(branch.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
			Text(if (branch.isLeaf) "当前" else "分叉", style = MaterialTheme.typography.labelMedium)
		}
	}
}

@Composable
private fun ModelPickerDialog(
	models: List<ModelOption>,
	selectedKey: String?,
	onDismiss: () -> Unit,
	onSelect: (ModelOption) -> Unit,
) {
	var query by remember { mutableStateOf("") }
	val visible = remember(models, query) {
		if (query.isBlank()) {
			models
		} else {
			models.filter {
				it.key.contains(query, ignoreCase = true) || it.name.contains(query, ignoreCase = true)
			}
		}
	}
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("选择模型") },
		text = {
			Column {
				OutlinedTextField(
					value = query,
					onValueChange = { query = it },
					label = { Text("搜索") },
					singleLine = true,
					modifier = Modifier.fillMaxWidth(),
				)
				LazyColumn(
					modifier = Modifier
						.fillMaxWidth()
						.heightIn(max = 420.dp)
						.padding(top = 8.dp),
				) {
					items(visible, key = { it.key }) { model ->
						Row(
							modifier = Modifier
								.fillMaxWidth()
								.clickable { onSelect(model) }
								.padding(vertical = 10.dp),
							horizontalArrangement = Arrangement.SpaceBetween,
						) {
							Column(modifier = Modifier.weight(1f)) {
								Text(model.name, fontWeight = FontWeight.Medium)
								Text(model.key, style = MaterialTheme.typography.bodySmall)
							}
							if (model.key == selectedKey) {
								Text("当前", color = MaterialTheme.colorScheme.primary)
							}
						}
					}
				}
			}
		},
		confirmButton = {},
		dismissButton = {
			TextButton(onClick = onDismiss) {
				Text("关闭")
			}
		},
	)
}
