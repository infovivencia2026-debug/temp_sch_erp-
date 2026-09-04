import java.util.Properties

// Release signing is read from an untracked keystore.properties, exactly as
// the SMS gateway does it. Absent the file the release variant simply has no
// signing config -- assembleRelease produces an unsigned APK rather than
// failing, and nothing secret lands in git.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "com.schoolerp.bustracker"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.schoolerp.bustracker"
        // 26 is where the foreground-service model this app depends on begins.
        minSdk = 26
        targetSdk = 37
        versionCode = 5
        versionName = "1.4.1"

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

    /* THE SERVER, BAKED IN.

       The pairing screen asked the driver for the school's server address.
       That is a testing affordance that shipped: a driver standing beside a
       bus at six in the morning does not know a URL, cannot be told one over
       the phone reliably, and a typo produces "that address is not usable"
       with no way to tell whether the address or the network is wrong.

       One installation, one address. It is not per-school -- every school on
       this deployment answers on the same host and the sign-in resolves which
       school from the driver's own PIN -- so there is exactly one correct
       value and the build is the place for it.

       Overridable at build time for a different deployment:
         ./gradlew assembleRelease -PtrackerBaseUrl=https://erp.example.in
    */
    val trackerBaseUrl = (project.findProperty("trackerBaseUrl") as String?)
        ?: "https://temperp.187-127-178-100.sslip.io"

    /* THE ROUTER.

       Turn-by-turn directions come from an OSRM server. The default is the
       public demo instance at project-osrm.org: it needs no key, but it is
       rate-limited, carries no uptime promise, and its own usage policy says
       it is for testing and evaluation only. It is here so the driver has
       directions today; a fleet of buses must point this at a self-hosted
       OSRM (a Docker image and an India extract is an afternoon's work):
         ./gradlew assembleRelease -PosrmBaseUrl=https://osrm.example.in
    */
    val osrmBaseUrl = (project.findProperty("osrmBaseUrl") as String?)
        ?: "https://router.project-osrm.org"

    /* THE OFFICE'S NUMBER.

       Every error sentence on the sign-in screen ends with "ask the office";
       the screen can also offer to dial it, if the deployment says what it
       is. Empty means the line is shown without a number:
         ./gradlew assembleRelease -PofficePhone=+919876543210
    */
    val officePhone = (project.findProperty("officePhone") as String?) ?: ""

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
            buildConfigField("String", "DEFAULT_BASE_URL", "\"$trackerBaseUrl\"")
            buildConfigField("String", "OSRM_BASE_URL", "\"$osrmBaseUrl\"")
            buildConfigField("String", "OFFICE_PHONE", "\"$officePhone\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            buildConfigField("boolean", "ALLOW_INSECURE_HTTP", "false")
            buildConfigField("String", "DEFAULT_BASE_URL", "\"$trackerBaseUrl\"")
            buildConfigField("String", "OSRM_BASE_URL", "\"$osrmBaseUrl\"")
            buildConfigField("String", "OFFICE_PHONE", "\"$officePhone\"")
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

    testOptions {
        unitTests.isReturnDefaultValues = true
        // Robolectric inflates the real resource table, so the unit-test
        // classpath has to carry the merged resources and AndroidManifest.
        unitTests.isIncludeAndroidResources = true
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
// "before" to write a migration against, instead of a guess -- and the "before"
// here holds a bus's unuploaded history.
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
    implementation(libs.zxing.embedded)
    implementation(libs.osmdroid)

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

    /* COMPOSE SCREENS TESTED ON THE JVM.

       These screens are worth asserting on, but an emulator in CI is not on
       the table here. Robolectric runs the real Android framework in the unit
       test JVM so createComposeRule() works without a device. 4.16.1 is the
       newest stable line and the last that ships a full set of prebuilt
       android-all images; it lags compileSdk 37, so robolectric.properties
       pins the SDK the tests actually run against. */
    testImplementation(libs.robolectric)
    // The screens' dependencies (TrackerRepository, SettingsStore, TokenStore)
    // are final Kotlin classes with no interfaces, and two of them touch the
    // keystore or a process-wide DataStore on construction. mockk's inline
    // agent can stub final classes, so the tests never build the real ones.
    testImplementation(libs.mockk)
    testImplementation(libs.androidx.test.core.ktx)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    // The empty activity ui-test-manifest supplies is merged into the debug
    // manifest, which is the one Robolectric reads for unit tests.
    debugImplementation(libs.compose.ui.test.manifest)

    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.kotlinx.coroutines.test)
}
