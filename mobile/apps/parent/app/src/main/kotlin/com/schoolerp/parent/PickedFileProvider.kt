package com.schoolerp.parent

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File

/* A CONTENT URI FOR THE PHOTO THE PARENT IS ABOUT TO TAKE, AND NOTHING ELSE.

   This exists for one reason. A parent uploading a document almost always
   photographs it rather than finds a file, so the file chooser has to be able
   to offer the camera. The camera app writes its full resolution JPEG to a
   Uri we hand it in EXTRA_OUTPUT, and since Android 7 that may not be a
   file:// Uri: passing one throws FileUriExposedException and takes the whole
   app down, which is a crash in the middle of the one flow this work is meant
   to fix. Without EXTRA_OUTPUT the camera hands back a thumbnail in the intent
   extras instead, a few hundred pixels wide, which is unreadable as a
   birth certificate or a bank slip and would look like the upload had worked.

   So a content:// Uri is required. The usual answer is androidx FileProvider,
   and this app deliberately has no dependencies at all: see the note in
   app/build.gradle.kts. FileProvider is about sixty lines of behaviour we
   actually need out of a library that would drag androidx.core and its whole
   version train into a build that currently resolves nothing. Those sixty
   lines are below instead.

   It is narrower than FileProvider on purpose. There is no path
   configuration, no meta-data XML, no directory traversal to get wrong: the
   only files it will ever open are the ones newImageUri created, in this app's
   own external cache directory, named by a counter it chose itself. Anything
   whose name is not one this class would have produced is refused before a
   descriptor is opened, so a malicious Uri cannot walk out of that directory
   even if the grant leaked. The provider is not exported; access is only ever
   the short lived, per Uri grant the camera intent carries.
*/
class PickedFileProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    /* The camera and the picker both ask what they are dealing with before
       they touch it, and a camera app that gets null here will sometimes
       decide the destination is unwritable and silently fall back to its own
       gallery, which loses the photo. */
    override fun getType(uri: Uri): String = "image/jpeg"

    /* DocumentsUI and several camera apps read DISPLAY_NAME and SIZE and show
       them to the parent before saving. Returning an empty cursor leaves them
       showing a blank name, and a few of them treat that as a fault. */
    override fun query(
        uri: Uri,
        projection: Array<String>?,
        selection: String?,
        selectionArgs: Array<String>?,
        sortOrder: String?,
    ): Cursor? {
        val file = resolve(uri) ?: return null
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val row = arrayOfNulls<Any>(columns.size)
        columns.forEachIndexed { i, column ->
            row[i] = when (column) {
                OpenableColumns.DISPLAY_NAME -> file.name
                OpenableColumns.SIZE -> file.length()
                else -> null
            }
        }
        return MatrixCursor(columns, 1).apply { addRow(row) }
    }

    /* "rw" rather than "r": the camera has to be able to write into it. The
       mode string the caller sends is honoured rather than assumed, because a
       camera app that asks for "w" and is handed a read only descriptor fails
       with an IOException it usually reports as "could not save photo". */
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        val file = resolve(uri) ?: return null
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<String>?,
    ): Int = 0

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int = 0

    /* The whole of the security story. A Uri names exactly one file, in one
       directory, and only if its name matches the shape newImageUri produces.
       No "..", no absolute paths, no subdirectories. */
    private fun resolve(uri: Uri): File? {
        val name = uri.lastPathSegment ?: return null
        if (!NAME.matches(name)) return null
        val dir = dir(context ?: return null)
        return File(dir, name)
    }

    companion object {
        private val NAME = Regex("""^capture-\d+\.jpg$""")

        /* Authority is derived from the application id rather than written
           out, so it cannot drift from the one the manifest declares. */
        private fun authority(context: Context): String = context.packageName + ".picked"

        /* External cache, not files. It is app private on every API this
           builds for, it needs no storage permission, and the system reclaims
           it under disk pressure. These photographs are in flight to the
           server and are worthless the moment the upload finishes; keeping
           them anywhere durable would be quietly filling a parent's phone
           with copies of documents they already sent. */
        private fun dir(context: Context): File =
            File(context.externalCacheDir ?: context.cacheDir, "captures").apply { mkdirs() }

        /* A fresh name every time. Reusing one filename meant a retaken photo
           could be served from a stale descriptor the previous attempt still
           held open, so the parent uploaded the picture they had just
           rejected. */
        fun newImageUri(context: Context): Uri? = runCatching {
            sweep(context)
            val file = File(dir(context), "capture-${System.currentTimeMillis()}.jpg")
            file.createNewFile()
            Uri.Builder()
                .scheme("content")
                .authority(authority(context))
                .appendPath(file.name)
                .build()
        }.getOrNull()

        /* Anything left from an earlier session is a photograph nobody is
           waiting for: either it was uploaded, or the parent walked away. The
           app is the only thing that will ever tidy this directory, so it has
           to do it, or a family that uploads a document a week accumulates
           them forever. */
        private fun sweep(context: Context) {
            val cutoff = System.currentTimeMillis() - 6 * 60 * 60 * 1000L
            dir(context).listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
        }
    }
}
