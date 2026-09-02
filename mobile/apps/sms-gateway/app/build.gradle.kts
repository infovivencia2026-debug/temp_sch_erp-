import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

// Release signing is read from an untracked keystore.properties. Absent it, the
// release variant simply has no signing config: `assembleRelease` produces an
// unsigned APK rather than failing, and nothing secret lands in git.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

android {
    namespace = "com.schoolerp.smsgateway"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.schoolerp.smsgateway"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    /* THE SERVER, BAKED IN. Same reasoning as the bus tracker: the office is
       not going to type a URL correctly from a slip of paper, and a typo fails
       identically to a wrong password. One deployment, one address.
         ./gradlew assembleRelease -PgatewayBaseUrl=https://erp.example.in */
    val gatewayBaseUrl = (project.findProperty("gatewayBaseUrl") as String?)
        ?: "https://temperp.187-127-178-100.sslip.io"

    buildTypes {
        debug {
            /* No .debug suffix, so a debug build REPLACES the app rather than
               sitting beside it as a second icon. A school installing over USB
               or from the download page should end up with one bus tracker on
               the phone, not two that look identical and behave differently. */
            /* AGP 9 does not sign a debug build unless it is told to.

               Without this the APK carries nothing in META-INF but its own
               metadata and the phone refuses it outright with
               INSTALL_PARSE_FAILED_NO_CERTIFICATES — a build that succeeds and
               an artefact nobody can install, which reads as a broken handset
               rather than a missing line here. */
            signingConfig = signingConfigs.getByName("debug")
            // Only a debug build may talk to a plain-HTTP server, and only when
            // the operator also flips the in-app developer switch.
            buildConfigField("boolean", "ALLOW_INSECURE_HTTP", "true")
            buildConfigField("String", "DEFAULT_BASE_URL", "\"$gatewayBaseUrl\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("boolean", "ALLOW_INSECURE_HTTP", "false")
            buildConfigField("String", "DEFAULT_BASE_URL", "\"$gatewayBaseUrl\"")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        // The redaction rule is not advisory. A build that would log a message
        // body does not ship.
        abortOnError = true
        warningsAsErrors = false
        error += "SmsBodyLogged"
        checkDependencies = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "/META-INF/INDEX.LIST",
            "/META-INF/DEPENDENCIES",
        )
    }
}

// The exported Room schema is committed. A future version bump then has a real
// "before" to write a migration against, instead of a guess.
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
    arg("room.generateKotlin", "true")
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        freeCompilerArgs.addAll("-opt-in=kotlin.RequiresOptIn")
    }
}

dependencies {
    lintChecks(project(":lint-rules"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)

    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)

    implementation(libs.hilt.android)
    implementation(libs.androidx.hilt.work)
    implementation(libs.androidx.hilt.viewmodel.compose)
    ksp(libs.hilt.compiler)
    ksp(libs.androidx.hilt.compiler)

    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.serialization.kotlinx.json)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.turbine)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.ktor.client.mock)

    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.kotlinx.coroutines.test)
}
