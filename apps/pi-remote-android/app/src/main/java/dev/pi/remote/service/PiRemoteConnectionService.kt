package dev.pi.remote.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import dev.pi.remote.MainActivity
import dev.pi.remote.data.RemoteApi
import dev.pi.remote.data.SecureSettingsStore
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

class PiRemoteConnectionService : Service() {
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
	private val notificationIds = AtomicInteger(EVENT_NOTIFICATION_ID)
	private var streamJob: Job? = null
	private var api: RemoteApi? = null

	override fun onCreate() {
		super.onCreate()
		createNotificationChannel()
		startForeground(
			ONGOING_NOTIFICATION_ID,
			buildNotification("Pi Remote", "正在准备后台连接", ongoing = true),
		)
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		if (intent?.action == ACTION_STOP) {
			stopConnection()
			stopSelf()
			return START_NOT_STICKY
		}
		val instanceId = intent?.getStringExtra(EXTRA_INSTANCE_ID)
			?: getSharedPreferences(SERVICE_PREFERENCES, MODE_PRIVATE).getString(KEY_INSTANCE_ID, null)
		if (instanceId.isNullOrBlank()) {
			stopSelf()
			return START_NOT_STICKY
		}
		getSharedPreferences(SERVICE_PREFERENCES, MODE_PRIVATE)
			.edit()
			.putString(KEY_INSTANCE_ID, instanceId)
			.apply()
		startConnection(instanceId)
		return START_STICKY
	}

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onDestroy() {
		stopConnection()
		scope.cancel()
		super.onDestroy()
	}

	private fun startConnection(instanceId: String) {
		stopConnection()
		val config = SecureSettingsStore(this).load()
		if (config == null) {
			updateOngoing("缺少已保存的网关连接")
			return
		}
		val remoteApi = runCatching { RemoteApi(config) }.getOrElse {
			updateOngoing(it.message ?: "网关配置无效")
			return
		}
		api = remoteApi
		streamJob = scope.launch {
			var sequence = 0L
			runCatching { remoteApi.snapshot(instanceId) }
				.onSuccess { snapshot ->
					sequence = snapshot.optLong("latestSequence")
					val pending = snapshot.optJSONArray("pendingUiRequests")
					if (pending != null) {
						for (index in 0 until pending.length()) {
							pending.optJSONObject(index)?.let(::notifyUiRequest)
						}
					}
				}
				.onFailure { updateOngoing(it.message ?: "无法读取 Pi 会话") }
			remoteApi.streamEvents(
				instanceId,
				sequence,
				onEvent = ::handleEvent,
				onConnection = { connected, error ->
					updateOngoing(if (connected) "后台连接正常" else "正在重连：${error ?: "连接中断"}")
				},
			)
		}
	}

	private fun stopConnection() {
		streamJob?.cancel()
		streamJob = null
		api?.cancelEventStream()
		api = null
	}

	private fun handleEvent(event: JSONObject) {
		val payload = event.optJSONObject("payload") ?: return
		when (event.optString("kind")) {
			"ui_request" -> notifyUiRequest(payload)
			"session_event" -> when (payload.optString("type")) {
				"agent_settled" -> notifyEvent("Pi 任务已完成", "打开 App 查看最终结果")
				"extension_error" -> notifyEvent(
					"Pi 扩展执行失败",
					payload.optString("error", "打开 App 查看详情"),
				)
			}
		}
	}

	private fun notifyUiRequest(request: JSONObject) {
		if (request.optString("method") !in setOf("select", "confirm", "input", "editor")) {
			return
		}
		notifyEvent(
			"Pi 等待手机审批",
			request.optString("title", request.optString("message", "打开 App 响应")),
		)
	}

	private fun updateOngoing(detail: String) {
		notificationManager().notify(
			ONGOING_NOTIFICATION_ID,
			buildNotification("Pi Remote 已连接", detail, ongoing = true),
		)
	}

	private fun notifyEvent(title: String, detail: String) {
		notificationManager().notify(
			notificationIds.incrementAndGet(),
			buildNotification(title, detail, ongoing = false),
		)
	}

	private fun buildNotification(title: String, detail: String, ongoing: Boolean): Notification {
		val openIntent = Intent(this, MainActivity::class.java)
		val openPendingIntent = PendingIntent.getActivity(
			this,
			0,
			openIntent,
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)
		return Notification.Builder(this, CHANNEL_ID)
			.setSmallIcon(android.R.drawable.stat_notify_sync)
			.setContentTitle(title)
			.setContentText(detail.take(180))
			.setContentIntent(openPendingIntent)
			.setOngoing(ongoing)
			.setOnlyAlertOnce(ongoing)
			.setCategory(if (ongoing) Notification.CATEGORY_SERVICE else Notification.CATEGORY_MESSAGE)
			.build()
	}

	private fun createNotificationChannel() {
		val channel = NotificationChannel(
			CHANNEL_ID,
			"Pi 远程任务",
			NotificationManager.IMPORTANCE_DEFAULT,
		).apply {
			description = "Pi 连接状态、审批和任务完成通知"
		}
		notificationManager().createNotificationChannel(channel)
	}

	private fun notificationManager(): NotificationManager =
		getSystemService(NotificationManager::class.java)

	companion object {
		private const val CHANNEL_ID = "pi_remote_connection"
		private const val ONGOING_NOTIFICATION_ID = 4100
		private const val EVENT_NOTIFICATION_ID = 4200
		private const val ACTION_START = "dev.pi.remote.action.START"
		private const val ACTION_STOP = "dev.pi.remote.action.STOP"
		private const val EXTRA_INSTANCE_ID = "instance_id"
		private const val SERVICE_PREFERENCES = "pi_remote_service"
		private const val KEY_INSTANCE_ID = "instance_id"

		fun start(context: Context, instanceId: String) {
			val intent = Intent(context, PiRemoteConnectionService::class.java)
				.setAction(ACTION_START)
				.putExtra(EXTRA_INSTANCE_ID, instanceId)
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
				context.startForegroundService(intent)
			} else {
				context.startService(intent)
			}
		}

		fun stop(context: Context) {
			context.stopService(Intent(context, PiRemoteConnectionService::class.java))
		}
	}
}
