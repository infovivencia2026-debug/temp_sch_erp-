package com.schoolerp.smsgateway.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

@Database(
    entities = [MessageEntity::class],
    version = 1,
    exportSchema = true,
)
@TypeConverters(MessageStateConverter::class)
abstract class GatewayDatabase : RoomDatabase() {
    abstract fun messages(): MessageDao

    companion object {
        const val NAME = "sms-gateway.db"
    }
}
