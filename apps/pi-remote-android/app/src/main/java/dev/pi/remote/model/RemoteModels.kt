package dev.pi.remote.model

data class ServerConfig(
	val baseUrl: String = "http://127.0.0.1:8787",
	val token: String = "",
)

enum class ConnectionStatus {
	DISCONNECTED,
	CONNECTING,
	CONNECTED,
	RECONNECTING,
	FAILED,
}

enum class MainSection(val label: String) {
	TASKS("任务"),
	TIMELINE("对话"),
	CHANGES("变更"),
	CONTROL("控制"),
}

enum class TaskStatus(val label: String) {
	RUNNING("运行中"),
	WAITING_APPROVAL("等待审批"),
	COMPLETED("已完成"),
	FAILED("失败"),
}

data class TaskItem(
	val id: String,
	val label: String,
	val cwd: String,
	val status: TaskStatus,
	val online: Boolean,
	val sessionId: String? = null,
	val sessionFile: String? = null,
	val lastSeenAt: String? = null,
)

enum class TimelineKind {
	USER,
	ANSWER,
	THINKING,
	TOOL,
	FILE,
	SYSTEM,
}

data class TimelineItem(
	val id: String,
	val kind: TimelineKind,
	val title: String,
	val content: String,
	val timestamp: Long = System.currentTimeMillis(),
	val streaming: Boolean = false,
	val failed: Boolean = false,
)

enum class ChangeKind {
	DIFF,
	COMMAND,
	APPROVAL,
	ROLLBACK,
}

data class ChangeItem(
	val id: String,
	val kind: ChangeKind,
	val title: String,
	val detail: String,
	val approvalId: String? = null,
	val completed: Boolean = false,
	val failed: Boolean = false,
)

data class PendingUiRequest(
	val id: String,
	val method: String,
	val title: String,
	val message: String = "",
	val options: List<String> = emptyList(),
	val placeholder: String = "",
	val prefill: String = "",
)

data class ModelOption(
	val provider: String,
	val id: String,
	val name: String,
) {
	val key: String
		get() = "$provider/$id"
}

data class SessionBranch(
	val entryId: String,
	val label: String,
	val depth: Int,
	val isLeaf: Boolean,
)

data class ImageAttachment(
	val name: String,
	val mimeType: String,
	val dataBase64: String,
)

data class TerminalEntry(
	val id: String,
	val command: String,
	val output: String,
	val exitCode: Int?,
	val running: Boolean = false,
	val failed: Boolean = false,
)

data class SessionMetrics(
	val contextTokens: Long = 0,
	val inputTokens: Long = 0,
	val outputTokens: Long = 0,
	val cost: Double = 0.0,
)

data class PiRemoteState(
	val config: ServerConfig = ServerConfig(),
	val connectionStatus: ConnectionStatus = ConnectionStatus.DISCONNECTED,
	val activeSection: MainSection = MainSection.TASKS,
	val tasks: List<TaskItem> = emptyList(),
	val selectedInstanceId: String? = null,
	val timeline: List<TimelineItem> = emptyList(),
	val changes: List<ChangeItem> = emptyList(),
	val pendingUiRequests: List<PendingUiRequest> = emptyList(),
	val models: List<ModelOption> = emptyList(),
	val selectedModelKey: String? = null,
	val thinkingLevel: String = "medium",
	val sessionName: String? = null,
	val sessionBranches: List<SessionBranch> = emptyList(),
	val metrics: SessionMetrics = SessionMetrics(),
	val draft: String = "",
	val imageAttachments: List<ImageAttachment> = emptyList(),
	val isStreaming: Boolean = false,
	val isCompacting: Boolean = false,
	val latestSequence: Long = 0,
	val terminalEntries: List<TerminalEntry> = emptyList(),
	val terminalOpen: Boolean = false,
	val busy: Boolean = false,
	val error: String? = null,
)
