package com.schoolerp.bustracker.data.local

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [FixEntity::class, StopEntity::class],
    version = 1,
    exportSchema = true,
)
abstract class TrackerDatabase : RoomDatabase() {
    abstract fun fixes(): FixDao
    abstract fun stops(): StopDao

    companion object {
        const val NAME = "bus-tracker.db"
    }
}
