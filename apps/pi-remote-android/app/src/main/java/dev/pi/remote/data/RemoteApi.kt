package dev.pi.remote.data

import android.util.Base64
import dev.pi.remote.model.ServerConfig
import java.io.BufferedReader
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class RemoteApi(config: ServerConfig) {
	private val baseUrl = config.baseUrl.trim().removeSuffix("/")
	private val token = config.token

	@Volatile
	private var eventConnection: HttpURLConnection? = null

	init {
		val uri = URI(baseUrl)
		require(uri.scheme == "http" || uri.scheme == "https") { "地址必须使用 http 或 https" }
		require(!uri.host.isNullOrBlank()) { "地址缺少主机名" }
	}

	suspend fun health(): JSONObject = request("GET", "/v1/health", authenticated = false)

	suspend fun instances(): JSONObject = request("GET", "/v1/instances")

	suspend fun spawn(cwd: String, label: String, approveProject: Boolean): JSONObject {
		val body = JSONObject().put("cwd", cwd)
		if (label.isNotBlank()) {
			body.put("label", label)
		}
		body.put("approveProject", approveProject)
		return request("POST", "/v1/instances", body)
	}

	suspend fun resume(instanceId: String): JSONObject =
		request(
			"POST",
			"/v1/instances/${pathSegment(instanceId)}/resume",
			JSONObject().put("approveProject", true),
			readTimeoutMillis = LONG_RPC_TIMEOUT_MILLIS,
		)

	suspend fun stop(instanceId: String): JSONObject =
		request("DELETE", "/v1/instances/${pathSegment(instanceId)}")

	suspend fun snapshot(instanceId: String): JSONObject =
		request("GET", "/v1/instances/${pathSegment(instanceId)}/snapshot")

	suspend fun activity(instanceId: String): JSONObject =
		request("GET", "/v1/instances/${pathSegment(instanceId)}/activity")

	suspend fun command(instanceId: String, command: JSONObject): JSONObject =
		request(
			"POST",
			"/v1/instances/${pathSegment(instanceId)}/command",
			JSONObject().put("command", command),
			readTimeoutMillis = LONG_RPC_TIMEOUT_MILLIS,
		)

	suspend fun respondToUi(instanceId: String, response: JSONObject): JSONObject =
		request(
			"POST",
			"/v1/instances/${pathSegment(instanceId)}/ui-response",
			JSONObject().put("response", response),
		)

	suspend fun upload(
		instanceId: String,
		filename: String,
		mimeType: String?,
		data: ByteArray,
	): JSONObject {
		val body = JSONObject()
			.put("filename", filename)
			.put("dataBase64", Base64.encodeToString(data, Base64.NO_WRAP))
		if (!mimeType.isNullOrBlank()) {
			body.put("mimeType", mimeType)
		}
		return request("POST", "/v1/instances/${pathSegment(instanceId)}/files", body)
	}

	fun cancelEventStream() {
		eventConnection?.disconnect()
		eventConnection = null
	}

	suspend fun streamEvents(
		instanceId: String,
		afterSequence: Long,
		onEvent: (JSONObject) -> Unit,
		onConnection: (connected: Boolean, error: String?) -> Unit,
	) {
		withContext(Dispatchers.IO) {
			var nextSequence = afterSequence
			var retryDelayMillis = 1_000L
			while (currentCoroutineContext().isActive) {
				try {
					nextSequence = streamOnce(instanceId, nextSequence, onEvent, onConnection)
					retryDelayMillis = 1_000L
				} catch (error: CancellationException) {
					throw error
				} catch (error: Exception) {
					currentCoroutineContext().ensureActive()
					onConnection(false, error.message ?: "事件连接中断")
					delay(retryDelayMillis)
					retryDelayMillis = (retryDelayMillis * 2).coerceAtMost(15_000L)
				}
			}
		}
	}

	private fun streamOnce(
		instanceId: String,
		afterSequence: Long,
		onEvent: (JSONObject) -> Unit,
		onConnection: (connected: Boolean, error: String?) -> Unit,
	): Long {
		val path = "/v1/instances/${pathSegment(instanceId)}/events?after=$afterSequence"
		val connection = openConnection(path, "GET", authenticated = true)
		connection.readTimeout = 0
		eventConnection = connection
		val status = connection.responseCode
		if (status !in 200..299) {
			val message = readResponseText(connection, status)
			connection.disconnect()
			throw RemoteApiException(status, extractError(message))
		}
		onConnection(true, null)
		var latestSequence = afterSequence
		try {
			connection.inputStream.bufferedReader(StandardCharsets.UTF_8).use { reader ->
				var dataLines = mutableListOf<String>()
				while (true) {
					currentCoroutineContextBlockingCheck()
					val line = reader.readLine() ?: throw IOException("事件流已关闭")
					if (line.isEmpty()) {
						if (dataLines.isNotEmpty()) {
							val event = JSONObject(dataLines.joinToString("\n"))
							latestSequence = event.optLong("sequence", latestSequence)
							onEvent(event)
							dataLines = mutableListOf()
						}
						continue
					}
					if (line.startsWith("data:")) {
						dataLines += line.removePrefix("data:").trimStart()
					}
				}
			}
		} finally {
			if (eventConnection === connection) {
				eventConnection = null
			}
			connection.disconnect()
		}
	}

	private fun currentCoroutineContextBlockingCheck() {
		if (Thread.currentThread().isInterrupted) {
			throw CancellationException("事件流已取消")
		}
	}

	private suspend fun request(
		method: String,
		path: String,
		body: JSONObject? = null,
		authenticated: Boolean = true,
		readTimeoutMillis: Int = 60_000,
	): JSONObject = withContext(Dispatchers.IO) {
		currentCoroutineContext().ensureActive()
		val connection = openConnection(path, method, authenticated)
		connection.readTimeout = readTimeoutMillis
		if (body != null) {
			val bytes = body.toString().toByteArray(StandardCharsets.UTF_8)
			connection.doOutput = true
			connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
			connection.setFixedLengthStreamingMode(bytes.size)
			connection.outputStream.use { it.write(bytes) }
		}
		val status = connection.responseCode
		val text = readResponseText(connection, status)
		connection.disconnect()
		if (status !in 200..299) {
			throw RemoteApiException(status, extractError(text))
		}
		if (text.isBlank()) JSONObject() else JSONObject(text)
	}

	private fun openConnection(path: String, method: String, authenticated: Boolean): HttpURLConnection {
		val connection = URL("$baseUrl$path").openConnection() as HttpURLConnection
		connection.requestMethod = method
		connection.connectTimeout = 15_000
		connection.readTimeout = 60_000
		connection.useCaches = false
		connection.setRequestProperty("Accept", "application/json")
		if (authenticated) {
			connection.setRequestProperty("Authorization", "Bearer $token")
		}
		return connection
	}

	private fun readResponseText(connection: HttpURLConnection, status: Int): String {
		val stream = if (status in 200..299) connection.inputStream else connection.errorStream
		return stream?.bufferedReader(StandardCharsets.UTF_8)?.use(BufferedReader::readText).orEmpty()
	}

	private fun extractError(text: String): String =
		runCatching { JSONObject(text).optString("error") }
			.getOrNull()
			?.takeIf(String::isNotBlank)
			?: text.ifBlank { "远程请求失败" }

	private fun pathSegment(value: String): String =
		URLEncoder.encode(value, StandardCharsets.UTF_8.toString()).replace("+", "%20")
}

private const val LONG_RPC_TIMEOUT_MILLIS = 10 * 60 * 1_000

class RemoteApiException(
	val statusCode: Int,
	override val message: String,
) : IOException(message)

internal fun JSONObject.objectOrNull(name: String): JSONObject? =
	if (has(name) && !isNull(name)) optJSONObject(name) else null

internal fun JSONObject.arrayOrEmpty(name: String): JSONArray = optJSONArray(name) ?: JSONArray()
