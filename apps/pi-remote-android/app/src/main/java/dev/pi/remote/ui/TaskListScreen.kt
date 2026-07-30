package dev.pi.remote.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pi.remote.model.PiRemoteState
import dev.pi.remote.model.TaskItem
import dev.pi.remote.model.TaskStatus

@Composable
fun TaskListScreen(state: PiRemoteState, viewModel: PiRemoteViewModel) {
	var showCreate by remember { mutableStateOf(false) }
	if (showCreate) {
		CreateTaskDialog(
			onDismiss = { showCreate = false },
			onCreate = { cwd, label, approveProject ->
				showCreate = false
				viewModel.createTask(cwd, label, approveProject)
			},
		)
	}
	Column(modifier = Modifier.fillMaxSize()) {
		Row(
			modifier = Modifier
				.fillMaxWidth()
				.padding(horizontal = 16.dp, vertical = 12.dp),
			horizontalArrangement = Arrangement.spacedBy(10.dp),
		) {
			Button(onClick = { showCreate = true }, modifier = Modifier.weight(1f)) {
				Text("新建任务")
			}
			OutlinedButton(onClick = viewModel::refreshTasks) {
				Text("刷新")
			}
		}
		if (state.tasks.isEmpty()) {
			EmptyState(
				title = "还没有 Pi 任务",
				detail = "新建任务并选择本机工作目录。",
			)
		} else {
			LazyColumn(
				modifier = Modifier.fillMaxSize(),
				contentPadding = androidx.compose.foundation.layout.PaddingValues(
					start = 16.dp,
					end = 16.dp,
					bottom = 24.dp,
				),
				verticalArrangement = Arrangement.spacedBy(10.dp),
			) {
				TaskStatus.entries.forEach { status ->
					val group = state.tasks.filter { it.status == status }
					if (group.isNotEmpty()) {
						item(key = "header-$status") {
							Text(
								"${status.label} · ${group.size}",
								style = MaterialTheme.typography.titleSmall,
								color = MaterialTheme.colorScheme.onSurfaceVariant,
								modifier = Modifier.padding(top = 10.dp, bottom = 2.dp),
							)
						}
						items(group, key = { it.id }) { task ->
							TaskCard(
								task = task,
								selected = task.id == state.selectedInstanceId,
								onOpen = { viewModel.selectTask(task.id) },
								onStop = { viewModel.stopTask(task.id) },
								onResume = { viewModel.resumeTask(task.id) },
							)
						}
					}
				}
			}
		}
	}
}

@Composable
private fun TaskCard(
	task: TaskItem,
	selected: Boolean,
	onOpen: () -> Unit,
	onStop: () -> Unit,
	onResume: () -> Unit,
) {
	val container = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface
	Card(
		onClick = { if (task.online) onOpen() },
		enabled = task.online || task.sessionFile != null,
		colors = CardDefaults.cardColors(containerColor = container),
		modifier = Modifier.fillMaxWidth(),
	) {
		Column(modifier = Modifier.padding(16.dp)) {
			Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
				Text(
					task.label,
					style = MaterialTheme.typography.titleMedium,
					fontWeight = FontWeight.SemiBold,
					modifier = Modifier.weight(1f),
				)
				StatusText(task.status)
			}
			Text(
				task.cwd,
				style = MaterialTheme.typography.bodySmall,
				color = MaterialTheme.colorScheme.onSurfaceVariant,
				maxLines = 2,
				overflow = TextOverflow.Ellipsis,
				modifier = Modifier.padding(top = 6.dp),
			)
			if (!task.online) {
				Text(
					"离线记录",
					style = MaterialTheme.typography.labelMedium,
					color = MaterialTheme.colorScheme.onSurfaceVariant,
					modifier = Modifier.padding(top = 6.dp),
				)
			}
			Row(
				modifier = Modifier
					.fillMaxWidth()
					.padding(top = 10.dp),
				horizontalArrangement = Arrangement.End,
			) {
				TextButton(onClick = onStop, enabled = task.online) {
					Text("停止")
				}
				TextButton(onClick = onOpen, enabled = task.online) {
					Text("打开")
				}
				if (!task.online && task.sessionFile != null) {
					TextButton(onClick = onResume) {
						Text("恢复")
					}
				}
			}
		}
	}
}

@Composable
private fun StatusText(status: TaskStatus) {
	val color = when (status) {
		TaskStatus.RUNNING -> MaterialTheme.colorScheme.primary
		TaskStatus.WAITING_APPROVAL -> Color(0xFF9A5B00)
		TaskStatus.COMPLETED -> Color(0xFF287A45)
		TaskStatus.FAILED -> MaterialTheme.colorScheme.error
	}
	Text(status.label, color = color, style = MaterialTheme.typography.labelLarge)
}

@Composable
private fun CreateTaskDialog(onDismiss: () -> Unit, onCreate: (String, String, Boolean) -> Unit) {
	var cwd by remember { mutableStateOf("") }
	var label by remember { mutableStateOf("") }
	var approveProject by remember { mutableStateOf(false) }
	AlertDialog(
		onDismissRequest = onDismiss,
		title = { Text("新建 Pi 任务") },
		text = {
			Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
				OutlinedTextField(
					value = cwd,
					onValueChange = { cwd = it },
					label = { Text("本机工作目录") },
					placeholder = { Text("/Users/name/project") },
					singleLine = true,
					modifier = Modifier.fillMaxWidth(),
				)
				OutlinedTextField(
					value = label,
					onValueChange = { label = it },
					label = { Text("任务名称（可选）") },
					singleLine = true,
					modifier = Modifier.fillMaxWidth(),
				)
				Row(modifier = Modifier.fillMaxWidth()) {
					Checkbox(
						checked = approveProject,
						onCheckedChange = { approveProject = it },
					)
					Column(modifier = Modifier.padding(top = 10.dp)) {
						Text("信任项目内配置")
						Text(
							"加载并执行该目录中的 .pi 扩展和设置",
							style = MaterialTheme.typography.bodySmall,
							color = MaterialTheme.colorScheme.onSurfaceVariant,
						)
					}
				}
			}
		},
		confirmButton = {
			TextButton(onClick = { onCreate(cwd, label, approveProject) }, enabled = cwd.isNotBlank()) {
				Text("创建")
			}
		},
		dismissButton = {
			TextButton(onClick = onDismiss) {
				Text("取消")
			}
		},
	)
}
