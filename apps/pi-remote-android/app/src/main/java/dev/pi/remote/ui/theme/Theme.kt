package dev.pi.remote.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
	primary = Color(0xFF315DA8),
	onPrimary = Color.White,
	primaryContainer = Color(0xFFD9E6FF),
	onPrimaryContainer = Color(0xFF001A42),
	secondary = Color(0xFF526078),
	secondaryContainer = Color(0xFFD6E4FF),
	background = Color(0xFFF8F9FD),
	surface = Color(0xFFFFFFFF),
	surfaceVariant = Color(0xFFE2E7F0),
	error = Color(0xFFBA1A1A),
)

private val DarkColors = darkColorScheme(
	primary = Color(0xFFA9C7FF),
	onPrimary = Color(0xFF003062),
	primaryContainer = Color(0xFF174785),
	secondary = Color(0xFFBAC7E3),
	background = Color(0xFF111318),
	surface = Color(0xFF191C20),
	surfaceVariant = Color(0xFF42474F),
)

@Composable
fun PiRemoteTheme(content: @Composable () -> Unit) {
	MaterialTheme(
		colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
		content = content,
	)
}
