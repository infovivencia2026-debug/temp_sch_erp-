package com.schoolerp.bustracker.core

import android.util.Log

/**
 * The only place in this app that is allowed to touch [android.util.Log].
 *
 * Log lines carry counts, trip ids and outcomes. They never carry a
 * coordinate. A latitude and longitude pair in logcat is the driver's home
 * address on the evening they forgot to end a run, readable by anyone with a
 * cable, and this app exists to keep exactly that off the record.
 */
object BtLog {

    private const val TAG = "BusTracker"

    fun d(area: String, event: String) = Log.d(TAG, "$area: $event")

    fun i(area: String, event: String) = Log.i(TAG, "$area: $event")

    fun w(area: String, event: String, error: Throwable? = null) {
        if (error == null) Log.w(TAG, "$area: $event") else Log.w(TAG, "$area: $event", error)
    }

    fun e(area: String, event: String, error: Throwable? = null) {
        if (error == null) Log.e(TAG, "$area: $event") else Log.e(TAG, "$area: $event", error)
    }
}
