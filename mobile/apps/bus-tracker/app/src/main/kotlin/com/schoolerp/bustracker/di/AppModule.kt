package com.schoolerp.bustracker.di

import android.content.Context
import androidx.room.Room
import com.schoolerp.bustracker.BuildConfig
import com.schoolerp.bustracker.core.SystemTimeSource
import com.schoolerp.bustracker.core.TimeSource
import com.schoolerp.bustracker.data.local.FixDao
import com.schoolerp.bustracker.data.local.StopDao
import com.schoolerp.bustracker.data.local.StudentDao
import com.schoolerp.bustracker.data.local.TrackerDatabase
import com.schoolerp.bustracker.data.remote.OsrmApi
import com.schoolerp.bustracker.data.remote.TrackerApi
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import javax.inject.Qualifier
import javax.inject.Singleton

/** A scope that outlives any one screen, service or broadcast. */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class ApplicationScope

/** True only in a debug build. Gates whether `http://` may ever be accepted. */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class AllowInsecureHttpBuild

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    @ApplicationScope
    fun applicationScope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Provides
    @Singleton
    fun timeSource(): TimeSource = SystemTimeSource

    @Provides
    @AllowInsecureHttpBuild
    fun allowInsecureHttpBuild(): Boolean = BuildConfig.ALLOW_INSECURE_HTTP

    @Provides
    @Singleton
    fun json(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }

    /**
     * Note what is *not* installed: Ktor's `Logging` plugin. It would print
     * request bodies to logcat, and a request body here is a list of exactly
     * where a bus full of children has been, minute by minute. There is no
     * debug-only exception, because a debug build is what runs on the bench
     * next to a real route.
     */
    @Provides
    @Singleton
    fun httpClient(json: Json): HttpClient = HttpClient(OkHttp) {
        expectSuccess = false
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) {
            connectTimeoutMillis = 15_000
            // A 200-fix catch-up batch over a two-bar rural connection is slow
            // and still worth waiting for; losing it costs the dead zone twice.
            socketTimeoutMillis = 60_000
            requestTimeoutMillis = 90_000
        }
    }

    @Provides
    @Singleton
    fun trackerApi(client: HttpClient, json: Json): TrackerApi = TrackerApi(client, json)

    /** The router. Same client, same JSON; only the host differs. See OsrmApi. */
    @Provides
    @Singleton
    fun osrmApi(client: HttpClient, json: Json, @ApplicationContext context: Context): OsrmApi =
        OsrmApi(client, json, BuildConfig.OSRM_BASE_URL, context.packageName)

    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context): TrackerDatabase =
        Room.databaseBuilder(context, TrackerDatabase::class.java, TrackerDatabase.NAME)
            // No fallbackToDestructiveMigration: dropping this table would throw
            // away the history of a run that is still in progress.
            .build()

    @Provides
    fun fixDao(database: TrackerDatabase): FixDao = database.fixes()

    @Provides
    fun stopDao(database: TrackerDatabase): StopDao = database.stops()

    @Provides
    fun studentDao(database: TrackerDatabase): StudentDao = database.students()
}
