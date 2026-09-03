import java.util.Properties

/* THE PARENT APP.

   The portal already is the parent's whole product, it is responsive, and a
   manifest makes it installable to the home screen with its own icon. This
   exists because a school hands parents an APK: a link that has to be opened
   in Chrome and then installed from a menu is a step most families will not
   complete, and an app that can be sent over WhatsApp is one they will.

   So this is a shell around the same site, and deliberately nothing more. It
   has no login of its own, no copy of any screen and no state to fall out of
   step with the server: everything a parent sees here is the page the browser
   would have shown, which means a fix shipped this afternoon reaches every
   installed app without anybody updating anything.
*/

val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

plugins {
    // AGP 9 carries Kotlin support itself; adding the Kotlin plugin on top of
    // it is now an error rather than a redundancy.
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.schoolerp.parent"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.schoolerp.parent"
        // 24 rather than the tracker's 26: this asks nothing of the platform
        // that a 2016 phone cannot do, and the families least likely to own a
        // new handset are the ones who most need the bus on a screen.
        minSdk = 24
        targetSdk = 37
        versionCode = 1
        versionName = "1.0.0"

        /* One deployment, one address, compiled in. The tracker learned this
           the hard way: a field asking a driver for a server address is a
           field he can only get wrong, and app data survives a reinstall, so
           a typed address outlives the build that asked for it. */
        val portal = (project.findProperty("portalUrl") as String?)
            ?: "https://temperp.187-127-178-100.sslip.io"
        buildConfigField("String", "PORTAL_URL", "\"$portal\"")

        /* THE SAME HOST, FOR THE DEEP LINK FILTER.

           AndroidManifest declares android:host="${portalHost}" so an app link
           cannot drift from the address the WebView actually loads. The
           manifest merger refuses a placeholder nobody supplies, which is the
           right failure: it stopped the build rather than shipping an app
           whose link filter matched a host we no longer serve. Derived from
           the same portalUrl above, so the two cannot disagree. */
        manifestPlaceholders["portalHost"] =
            portal.substringAfter("://").substringBefore("/").substringBefore(":")
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
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlin {
        jvmToolchain(17)
    }
}

/* NO DEPENDENCIES AT ALL.

   A WebView shell needs nothing from AndroidX: the platform has had WebView,
   Activity and the view classes since long before minSdk 24. Dropping them
   takes the APK to a few hundred kilobytes, removes every transitive version
   this app would otherwise have to keep in step with the tracker's, and
   sidesteps a Gradle dependency-resolution fault on this toolchain that no
   amount of flags would settle.

   It also makes the honest point about what this app is. If it needed a
   dependency, it would be doing something, and it should not be. */
dependencies {
}
