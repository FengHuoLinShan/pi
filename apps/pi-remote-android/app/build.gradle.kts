plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
}

android {
	namespace = "dev.pi.remote"
	compileSdk = 34

	defaultConfig {
		applicationId = "dev.pi.remote"
		minSdk = 26
		targetSdk = 34
		versionCode = 1
		versionName = "0.1.0"

		testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
		vectorDrawables.useSupportLibrary = true
	}

	buildTypes {
		release {
			isMinifyEnabled = true
			proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}
	kotlinOptions {
		jvmTarget = "17"
	}
	buildFeatures {
		compose = true
		buildConfig = true
	}
	composeOptions {
		kotlinCompilerExtensionVersion = "1.5.8"
	}
	packaging {
		resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
	}
}

dependencies {
	implementation(platform("androidx.compose:compose-bom:2024.02.00"))
	implementation("androidx.activity:activity-compose:1.8.2")
	implementation("androidx.compose.ui:ui")
	implementation("androidx.compose.ui:ui-tooling-preview")
	implementation("androidx.compose.material3:material3")
	implementation("androidx.lifecycle:lifecycle-runtime-compose:2.7.0")
	implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
	implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

	debugImplementation("androidx.compose.ui:ui-tooling")
}
