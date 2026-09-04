package com.schoolerp.bustracker.navigation

import android.content.Context
import android.speech.tts.TextToSpeech
import com.schoolerp.bustracker.core.BtLog
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The directions, said aloud.
 *
 * A driver cannot read a banner at a junction; that is the entire reason
 * navigation apps talk. The platform's own TextToSpeech is used -- no
 * download, no key, and every Android phone ships an engine -- and it is
 * built once for the process because engine start-up takes a second or two,
 * which is exactly the second the first instruction is needed in.
 */
@Singleton
class VoiceGuide @Inject constructor(@param:ApplicationContext context: Context) {

    @Volatile private var ready = false

    private val tts: TextToSpeech = TextToSpeech(context) { status ->
        if (status == TextToSpeech.SUCCESS) {
            ready = true
            /* English is what OSRM's road names and this app's sentences are
               in. The phone's own locale first, because an Indian-English
               voice says "Kompally" better than an American one; anything
               that fails falls back to plain English rather than to silence. */
            val wanted = Locale.getDefault()
            val result = tts.setLanguage(wanted)
            if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts.setLanguage(Locale.ENGLISH)
            }
        } else {
            BtLog.w("voice", "text-to-speech unavailable: $status")
        }
    }

    fun say(text: String) {
        if (!ready) return
        // ADD, not FLUSH: "in 300 metres turn left" must not be cut off by
        // "arriving at Kompally" when the two fall on the same fix.
        tts.speak(text, TextToSpeech.QUEUE_ADD, null, "nav-${text.hashCode()}")
    }
}
