package dev.pi.remote.ui

import android.app.Activity
import android.content.Intent
import android.provider.OpenableColumns
import android.speech.RecognizerIntent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.pi.remote.model.PiRemoteState
import dev.pi.remote.model.TimelineItem
import dev.pi.remote.model.TimelineKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun TimelineScreen(state: PiRemoteState, viewModel: PiRemoteViewModel) {
	if (state.selectedInstanceId == null) {
		EmptyState("未选择任务", "先从任务列表打开一个 Pi 会话。")
		return
	}
	val listState = rememberLazyListState()
	LaunchedEffect(state.timeline.size, state.timeline.lastOrNull()?.content?.length) {
		if (state.timeline.isNotEmpty()) {
			listState.animateScrollToItem(state.timeline.lastIndex)
		}
	}
	Column(
		modifier = Modifier
			.fillMaxSize()
			.imePadding(),
	) {
		if (state.timeline.isEmpty()) {
			EmptyState(
				title = "会话已连接",
				detail = "在下方输入任务，Pi 的回答、思考和工具执行会实时显示。",
				modifier = Modifier.weight(1f),
			)
		} else {
			LazyColumn(
				state = listState,
				modifier = Modifier.weight(1f),
				contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
				verticalArrangement = Arrangement.spacedBy(10.dp),
			) {
				items(
					count = state.timeline.size,
					key = { state.timeline[it].id },
				) { index ->
					TimelineCard(state.timeline[index])
				}
			}
		}
		Composer(state, viewModel)
	}
}

@Composable
private fun TimelineCard(item: TimelineItem) {
	val isUser = item.kind == TimelineKind.USER
	val colors = CardDefaults.cardColors(
		containerColor = when (item.kind) {
			TimelineKind.USER -> MaterialTheme.colorScheme.primaryContainer
			TimelineKind.THINKING -> MaterialTheme.colorScheme.secondaryContainer
			TimelineKind.TOOL -> MaterialTheme.colorScheme.surfaceVariant
			TimelineKind.FILE -> Color(0xFFE4F4E8)
			TimelineKind.SYSTEM -> if (item.failed) {
				MaterialTheme.colorScheme.errorContainer
			} else {
				MaterialTheme.colorScheme.tertiaryContainer
			}
			TimelineKind.ANSWER -> MaterialTheme.colorScheme.surface
		},
	)
	Row(
		modifier = Modifier.fillMaxWidth(),
		horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
	) {
		Card(
			colors = colors,
			modifier = Modifier.widthIn(max = 640.dp),
		) {
			Column(modifier = Modifier.padding(14.dp)) {
				Row(
					modifier = Modifier.fillMaxWidth(),
					horizontalArrangement = Arrangement.SpaceBetween,
					verticalAlignment = Alignment.CenterVertically,
				) {
					Text(item.title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
					if (item.streaming) {
						Text("实时", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
					}
				}
				SelectionContainer {
					Text(
						item.content,
						style = MaterialTheme.typography.bodyMedium.copy(
							fontFamily = if (item.kind == TimelineKind.TOOL) FontFamily.Monospace else FontFamily.Default,
						),
						modifier = Modifier.padding(top = 6.dp),
					)
				}
			}
		}
	}
}

@Composable
private fun Composer(state: PiRemoteState, viewModel: PiRemoteViewModel) {
	val context = LocalContext.current
	val scope = rememberCoroutineScope()
	val voiceLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
		if (result.resultCode == Activity.RESULT_OK) {
			val text = result.data
				?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
				?.firstOrNull()
			if (!text.isNullOrBlank()) {
				viewModel.setDraft(
					listOf(state.draft, text)
						.filter(String::isNotBlank)
						.joinToString(" "),
				)
			}
		}
	}
	val imageLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
		if (uri != null) {
			scope.launch {
				val content = withContext(Dispatchers.IO) {
					val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
					val name = displayName(context, uri)
					val mime = context.contentResolver.getType(uri) ?: "image/*"
					Triple(name, mime, bytes)
				}
				content.third?.let { viewModel.attachImage(content.first, content.second, it) }
			}
		}
	}
	val fileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
		if (uri != null) {
			scope.launch {
				val content = withContext(Dispatchers.IO) {
					val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
					val name = displayName(context, uri)
					val mime = context.contentResolver.getType(uri)
					Triple(name, mime, bytes)
				}
				content.third?.let { viewModel.uploadFile(content.first, content.second, it) }
			}
		}
	}

	Column(
		modifier = Modifier
			.fillMaxWidth()
			.background(MaterialTheme.colorScheme.surface)
			.padding(horizontal = 12.dp, vertical = 10.dp),
	) {
		if (state.imageAttachments.isNotEmpty()) {
			Row(
				modifier = Modifier
					.fillMaxWidth()
					.horizontalScroll(rememberScrollState()),
				horizontalArrangement = Arrangement.spacedBy(8.dp),
			) {
				state.imageAttachments.forEach { image ->
					AssistChip(
						onClick = { viewModel.removeImage(image.name) },
						label = { Text("${image.name} ×") },
					)
				}
			}
		}
		OutlinedTextField(
			value = state.draft,
			onValueChange = viewModel::setDraft,
			label = { Text(if (state.isStreaming) "补充任务或发送转向" else "输入任务") },
			minLines = 2,
			maxLines = 6,
			modifier = Modifier.fillMaxWidth(),
		)
		Row(
			modifier = Modifier
				.fillMaxWidth()
				.padding(top = 8.dp),
			horizontalArrangement = Arrangement.spacedBy(6.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			TextButton(
				onClick = {
					voiceLauncher.launch(
						Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
							.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
							.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN"),
					)
				},
			) {
				Text("语音")
			}
			TextButton(onClick = { imageLauncher.launch(arrayOf("image/*")) }) {
				Text("图片")
			}
			TextButton(onClick = { fileLauncher.launch(arrayOf("*/*")) }) {
				Text("文件")
			}
			Row(
				modifier = Modifier.weight(1f),
				horizontalArrangement = Arrangement.End,
			) {
				if (state.isStreaming) {
					OutlinedButton(onClick = viewModel::abort) {
						Text("停止")
					}
					TextButton(onClick = { viewModel.sendPrompt(steer = true) }) {
						Text("转向")
					}
				}
				Button(onClick = { viewModel.sendPrompt() }) {
					Text(if (state.isStreaming) "排队" else "发送")
				}
			}
		}
	}
}

private fun displayName(context: android.content.Context, uri: Uri): String {
	context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
		if (cursor.moveToFirst()) {
			return cursor.getString(0)
		}
	}
	return uri.lastPathSegment ?: "attachment"
}
