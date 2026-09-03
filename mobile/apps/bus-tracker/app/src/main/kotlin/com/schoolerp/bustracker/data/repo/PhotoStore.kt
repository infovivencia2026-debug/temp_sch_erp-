package com.schoolerp.bustracker.data.repo

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.schoolerp.bustracker.core.BtLog
import com.schoolerp.bustracker.data.remote.ApiFailure
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A child's photo, fetched once and kept on disk under the app's own cache.
 *
 * The card shows it so a relief driver on an unfamiliar route can match a
 * face to a name at the stop. A photo is fetched the first time a card is
 * drawn, which is usually before the bus reaches the first stop and while
 * there is still signal; in a dead zone the card falls back to initials. The
 * cache is cleared when the phone is unpaired: the photos belong to a school
 * this phone no longer speaks to.
 */
@Singleton
class PhotoStore @Inject constructor(
    @param:ApplicationContext private val context: Context,
    private val repository: TrackerRepository,
) {
    private val dir: File get() = File(context.cacheDir, "student-photos").apply { mkdirs() }

    /** Fetched at most once per id per process; a miss is not retried until restart. */
    private val missing = HashSet<String>()
    private val lock = Mutex()

    suspend fun load(studentId: String): Bitmap? = withContext(Dispatchers.IO) {
        val file = File(dir, "$studentId.img")
        if (file.exists()) return@withContext decode(file)
        lock.withLock {
            if (studentId in missing) return@withLock null
            val bytes = try {
                repository.fetchStudentPhoto(studentId)
            } catch (failure: ApiFailure) {
                BtLog.w("photo", "could not fetch $studentId: ${failure.reason}")
                return@withLock null
            }
            if (bytes == null || bytes.isEmpty()) {
                missing += studentId
                return@withLock null
            }
            file.writeBytes(bytes)
            decode(file)
        }
    }

    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
        missing.clear()
    }

    private fun decode(file: File): Bitmap? {
        // Bounded decode: a 12-megapixel upload from the office is drawn at
        // 56dp, and decoding it whole would take more memory than the buffer.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= TARGET_PX && bounds.outHeight / (sample * 2) >= TARGET_PX) {
            sample *= 2
        }
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private companion object {
        const val TARGET_PX = 256
    }
}
