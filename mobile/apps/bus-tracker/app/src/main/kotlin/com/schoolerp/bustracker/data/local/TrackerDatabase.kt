package com.schoolerp.bustracker.data.local

import androidx.room.AutoMigration
import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [FixEntity::class, StopEntity::class, StudentEntity::class],
    version = 2,
    exportSchema = true,
    // 1 -> 2 adds the roster table and nothing else. Automatic, so a phone
    // updated mid-run keeps the fixes it is holding for that run.
    autoMigrations = [AutoMigration(from = 1, to = 2)],
)
abstract class TrackerDatabase : RoomDatabase() {
    abstract fun fixes(): FixDao
    abstract fun stops(): StopDao
    abstract fun students(): StudentDao

    companion object {
        const val NAME = "bus-tracker.db"
    }
}
