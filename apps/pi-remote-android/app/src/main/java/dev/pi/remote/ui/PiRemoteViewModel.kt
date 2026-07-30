package dev.pi.remote.ui

import android.app.Application
import android.util.Base64
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.pi.remote.data.RemoteApi
import dev.pi.remote.data.SecureSettingsStore
import dev.pi.remote.data.arrayOrEmpty
import dev.pi.remote.data.objectOrNull
import dev.pi.remote.model.ChangeItem
import dev.pi.remote.model.ChangeKind
import dev.pi.remote.model.ConnectionStatus
import dev.pi.remote.model.ImageAttachment
import dev.pi.remote.model.MainSection
import dev.pi.remote.model.ModelOption
import dev.pi.remote.model.PendingUiRequest
import dev.pi.remote.model.PiRemoteState
import dev.pi.remote.model.ServerConfig
import dev.pi.remote.model.SessionBranch
import dev.pi.remote.model.SessionMetrics
import dev.pi.remote.model.TaskItem
import dev.pi.remote.model.TaskStatus
import dev.pi.remote.model.TerminalEntry
import dev.pi.remote.model.TimelineItem
import dev.pi.remote.model.TimelineKind
import dev.pi.remote.service.PiRemoteConnectionService
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONArray
import org.json.JSONObject

class PiRemoteViewModel(application: Application) : AndroidViewModel(application) {
	private val settingsStore = SecureSettingsStore(application)
	private val mutableState = MutableStateFlow(PiRemoteState(config = settingsStore.load() ?: ServerConfig()))
	private var api: RemoteApi? = null
	private var eventJob: Job? = null

	val state: StateFlow<PiRemoteState> = mutableState.asStateFlow()

	init {
		settingsStore.load()?.let { connect(it.baseUrl, it.token) }
	}

	fun connect(baseUrl: String, token: String) {
		val config = ServerConfig(baseUrl.trim().removeSuffix("/"), token.trim())
		eventJob?.cancel()
		api?.cancelEventStream()
		mutableState.update {
			it.copy(
				config = config,
				connectionStatus = ConnectionStatus.CONNECTING,
				busy = true,
				error = null,
			)
		}
		viewModelScope.launch {
			runCatching {
				require(config.token.length >= 32) { "令牌至少需要 32 个字符" }
				val candidate = RemoteApi(config)
				val health = candidate.health()
				require(health.optInt("protocolVersion") == 1) { "不支持的远程协议版本" }
				api = candidate
				settingsStore.save(config)
				val tasks = hydrateTaskStatuses(candidate, parseTasks(candidate.instances()))
				mutableState.update {
					it.copy(
						config = config,
						connectionStatus = ConnectionStatus.CONNECTED,
						tasks = tasks,
						busy = false,
						error = null,
					)
				}
				tasks.firstOrNull(TaskItem::online)?.let { loadInstance(it.id) }
			}.onFailure { error ->
				api = null
				mutableState.update {
					it.copy(
						connectionStatus = ConnectionStatus.FAILED,
						busy = false,
						error = compactError(error, "连接失败"),
					)
				}
			}
		}
	}

	fun disconnect() {
		eventJob?.cancel()
		eventJob = null
		api?.cancelEventStream()
		api = null
		PiRemoteConnectionService.stop(getApplication())
		mutableState.update {
			PiRemoteState(
				config = it.config,
				connectionStatus = ConnectionStatus.DISCONNECTED,
			)
		}
	}

	fun clearSavedConnection() {
		disconnect()
		settingsStore.clear()
		mutableState.update { it.copy(config = ServerConfig()) }
	}

	fun selectSection(section: MainSection) {
		mutableState.update { it.copy(activeSection = section, terminalOpen = false) }
	}

	fun clearError() {
		mutableState.update { it.copy(error = null) }
	}

	fun refreshTasks() {
		val currentApi = api ?: return
		viewModelScope.launch {
			runAction {
				val listed = parseTasks(currentApi.instances(), mutableState.value.tasks)
				val tasks = hydrateTaskStatuses(currentApi, listed)
				mutableState.update { state -> state.copy(tasks = tasks) }
			}
		}
	}

	fun createTask(cwd: String, label: String, approveProject: Boolean) {
		val currentApi = api ?: return
		viewModelScope.launch {
			runAction {
				val response = currentApi.spawn(cwd.trim(), label.trim(), approveProject)
				val instance = response.objectOrNull("instance") ?: error(response.optString("error", "创建任务失败"))
				val task = parseTask(instance, emptyList())
				mutableState.update { state -> state.copy(tasks = listOf(task) + state.tasks) }
				loadInstance(task.id)
			}
		}
	}

	fun resumeTask(instanceId: String) {
		val currentApi = api ?: return
		viewModelScope.launch {
			runAction {
				val response = currentApi.resume(instanceId)
				val instance = response.objectOrNull("instance") ?: error(response.optString("error", "恢复任务失败"))
				val resumeSessionFile = response.optString("resumeSessionFile")
				require(resumeSessionFile.isNotBlank()) { "恢复任务未返回会话文件" }
				val task = parseTask(instance, emptyList())
				mutableState.update { state ->
					state.copy(tasks = listOf(task) + state.tasks.filterNot { it.id == instanceId || it.id == task.id })
				}
				try {
					loadInstance(task.id)
					val switchResponse = currentApi.command(
						task.id,
						JSONObject()
							.put("type", "switch_session")
							.put("sessionPath", resumeSessionFile),
					)
					if (!switchResponse.optBoolean("success", false)) {
						error(switchResponse.optString("error", "切换恢复会话失败"))
					}
					currentApi.stop(instanceId)
					applySnapshot(currentApi.snapshot(task.id))
				} catch (error: Throwable) {
					try {
						currentApi.stop(task.id)
					} catch (_: Throwable) {
						// Preserve the original resume error.
					}
					eventJob?.cancel()
					currentApi.cancelEventStream()
					PiRemoteConnectionService.stop(getApplication())
					mutableState.update { state ->
						state.copy(
							tasks = state.tasks.filterNot { it.id == task.id },
							selectedInstanceId = null,
							timeline = emptyList(),
							changes = emptyList(),
							pendingUiRequests = emptyList(),
						)
					}
					throw error
				}
			}
		}
	}

	fun stopTask(instanceId: String) {
		val currentApi = api ?: return
		viewModelScope.launch {
			runAction {
				currentApi.stop(instanceId)
				if (mutableState.value.selectedInstanceId == instanceId) {
					PiRemoteConnectionService.stop(getApplication())
				}
				mutableState.update { state ->
					state.copy(
						tasks = state.tasks.filterNot { it.id == instanceId },
						selectedInstanceId = state.selectedInstanceId.takeUnless { it == instanceId },
					)
				}
			}
		}
	}

	fun selectTask(instanceId: String) {
		viewModelScope.launch { runAction { loadInstance(instanceId) } }
	}

	fun setDraft(value: String) {
		mutableState.update { it.copy(draft = value) }
	}

	fun attachImage(name: String, mimeType: String, data: ByteArray) {
		if (data.size > 10 * 1024 * 1024) {
			mutableState.update { it.copy(error = "图片不能超过 10 MB") }
			return
		}
		val attachment = ImageAttachment(name, mimeType, Base64.encodeToString(data, Base64.NO_WRAP))
		mutableState.update { it.copy(imageAttachments = it.imageAttachments + attachment) }
	}

	fun removeImage(name: String) {
		mutableState.update { it.copy(imageAttachments = it.imageAttachments.filterNot { image -> image.name == name }) }
	}

	fun uploadFile(name: String, mimeType: String?, data: ByteArray) {
		val currentApi = api ?: return
		val instanceId = mutableState.value.selectedInstanceId ?: run {
			mutableState.update { it.copy(error = "请先选择任务") }
			return
		}
		viewModelScope.launch {
			runAction {
				val response = currentApi.upload(instanceId, name, mimeType, data)
				val path = response.optString("path")
				require(path.isNotBlank()) { "文件上传未返回路径" }
				mutableState.update {
					val separator = if (it.draft.isBlank()) "" else "\n"
					it.copy(draft = "${it.draft}${separator}附件文件：$path")
				}
			}
		}
	}

	fun sendPrompt(steer: Boolean = false) {
		val current = mutableState.value
		val instanceId = current.selectedInstanceId ?: return
		if (current.draft.isBlank() && current.imageAttachments.isEmpty()) {
			return
		}
		val command = JSONObject()
		if (steer) {
			command.put("type", "steer")
		} else {
			command.put("type", "prompt")
			if (current.isStreaming) {
				command.put("streamingBehavior", "followUp")
			}
		}
		command.put("message", current.draft)
		if (current.imageAttachments.isNotEmpty()) {
			val images = JSONArray()
			current.imageAttachments.forEach { image ->
				images.put(
					JSONObject()
						.put("type", "image")
						.put("data", image.dataBase64)
						.put("mimeType", image.mimeType),
				)
			}
			command.put("images", images)
		}
		mutableState.update {
			it.copy(
				timeline = it.timeline + TimelineItem(
					id = UUID.randomUUID().toString(),
					kind = TimelineKind.USER,
					title = if (steer) "转向" else "你",
					content = current.draft.ifBlank { "[图片]" },
				),
				draft = "",
				imageAttachments = emptyList(),
			)
		}
		sendCommand(instanceId, command)
	}

	fun abort() {
		mutableState.value.selectedInstanceId?.let {
			sendCommand(it, JSONObject().put("type", "abort"))
		}
	}

	fun compact() {
		mutableState.value.selectedInstanceId?.let {
			sendCommand(it, JSONObject().put("type", "compact"))
		}
	}

	fun newSession() {
		mutableState.value.selectedInstanceId?.let {
			sendCommand(it, JSONObject().put("type", "new_session"), refreshSnapshot = true)
		}
	}

	fun cloneSession() {
		mutableState.value.selectedInstanceId?.let {
			sendCommand(it, JSONObject().put("type", "clone"), refreshSnapshot = true)
		}
	}

	fun forkSession(entryId: String) {
		mutableState.value.selectedInstanceId?.let {
			sendCommand(it, JSONObject().put("type", "fork").put("entryId", entryId), refreshSnapshot = true)
		}
	}

	fun setThinkingLevel(level: String) {
		mutableState.value.selectedInstanceId?.let {
			sendCommand(
				it,
				JSONObject().put("type", "set_thinking_level").put("level", level),
				refreshSnapshot = true,
			)
		}
	}

	fun setModel(model: ModelOption) {
		mutableState.value.selectedInstanceId?.let {
			sendCommand(
				it,
				JSONObject()
					.put("type", "set_model")
					.put("provider", model.provider)
					.put("modelId", model.id),
				refreshSnapshot = true,
			)
		}
	}

	fun respondToRequest(request: PendingUiRequest, value: String? = null, confirmed: Boolean? = null) {
		val currentApi = api ?: return
		val instanceId = mutableState.value.selectedInstanceId ?: return
		val response = JSONObject()
			.put("type", "extension_ui_response")
			.put("id", request.id)
		when {
			confirmed != null -> response.put("confirmed", confirmed)
			value != null -> response.put("value", value)
			else -> response.put("cancelled", true)
		}
		viewModelScope.launch {
			runAction(setBusy = false) {
				currentApi.respondToUi(instanceId, response)
				mutableState.update { state ->
					state.copy(
						pendingUiRequests = state.pendingUiRequests.filterNot { it.id == request.id },
						changes = state.changes.map {
							if (it.approvalId == request.id) it.copy(completed = true) else it
						},
					)
				}
				updateTaskStatus(instanceId, if (mutableState.value.isStreaming) TaskStatus.RUNNING else TaskStatus.COMPLETED)
			}
		}
	}

	fun openTerminal() {
		mutableState.update { it.copy(terminalOpen = true) }
	}

	fun closeTerminal() {
		mutableState.update { it.copy(terminalOpen = false) }
	}

	fun runTerminalCommand(commandText: String) {
		val currentApi = api ?: return
		val instanceId = mutableState.value.selectedInstanceId ?: return
		val text = commandText.trim()
		if (text.isBlank()) return
		val entryId = UUID.randomUUID().toString()
		mutableState.update {
			it.copy(
				terminalEntries = it.terminalEntries + TerminalEntry(entryId, text, "", null, running = true),
			)
		}
		viewModelScope.launch {
			runCatching {
				currentApi.command(instanceId, JSONObject().put("type", "bash").put("command", text))
			}.onSuccess { response ->
				val data = response.objectOrNull("data")
				mutableState.update { state ->
					state.copy(
						terminalEntries = state.terminalEntries.map {
							if (it.id == entryId) {
								it.copy(
									output = data?.optString("output").orEmpty(),
									exitCode = data?.takeIf { value -> value.has("exitCode") }?.optInt("exitCode"),
									running = false,
									failed = response.optBoolean("success", true).not(),
								)
							} else {
								it
							}
						},
					)
				}
			}.onFailure { error ->
				mutableState.update { state ->
					state.copy(
						terminalEntries = state.terminalEntries.map {
							if (it.id == entryId) {
								it.copy(output = error.message ?: "命令失败", running = false, failed = true)
							} else {
								it
							}
						},
					)
				}
			}
		}
	}

	fun abortTerminalCommand() {
		mutableState.value.selectedInstanceId?.let {
			sendCommand(it, JSONObject().put("type", "abort_bash"))
		}
	}

	private suspend fun loadInstance(instanceId: String) {
		val currentApi = api ?: return
		eventJob?.cancel()
		currentApi.cancelEventStream()
		mutableState.update {
			it.copy(
				selectedInstanceId = instanceId,
				timeline = emptyList(),
				changes = emptyList(),
				pendingUiRequests = emptyList(),
				draft = "",
				imageAttachments = emptyList(),
				terminalEntries = emptyList(),
				terminalOpen = false,
				isStreaming = false,
				error = null,
			)
		}
		val snapshot = currentApi.snapshot(instanceId)
		applySnapshot(snapshot)
		startEventStream(currentApi, instanceId, mutableState.value.latestSequence)
		PiRemoteConnectionService.start(getApplication(), instanceId)
	}

	private suspend fun hydrateTaskStatuses(currentApi: RemoteApi, tasks: List<TaskItem>): List<TaskItem> =
		tasks.map { task ->
			if (!task.online) {
				task
			} else {
				runCatching {
					val activity = currentApi.activity(task.id)
					val stateResponse = activity.objectOrNull("state")
					val sessionState = stateResponse?.objectOrNull("data")
					val status = when {
						stateResponse?.optBoolean("success", false) != true -> TaskStatus.FAILED
						activity.arrayOrEmpty("pendingUiRequests").length() > 0 -> TaskStatus.WAITING_APPROVAL
						sessionState?.optBoolean("isStreaming") == true -> TaskStatus.RUNNING
						else -> TaskStatus.COMPLETED
					}
					task.copy(status = status)
				}.getOrElse { task }
			}
		}

	private fun startEventStream(currentApi: RemoteApi, instanceId: String, afterSequence: Long) {
		eventJob = viewModelScope.launch {
			currentApi.streamEvents(
				instanceId,
				afterSequence,
				onEvent = { event -> handleRemoteEvent(event) },
				onConnection = { connected, error ->
					mutableState.update {
						it.copy(
							connectionStatus = if (connected) {
								ConnectionStatus.CONNECTED
							} else {
								ConnectionStatus.RECONNECTING
							},
							error = if (connected) it.error else error,
						)
					}
				},
			)
		}
	}

	private fun sendCommand(instanceId: String, command: JSONObject, refreshSnapshot: Boolean = false) {
		val currentApi = api ?: return
		viewModelScope.launch {
			runAction(setBusy = false) {
				val response = currentApi.command(instanceId, command)
				if (!response.optBoolean("success", false)) {
					error(response.optString("error", "Pi 命令失败"))
				}
				if (refreshSnapshot) {
					applySnapshot(currentApi.snapshot(instanceId))
				}
			}
		}
	}

	private fun applySnapshot(snapshot: JSONObject) {
		val stateResponse = snapshot.objectOrNull("state")
		val sessionState = stateResponse?.objectOrNull("data")
		val messages = snapshot.objectOrNull("messages")
			?.objectOrNull("data")
			?.arrayOrEmpty("messages")
			?: JSONArray()
		val models = snapshot.objectOrNull("models")
			?.objectOrNull("data")
			?.arrayOrEmpty("models")
			?: JSONArray()
		val treeData = snapshot.objectOrNull("tree")?.objectOrNull("data")
		val statsData = snapshot.objectOrNull("stats")?.objectOrNull("data")
		val pending = snapshot.arrayOrEmpty("pendingUiRequests").objects().map(::parsePendingUiRequest)
		val timeline = parseMessages(messages)
		val changes = pending.map(::approvalChange)
		val selectedModel = sessionState?.objectOrNull("model")
		val isStreaming = sessionState?.optBoolean("isStreaming") ?: false
		mutableState.update { current ->
			current.copy(
				timeline = timeline,
				changes = changes,
				pendingUiRequests = pending,
				models = models.objects().mapNotNull(::parseModel),
				selectedModelKey = selectedModel?.let {
					"${it.optString("provider")}/${it.optString("id")}"
				},
				thinkingLevel = sessionState?.optString("thinkingLevel", current.thinkingLevel) ?: current.thinkingLevel,
				sessionName = sessionState?.optString("sessionName")?.takeIf(String::isNotBlank),
				sessionBranches = parseSessionTree(
					treeData?.arrayOrEmpty("tree") ?: JSONArray(),
					treeData?.optString("leafId"),
				),
				metrics = parseMetrics(statsData),
				isStreaming = isStreaming,
				isCompacting = sessionState?.optBoolean("isCompacting") ?: false,
				latestSequence = snapshot.optLong("latestSequence", current.latestSequence),
				activeSection = if (current.selectedInstanceId == null) MainSection.TASKS else current.activeSection,
			)
		}
		updateTaskStatus(
			mutableState.value.selectedInstanceId ?: return,
			when {
				pending.isNotEmpty() -> TaskStatus.WAITING_APPROVAL
				isStreaming -> TaskStatus.RUNNING
				else -> TaskStatus.COMPLETED
			},
		)
	}

	private fun handleRemoteEvent(remoteEvent: JSONObject) {
		val sequence = remoteEvent.optLong("sequence")
		val kind = remoteEvent.optString("kind")
		val payload = remoteEvent.objectOrNull("payload") ?: return
		mutableState.update { it.copy(latestSequence = maxOf(it.latestSequence, sequence)) }
		when (kind) {
			"session_event" -> handleSessionEvent(payload)
			"ui_request" -> handleUiRequest(payload)
			"ui_response" -> {
				val id = payload.optString("id")
				mutableState.update {
					it.copy(pendingUiRequests = it.pendingUiRequests.filterNot { request -> request.id == id })
				}
			}
			"rpc_response" -> handleRpcResponse(payload)
		}
	}

	private fun handleSessionEvent(event: JSONObject) {
		val instanceId = mutableState.value.selectedInstanceId ?: return
		when (event.optString("type")) {
			"agent_start" -> {
				mutableState.update { it.copy(isStreaming = true) }
				updateTaskStatus(instanceId, TaskStatus.RUNNING)
			}
			"agent_settled" -> {
				mutableState.update { it.copy(isStreaming = false) }
				updateTaskStatus(instanceId, TaskStatus.COMPLETED)
			}
			"message_update" -> handleMessageUpdate(event)
			"message_end" -> {
				val message = event.objectOrNull("message") ?: return
				val completed = parseMessage(message)
				mutableState.update {
					val withoutLive = it.timeline.filterNot { item ->
						item.id == LIVE_ANSWER_ID || item.id == LIVE_THINKING_ID
					}
					val isOptimisticDuplicate = message.optString("role") == "user" &&
						completed.isNotEmpty() &&
						withoutLive.lastOrNull()?.let { previous ->
							previous.kind == TimelineKind.USER && previous.content == completed.first().content
						} == true
					it.copy(
						timeline = if (isOptimisticDuplicate) withoutLive else withoutLive + completed,
					)
				}
			}
			"tool_execution_start" -> handleToolStart(event)
			"tool_execution_update" -> handleToolUpdate(event)
			"tool_execution_end" -> handleToolEnd(event)
			"compaction_start" -> mutableState.update { it.copy(isCompacting = true) }
			"compaction_end" -> mutableState.update { it.copy(isCompacting = false) }
			"thinking_level_changed" -> mutableState.update {
				it.copy(thinkingLevel = event.optString("level", it.thinkingLevel))
			}
			"session_info_changed" -> mutableState.update {
				it.copy(sessionName = event.optString("name").takeIf(String::isNotBlank))
			}
			"extension_error" -> {
				val message = event.optString("error", event.toString())
				addTimeline(TimelineKind.SYSTEM, "扩展错误", message, failed = true)
				updateTaskStatus(instanceId, TaskStatus.FAILED)
			}
			"auto_retry_start" -> addTimeline(
				TimelineKind.SYSTEM,
				"自动重试",
				event.optString("errorMessage"),
			)
		}
	}

	private fun handleMessageUpdate(event: JSONObject) {
		val update = event.objectOrNull("assistantMessageEvent") ?: return
		val delta = update.optString("delta")
		when (update.optString("type")) {
			"text_delta" -> appendLiveTimeline(LIVE_ANSWER_ID, TimelineKind.ANSWER, "Pi", delta)
			"thinking_delta" -> appendLiveTimeline(LIVE_THINKING_ID, TimelineKind.THINKING, "思考", delta)
			"error" -> addTimeline(TimelineKind.SYSTEM, "生成失败", update.toString(), failed = true)
		}
	}

	private fun handleToolStart(event: JSONObject) {
		val toolCallId = event.optString("toolCallId", UUID.randomUUID().toString())
		val toolName = event.optString("toolName", "tool")
		val detail = event.opt("args")?.toString().orEmpty()
		mutableState.update {
			it.copy(
				timeline = it.timeline + TimelineItem(
					id = "tool-$toolCallId",
					kind = TimelineKind.TOOL,
					title = toolName,
					content = detail,
					streaming = true,
				),
			)
		}
		if (toolName == "bash") {
			mutableState.update {
				it.copy(
					changes = it.changes + ChangeItem(
						id = "command-$toolCallId",
						kind = ChangeKind.COMMAND,
						title = "执行命令",
						detail = detail,
					),
				)
			}
		}
	}

	private fun handleToolUpdate(event: JSONObject) {
		val id = "tool-${event.optString("toolCallId")}"
		val partial = event.opt("partialResult")?.toString().orEmpty()
		mutableState.update { state ->
			state.copy(
				timeline = state.timeline.map {
					if (it.id == id) it.copy(content = partial, streaming = true) else it
				},
			)
		}
	}

	private fun handleToolEnd(event: JSONObject) {
		val callId = event.optString("toolCallId")
		val timelineId = "tool-$callId"
		val toolName = event.optString("toolName")
		val result = event.opt("result")?.toString().orEmpty()
		val failed = event.optBoolean("isError")
		mutableState.update { state ->
			state.copy(
				timeline = state.timeline.map {
					if (it.id == timelineId) it.copy(content = result, streaming = false, failed = failed) else it
				},
				changes = state.changes.map {
					if (it.id == "command-$callId") it.copy(completed = true, failed = failed) else it
				},
			)
		}
		if (toolName in FILE_TOOLS) {
			mutableState.update {
				it.copy(
					changes = it.changes + ChangeItem(
						id = "diff-$callId",
						kind = ChangeKind.DIFF,
						title = "文件变更 · $toolName",
						detail = result,
						completed = true,
						failed = failed,
					),
				)
			}
		}
	}

	private fun handleUiRequest(payload: JSONObject) {
		val request = parsePendingUiRequest(payload)
		if (request.method !in INTERACTIVE_UI_METHODS) {
			if (request.method == "notify") {
				addTimeline(TimelineKind.SYSTEM, "通知", payload.optString("message"))
			}
			return
		}
		mutableState.update {
			if (it.pendingUiRequests.any { pending -> pending.id == request.id }) {
				it
			} else {
				it.copy(
					pendingUiRequests = it.pendingUiRequests + request,
					changes = it.changes + approvalChange(request),
				)
			}
		}
		mutableState.value.selectedInstanceId?.let { updateTaskStatus(it, TaskStatus.WAITING_APPROVAL) }
	}

	private fun handleRpcResponse(payload: JSONObject) {
		if (!payload.optBoolean("success", true)) {
			mutableState.update { it.copy(error = payload.optString("error", "Pi 命令失败")) }
			return
		}
		if (payload.optString("command") == "compact") {
			mutableState.update { it.copy(isCompacting = false) }
		}
	}

	private suspend fun runAction(setBusy: Boolean = true, action: suspend () -> Unit) {
		if (setBusy) {
			mutableState.update { it.copy(busy = true, error = null) }
		}
		runCatching { action() }
			.onFailure { error -> mutableState.update { it.copy(error = compactError(error, "操作失败")) } }
		if (setBusy) {
			mutableState.update { it.copy(busy = false) }
		}
	}

	private fun updateTaskStatus(instanceId: String, status: TaskStatus) {
		mutableState.update { state ->
			state.copy(
				tasks = state.tasks.map {
					if (it.id == instanceId) it.copy(status = status) else it
				},
			)
		}
	}

	private fun appendLiveTimeline(id: String, kind: TimelineKind, title: String, delta: String) {
		if (delta.isEmpty()) return
		mutableState.update { state ->
			val existing = state.timeline.firstOrNull { it.id == id }
			state.copy(
				timeline = if (existing == null) {
					state.timeline + TimelineItem(id, kind, title, delta, streaming = true)
				} else {
					state.timeline.map {
						if (it.id == id) it.copy(content = it.content + delta, streaming = true) else it
					}
				},
			)
		}
	}

	private fun addTimeline(kind: TimelineKind, title: String, content: String, failed: Boolean = false) {
		mutableState.update {
			it.copy(
				timeline = it.timeline + TimelineItem(
					id = UUID.randomUUID().toString(),
					kind = kind,
					title = title,
					content = content,
					failed = failed,
				),
			)
		}
	}

	override fun onCleared() {
		eventJob?.cancel()
		api?.cancelEventStream()
		super.onCleared()
	}

	private companion object {
		const val LIVE_ANSWER_ID = "live-answer"
		const val LIVE_THINKING_ID = "live-thinking"
		val INTERACTIVE_UI_METHODS = setOf("select", "confirm", "input", "editor")
		val FILE_TOOLS = setOf("edit", "write", "apply_patch")
	}
}

private fun parseTasks(response: JSONObject, previous: List<TaskItem> = emptyList()): List<TaskItem> =
	response.arrayOrEmpty("instances")
		.objects()
		.map { parseTask(it, previous) }
		.sortedByDescending(TaskItem::online)

private fun parseTask(value: JSONObject, previous: List<TaskItem>): TaskItem {
	val id = value.optString("id")
	val existing = previous.firstOrNull { it.id == id }
	val remoteStatus = value.optString("status")
	val online = remoteStatus == "online"
	val status = when (remoteStatus) {
		"starting" -> TaskStatus.RUNNING
		"error" -> TaskStatus.FAILED
		"online" -> existing?.status ?: TaskStatus.COMPLETED
		else -> TaskStatus.COMPLETED
	}
	return TaskItem(
		id = id,
		label = value.optString("label").takeIf(String::isNotBlank) ?: value.optString("sessionId", "Pi"),
		cwd = value.optString("cwd"),
		status = status,
		online = online,
		sessionId = value.optString("sessionId").takeIf(String::isNotBlank),
		sessionFile = value.optString("sessionFile").takeIf(String::isNotBlank),
		lastSeenAt = value.optString("lastSeenAt").takeIf(String::isNotBlank),
	)
}

private fun parsePendingUiRequest(value: JSONObject): PendingUiRequest =
	PendingUiRequest(
		id = value.optString("id"),
		method = value.optString("method"),
		title = value.optString("title", "需要操作"),
		message = value.optString("message"),
		options = value.arrayOrEmpty("options").strings(),
		placeholder = value.optString("placeholder"),
		prefill = value.optString("prefill"),
	)

private fun approvalChange(request: PendingUiRequest): ChangeItem =
	ChangeItem(
		id = "approval-${request.id}",
		kind = ChangeKind.APPROVAL,
		title = request.title,
		detail = request.message.ifBlank {
			when (request.method) {
				"select" -> request.options.joinToString()
				"input" -> request.placeholder
				"editor" -> request.prefill
				else -> "等待手机端响应"
			}
		},
		approvalId = request.id,
	)

private fun parseModel(value: JSONObject): ModelOption? {
	val provider = value.optString("provider")
	val id = value.optString("id")
	if (provider.isBlank() || id.isBlank()) return null
	return ModelOption(provider, id, value.optString("name", id))
}

private fun parseMetrics(value: JSONObject?): SessionMetrics {
	val tokens = value?.objectOrNull("tokens")
	val context = value?.objectOrNull("contextUsage")
	return SessionMetrics(
		contextTokens = context?.optLong("tokens") ?: tokens?.optLong("total") ?: 0,
		inputTokens = tokens?.optLong("input") ?: 0,
		outputTokens = tokens?.optLong("output") ?: 0,
		cost = value?.optDouble("cost") ?: 0.0,
	)
}

private fun parseSessionTree(tree: JSONArray, leafId: String?): List<SessionBranch> {
	val branches = mutableListOf<SessionBranch>()
	fun visit(nodes: JSONArray, depth: Int) {
		nodes.objects().forEach { node ->
			val entry = node.objectOrNull("entry") ?: return@forEach
			val id = entry.optString("id")
			val label = node.optString("label").takeIf(String::isNotBlank)
				?: entry.optString("type", "entry")
			branches += SessionBranch(id, label, depth, id == leafId)
			visit(node.arrayOrEmpty("children"), depth + 1)
		}
	}
	visit(tree, 0)
	return branches
}

private fun parseMessages(messages: JSONArray): List<TimelineItem> =
	messages.objects().flatMap(::parseMessage)

private fun parseMessage(message: JSONObject): List<TimelineItem> {
	val role = message.optString("role")
	val content = message.opt("content")
	val blocks = when (content) {
		is JSONArray -> content.objects().mapNotNull { block ->
			val text = block.optString("text").ifBlank {
				when (block.optString("type")) {
					"thinking" -> block.optString("thinking")
					"toolCall" -> "${block.optString("name")}\n${block.opt("arguments") ?: ""}"
					"image" -> "[图片]"
					else -> block.optString("content")
				}
			}
			if (text.isBlank()) null else block.optString("type") to text
		}
		is String -> listOf("text" to content)
		else -> emptyList()
	}
	return blocks.map { (type, text) ->
		val kind = when {
			role == "user" -> TimelineKind.USER
			role == "toolResult" -> TimelineKind.TOOL
			type == "thinking" -> TimelineKind.THINKING
			type == "toolCall" -> TimelineKind.TOOL
			else -> TimelineKind.ANSWER
		}
		TimelineItem(
			id = UUID.randomUUID().toString(),
			kind = kind,
			title = when (kind) {
				TimelineKind.USER -> "你"
				TimelineKind.THINKING -> "思考"
				TimelineKind.TOOL -> "工具"
				else -> "Pi"
			},
			content = text,
		)
	}
}

private fun JSONArray.objects(): List<JSONObject> =
	(0 until length()).mapNotNull { optJSONObject(it) }

private fun JSONArray.strings(): List<String> =
	(0 until length()).mapNotNull { optString(it).takeIf(String::isNotBlank) }

private fun compactError(error: Throwable, fallback: String): String {
	val firstLine = error.message
		?.lineSequence()
		?.firstOrNull()
		?.trim()
		.orEmpty()
	return firstLine.ifBlank { fallback }.take(240)
}
