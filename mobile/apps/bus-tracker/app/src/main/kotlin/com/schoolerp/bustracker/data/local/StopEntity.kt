package com.schoolerp.bustracker.data.local

import androidx.room.Entity
import androidx.room.Index

/**
 * A stop on the open run, with the geofence radius the server sent with it.
 *
 * Kept on disk rather than in the service's memory for the reason the stop list
 * travels with the trip at all: the bus goes through a dead zone, the process
 * gets killed on the far side of it, and the phone must still be able to tell
 * the driver it has reached Anna Nagar without asking anyone.
 *
 * `arrivedAtMillis` is a local observation only. Arrivals are the server's
 * verdict — it walks the geofences itself when the fixes land — so this is what
 * the driver sees on the screen now, not a second source of truth.
 */
@Entity(
    tableName = "trip_stop",
    primaryKeys = ["tripId", "stopId"],
    indices = [Index(value = ["tripId", "sequence"])],
)
data class StopEntity(
    val tripId: String,
    val stopId: String,
    val name: String,
    val sequence: Int,
    val latitude: Double?,
    val longitude: Double?,
    val geofenceM: Int,
    val scheduledAt: String?,
    val arrivedAtMillis: Long? = null,
)
