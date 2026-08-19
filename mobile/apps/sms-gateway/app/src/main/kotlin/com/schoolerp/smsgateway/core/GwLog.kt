package com.schoolerp.smsgateway.core

import android.util.Log

/**
 * The only place in this app that is allowed to touch [android.util.Log].
 *
 * Every other file goes through these functions, and the custom lint check
 * `SmsBodyLogged` fails the build if a log call anywhere mentions a message
 * body. Log lines carry message ids and outcomes. They never carry a
 * recipient's number or a message body: those are a child's name, a fee
 * amount, or an absence notice, and logcat on a shared handset is readable by
 * anyone with a cable.
 */
object GwLog {

    private const val TAG = "SmsGateway"

    fun d(area: String, event: String) = Log.d(TAG, "$area: $event")

    fun i(area: String, event: String) = Log.i(TAG, "$area: $event")

    fun w(area: String, event: String, error: Throwable? = null) {
        if (error == null) Log.w(TAG, "$area: $event") else Log.w(TAG, "$area: $event", error)
    }

    fun e(area: String, event: String, error: Throwable? = null) {
        if (error == null) Log.e(TAG, "$area: $event") else Log.e(TAG, "$area: $event", error)
    }

    /**
     * Phone numbers are identifying too. When one has to appear in a log line
     * at all, it appears like this: `+9198…3021`.
     */
    fun maskNumber(number: String): String {
        val trimmed = number.trim()
        if (trimmed.length <= 8) return "*".repeat(trimmed.length)
        return trimmed.take(5) + "…" + trimmed.takeLast(3)
    }
}
