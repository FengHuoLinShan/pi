package dev.pi.remote.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dev.pi.remote.model.ServerConfig
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureSettingsStore(context: Context) {
	private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

	fun load(): ServerConfig? {
		val baseUrl = preferences.getString(KEY_BASE_URL, null) ?: return null
		val encryptedToken = preferences.getString(KEY_TOKEN, null) ?: return null
		return runCatching {
			ServerConfig(baseUrl = baseUrl, token = decrypt(encryptedToken))
		}.getOrNull()
	}

	fun save(config: ServerConfig) {
		preferences.edit()
			.putString(KEY_BASE_URL, config.baseUrl)
			.putString(KEY_TOKEN, encrypt(config.token))
			.apply()
	}

	fun clear() {
		preferences.edit().clear().apply()
	}

	private fun secretKey(): SecretKey {
		val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
		val existing = keyStore.getKey(KEY_ALIAS, null)
		if (existing is SecretKey) {
			return existing
		}
		val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
		generator.init(
			KeyGenParameterSpec.Builder(
				KEY_ALIAS,
				KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
			)
				.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
				.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
				.build(),
		)
		return generator.generateKey()
	}

	private fun encrypt(value: String): String {
		val cipher = Cipher.getInstance(TRANSFORMATION)
		cipher.init(Cipher.ENCRYPT_MODE, secretKey())
		val payload = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
		return Base64.encodeToString(payload, Base64.NO_WRAP)
	}

	private fun decrypt(value: String): String {
		val payload = Base64.decode(value, Base64.NO_WRAP)
		require(payload.size > IV_BYTES)
		val iv = payload.copyOfRange(0, IV_BYTES)
		val encrypted = payload.copyOfRange(IV_BYTES, payload.size)
		val cipher = Cipher.getInstance(TRANSFORMATION)
		cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
		return cipher.doFinal(encrypted).toString(Charsets.UTF_8)
	}

	private companion object {
		const val PREFERENCES_NAME = "pi_remote_secure_settings"
		const val KEY_BASE_URL = "base_url"
		const val KEY_TOKEN = "token"
		const val KEY_ALIAS = "pi_remote_gateway_token"
		const val ANDROID_KEY_STORE = "AndroidKeyStore"
		const val TRANSFORMATION = "AES/GCM/NoPadding"
		const val IV_BYTES = 12
		const val GCM_TAG_BITS = 128
	}
}
