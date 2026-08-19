# kotlinx.serialization keeps generated serializers off the reflection path, but
# R8 still needs to be told the companions exist.
-keepclassmembers class ** {
    *** Companion;
}
-keepclasseswithmembers class ** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.schoolerp.smsgateway.**$$serializer { *; }
-keepclassmembers class com.schoolerp.smsgateway.** {
    *** Companion;
}

# Ktor / OkHttp
-dontwarn org.slf4j.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-keepclassmembers class io.ktor.** { volatile <fields>; }

# Room generated implementations are referenced reflectively by name.
-keep class * extends androidx.room.RoomDatabase { <init>(); }

# Never let R8 keep a synthetic toString that would defeat body redaction.
-dontnote com.schoolerp.smsgateway.**
