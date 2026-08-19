package com.schoolerp.smsgateway.di

import android.content.Context
import androidx.room.Room
import com.schoolerp.smsgateway.BuildConfig
import com.schoolerp.smsgateway.core.SystemTimeSource
import com.schoolerp.smsgateway.core.TimeSource
import com.schoolerp.smsgateway.data.local.GatewayDatabase
import com.schoolerp.smsgateway.data.local.MessageDao
import com.schoolerp.smsgateway.data.remote.GatewayApi
import com.schoolerp.smsgateway.data.repo.GatewayRepository
import com.schoolerp.smsgateway.engine.StatusSources
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
     * request and response bodies to logcat, and the outbox response is a list
     * of children's names and fee amounts. There is no debug-only exception,
     * because a debug build is what runs on the bench next to real data.
     */
    @Provides
    @Singleton
    fun httpClient(json: Json): HttpClient = HttpClient(OkHttp) {
        expectSuccess = false
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) {
            connectTimeoutMillis = 15_000
            socketTimeoutMillis = 30_000
            requestTimeoutMillis = 45_000
        }
    }

    @Provides
    @Singleton
    fun gatewayApi(client: HttpClient): GatewayApi = GatewayApi(client)

    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context): GatewayDatabase =
        Room.databaseBuilder(context, GatewayDatabase::class.java, GatewayDatabase.NAME)
            // No fallbackToDestructiveMigration: dropping this table would throw
            // away messages the server believes are in flight, and receipts it
            // is still waiting for.
            .build()

    @Provides
    fun messageDao(database: GatewayDatabase): MessageDao = database.messages()

    /**
     * The status screen reads the repository through a narrow interface, so the
     * "why is nothing sending" logic can be unit-tested against fake flows.
     */
    @Provides
    @Singleton
    fun statusSources(repository: GatewayRepository): StatusSources = repository
}
