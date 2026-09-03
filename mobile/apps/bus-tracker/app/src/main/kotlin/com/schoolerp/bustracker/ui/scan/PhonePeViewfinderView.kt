package com.schoolerp.bustracker.ui.scan

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import com.journeyapps.barcodescanner.ViewfinderView

/*
The scan window a driver recognises from every payment app.

   ZXing's own viewfinder dims the whole frame and sweeps a red laser down it,
   which reads as a document scanner from 2011. A driver holding a phone up to
   a windscreen in the morning is looking for the one thing every UPI app has
   taught them to look for: a bright square with corner brackets, and the code
   goes inside it. This draws exactly that -- a centred rounded window, the
   rest of the frame dimmed, four white corner brackets, and no laser -- so the
   gesture is the one their hands already know.

   Cosmetic only: the decoder reads the whole preview, so the box guides the
   eye without narrowing what can be scanned. That is deliberate -- a sticker
   held slightly off-centre in a hurry still scans.
*/
class PhonePeViewfinderView(context: Context, attrs: AttributeSet?) :
    ViewfinderView(context, attrs) {

    private val dim = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x99000000.toInt() }
    private val corner = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = dp(4f)
        strokeCap = Paint.Cap.ROUND
    }
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x33FFFFFF
        style = Paint.Style.STROKE
        strokeWidth = dp(1.5f)
    }

    private fun dp(v: Float) = v * resources.displayMetrics.density

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()

        // A centred square, a little wider than tall of the frame's short side.
        val side = minOf(w, h) * 0.66f
        val left = (w - side) / 2f
        val top = (h - side) / 2f
        val right = left + side
        val bottom = top + side
        val box = RectF(left, top, right, bottom)
        val radius = dp(22f)

        // Dim everything outside the window, in four bands so the window stays
        // clear without a second transparent layer.
        canvas.drawRect(0f, 0f, w, top, dim)
        canvas.drawRect(0f, bottom, w, h, dim)
        canvas.drawRect(0f, top, left, bottom, dim)
        canvas.drawRect(right, top, w, bottom, dim)

        // A faint full outline, then the four brackets that read as "aim here".
        canvas.drawRoundRect(box, radius, radius, edge)

        val arm = side * 0.16f
        // top-left
        canvas.drawLine(left, top + radius, left, top + radius + arm, corner)
        canvas.drawLine(left + radius, top, left + radius + arm, top, corner)
        // top-right
        canvas.drawLine(right, top + radius, right, top + radius + arm, corner)
        canvas.drawLine(right - radius, top, right - radius - arm, top, corner)
        // bottom-left
        canvas.drawLine(left, bottom - radius, left, bottom - radius - arm, corner)
        canvas.drawLine(left + radius, bottom, left + radius + arm, bottom, corner)
        // bottom-right
        canvas.drawLine(right, bottom - radius, right, bottom - radius - arm, corner)
        canvas.drawLine(right - radius, bottom, right - radius - arm, bottom, corner)
    }
}
