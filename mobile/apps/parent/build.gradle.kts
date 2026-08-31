plugins {
    alias(libs.plugins.android.application) apply false
    /* Declared here and applied nowhere.

       AGP 9 provides Kotlin itself and refuses the plugin in a module, but it
       still resolves a kotlin-gradle-plugin of its own choosing -- 2.2.10,
       which this machine has never downloaded. Naming the version the other
       apps already use pins it to the one in the cache, so an offline build
       works here exactly as it does for the tracker. */
    alias(libs.plugins.kotlin.android) apply false
}
