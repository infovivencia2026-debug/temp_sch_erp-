package com.schoolerp.parent

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.view.View
import java.io.File

/* A PICTURE OF WHERE THE PARENT WAS, TO PUT UNDER THE NEXT COLD START.

   A shell has nothing of its own to show while the bundle downloads. On a
   good connection that gap is a blink; on the mobile data a parent in
   Hanumakonda actually has it is several seconds, and every one of those
   seconds is a flat coloured rectangle. The rectangle is honest and it is
   also the thing that makes the app feel like a web page in a costume.

   So the last screen that was on the display when the app went away is kept
   as one image file, and the next cold start puts it back, dimmed, behind the
   mark and the spinner. The parent opening the app for their twice-daily
   thirty seconds sees the fee list they saw last night while the live one is
   being fetched over it. It is scenery, not data: it is dimmed so it cannot
   be mistaken for the live page, nothing on it responds to a tap, and it is
   replaced the instant the real page paints.

   WHY IT IS SAFE TO WRITE THIS DOWN, and where it stops being safe. The file
   lives in the app's private storage, alongside the WebView's own cache and
   the session cookie, which already hold far more of this family's data than
   a screenshot does. The one case where it is wrong is a parent who has
   turned the app lock on: they have asked that the portal not be visible
   without their fingerprint, and a photograph of it under the lock panel
   would be exactly that. So the lock deletes this file and nothing writes it
   again while the lock is on.

   STALENESS. A picture of a bus that was somewhere yesterday is worse than
   no picture, so anything older than the cap is deleted unseen rather than
   shown. Half a day covers the pattern this is for, which is opening the app
   again the same morning or the same evening.

   Kept at half the display's pixels: a JPEG of that is tens of kilobytes and
   decodes in a few milliseconds, and it is only ever seen at a third of its
   opacity behind other things. */
internal object LastScreen {

    private const val NAME = "last_screen.jpg"
    private const val MAX_AGE_MS = 12 * 60 * 60 * 1000L

    fun file(dir: File): File = File(dir, NAME)

    /* Drawing the view has to happen on the thread that owns it, and while it
       is still laid out, which is why this is called from onStop rather than
       from a worker. Only the compress and the write are handed off. */
    fun save(view: View, dir: File) {
        if (view.width <= 0 || view.height <= 0) return
        val shot = runCatching {
            Bitmap.createBitmap(view.width / 2, view.height / 2, Bitmap.Config.RGB_565).also {
                val canvas = Canvas(it)
                canvas.scale(0.5f, 0.5f)
                view.draw(canvas)
            }
        }.getOrNull() ?: return
        /* A background thread with no lifecycle attached to it, because the
           activity may be a moment from being killed and this is not worth
           holding it up for. If the process dies mid-write the file is
           truncated, which the decode below turns into null, which is the
           same as having no snapshot at all. */
        Thread {
            runCatching {
                val tmp = File(dir, "$NAME.tmp")
                tmp.outputStream().use { shot.compress(Bitmap.CompressFormat.JPEG, 70, it) }
                /* Written aside and renamed so a cold start can never decode a
                   half-written file and show a parent the top third of their
                   fee list over grey. */
                if (!tmp.renameTo(file(dir))) tmp.delete()
            }
            shot.recycle()
        }.start()
    }

    fun load(dir: File): Bitmap? {
        val f = file(dir)
        if (!f.exists()) return null
        if (System.currentTimeMillis() - f.lastModified() > MAX_AGE_MS) {
            f.delete()
            return null
        }
        return runCatching { BitmapFactory.decodeFile(f.path) }.getOrNull()
    }

    fun clear(dir: File) {
        runCatching { file(dir).delete() }
    }
}
