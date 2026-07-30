package dev.pi.remote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.pi.remote.model.ChangeItem
import dev.pi.remote.model.ChangeKind
import dev.pi.remote.model.PendingUiRequest
import dev.pi.remote.model.PiRemoteState

@Composable
fun ChangesScreen(state: PiRemoteState, viewModel: PiRemoteViewModel) {
	var activeRequest by remember { mutableStateOf<PendingUiRequest?>(null) }
	activeRequest?.let { request ->
		PendingResponseDialog(
			request = request,
			onDismiss = { activeRequest = null },
			onSubmit = { value, confirmed ->
				activeRequest = null
				viewModel.respondToRequest(request, value, confirmed)
			},
		)
	}
	if (state.selectedInstanceId == null) {
		EmptyState("未选择任务", "选择任务后查看 diff、命令和审批。")
		return
	}
	if (state.changes.isEmpty()) {
		EmptyState("暂无变更", "文件修改、命令和待审批操作会出现在这里。")
		return
	}
	LazyColumn(
		modifier = Modifier.fillMaxSize(),
		contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
		verticalArrangement = Arrangement.spacedBy(12.dp),
	) {
		items(
			state.changes.sortedBy { it.completed },
			key = { it.id },
		) { change ->
			val request = change.approvalId?.let { id ->
				state.pendingUiRequests.firstOrNull { it.id == id }
			}
			ChangeCard(
				change = change,
				request = request,
				onRespond = { activeRequest = request },
				onConfirm = { confirmed ->
					request?.let { viewModel.respondToRequest(it, confirmed = confirmed) }
				},
			)
		}
	}
}

@Composable
private fun ChangeCard(
	change: ChangeItem,
	request: PendingUiRequest?,
	onRespond: () -> Unit,
	onConfirm: (Boolean) -> Unit,
) {
	val container = when {
		change.failed -> MaterialTheme.colorScheme.errorContainer
		change.kind == ChangeKind.APPROVAL && !change.completed -> MaterialTheme.colorScheme.tertiaryContainer
		else -> MaterialTheme.colorScheme.surface
	}
	Card(
		colors = CardDefaults.cardColors(containerColor = container),
		modifier = Modifier.fillMaxWidth(),
	) {
		Column(modifier = Modifier.padding(16.dp)) {
			Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
				Text(change.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
				Text(
					when {
						change.failed -> "失败"
						change.completed -> "已完成"
						change.kind == ChangeKind.APPROVAL -> "待处理"
						else -> "执行中"
					},
					style = MaterialTheme.typography.labelMedium,
				)
			}
			if (change.detail.isNotBlank()) {
				SelectionContainer {
					Text(
						change.detail,
						style = MaterialTheme.typography.bodySmall.copy(
							fontFamily = if (change.kind in setOf(ChangeKind.DIFF, ChangeKind.COMMAND)) {
								FontFamily.Monospace
							} else {
								FontFamily.Default
							},
						),
						modifier = Modifier.padding(top = 8.dp),
					)
				}
			}
			if (change.kind == ChangeKind.DIFF) {
				Text(
					"回滚提示：先让 Pi 核对本次变更范围；客户端不会直接覆盖其他未提交修改。",
					style = MaterialTheme.typography.labelSmall,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					modifier = Modifier.padding(top = 10.dp),
				)
			}
			if (request != null && !change.completed) {
				when (request.method) {
					"confirm" -> Row(
						modifier = Modifier
							.fillMaxWidth()
							.padding(top = 12.dp),
						horizontalArrangement = Arrangement.End,
					) {
						OutlinedButton(onClick = { onConfirm(false) }) {
							Text("拒绝")
						}
						Button(
							onClick = { onConfirm(true) },
							modifier = Modifier.padding(start = 8.dp),
						) {
							Text("允许")
						}
					}
					else -> Button(
						onClick = onRespond,
						modifier = Modifier
							.fillMaxWidth()
							.padding(top = 12.dp),
					) {
						Text("响应")
					}
				}
			}
		}
	}
}

@Composable
private fun PendingResponseDialog(
	request: PendingUiRequest,
	onDismiss: () -> Unit,
	onSubmit: (value: String?, confirmed: Boolean?) -> Unit,
) {
	var value by remember(request.id) { mutableStateOf(request.prefill) }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text(request.title) },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
				if (request.message.isNotBlank()) {
					Text(request.message)
				}
				when (request.method) {
					"select" -> request.options.forEach { option ->
						OutlinedButton(
							onClick = { onSubmit(option, null) },
							modifier = Modifier.fillMaxWidth(),
						) {
							Text(option)
						}
					}
					"input", "editor" -> OutlinedTextField(
						value = value,
						onValueChange = { value = it },
						label = { Text(request.placeholder.ifBlank { "输入内容" }) },
						minLines = if (request.method == "editor") 5 else 1,
						maxLines = if (request.method == "editor") 12 else 3,
						modifier = Modifier.fillMaxWidth(),
					)
				}
			}
		},
		confirmButton = {
			if (request.method == "input" || request.method == "editor") {
				TextButton(onClick = { onSubmit(value, null) }) {
					Text("提交")
				}
			}
		},
		dismissButton = {
			TextButton(onClick = { onSubmit(null, null) }) {
				Text("取消请求")
			}
		},
	)
}
