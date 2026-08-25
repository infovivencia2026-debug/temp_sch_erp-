import { useCallback, useEffect, useRef, useState } from 'react'

/* Asking out loud.

   WHY THE BROWSER'S OWN RECOGNITION. The alternative is recording audio and
   posting it somewhere to be transcribed, which means a second service to run,
   a second thing that can be down, and a recording of somebody's voice leaving
   the building. The Web Speech API does the recognition on the device (or
   through the browser vendor's own service, which is the vendor's arrangement
   with the user rather than a new one this product makes), costs nothing to
   operate, and needs no key. For "how do I collect a fee" that is plenty.

   WHY IT IS OPTIONAL EVERYWHERE. Firefox does not implement it at all, and no
   browser implements it without a permission prompt. So `supported` is checked
   before anything is drawn: a microphone button that does nothing when pressed
   is worse than no microphone button, because the person presses it, waits,
   and concludes the assistant is broken.

   INTERIM RESULTS ARE SHOWN. Speech recognition takes a second or two to
   settle, and a box that stays empty while somebody is talking reads as one
   that is not listening. The interim text is deliberately put in the same input
   the keyboard writes to, so what was heard can be corrected before it is sent
   rather than after — which matters, because these are Indian school names and
   no recogniser gets "Vivencia" right first time. */

interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: SpeechRecognitionAlternativeLike
  length: number
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number; [i: number]: SpeechRecognitionResultLike }
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function ctor(): SpeechRecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  // webkit- first in practice: Chrome and Edge ship the prefixed name, and they
  // are what a school office is running.
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export interface Dictation {
  /** Whether this browser can do it at all. Draw nothing if false. */
  supported: boolean
  listening: boolean
  /** Set when the browser refuses — no permission, no network, no microphone. */
  error: string | null
  start: () => void
  stop: () => void
}

/**
 * Dictate into a text field.
 *
 * `onText` receives the transcript as it settles, with `final` saying whether
 * this is the recogniser's last word on it. The caller decides what to do with
 * an interim result; this hook does not own the draft.
 */
export function useDictation(onText: (text: string, final: boolean) => void): Dictation {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recognition = useRef<SpeechRecognitionLike | null>(null)
  /* The callback lives in a ref so that starting recognition does not depend on
     the identity of a function the caller redefines every render — otherwise
     every keystroke in the draft would tear down the microphone mid-sentence. */
  const sink = useRef(onText)
  sink.current = onText

  const supported = !!ctor()

  const stop = useCallback(() => {
    recognition.current?.stop()
    setListening(false)
  }, [])

  const start = useCallback(() => {
    const Ctor = ctor()
    if (!Ctor) return
    setError(null)

    const rec = new Ctor()
    /* The page's language, not a hardcoded one. An office running the app in
       Hindi should be able to ask in Hindi, and the browser is told which
       recogniser to load from this. en-IN rather than en-US when nothing is
       declared: it is the accent, the place names and the rupee amounts this
       product is actually spoken to in. */
    rec.lang = document.documentElement.lang || 'en-IN'
    // Not continuous: this is one question, not a dictation session. The
    // recogniser stops on its own at the end of an utterance, which is the
    // behaviour somebody expects from pressing a microphone and speaking.
    rec.continuous = false
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onresult = (e) => {
      let text = ''
      let final = false
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        text += result[0].transcript
        if (result.isFinal) final = true
      }
      sink.current(text.trim(), final)
    }

    rec.onerror = (e) => {
      /* Said in the terms of the thing the person has to fix. "not-allowed" is
         the browser's word for a permission the user or the site's policy has
         refused, and it is the only one of these somebody can act on without
         help. */
      const said: Record<string, string> = {
        'not-allowed': 'Microphone access was refused. Allow it in the browser’s address bar and try again.',
        'service-not-allowed': 'This browser will not allow speech recognition on this page.',
        'no-speech': 'Nothing was heard. Press the microphone and speak again.',
        'audio-capture': 'No microphone was found on this device.',
        network: 'Speech recognition needs a connection and could not reach it.',
      }
      setError(said[e.error] ?? `Speech recognition failed (${e.error}).`)
      setListening(false)
    }

    // onend fires however it ended — finished, stopped, or failed — so the
    // listening flag is cleared in exactly one place.
    rec.onend = () => setListening(false)

    recognition.current = rec
    try {
      rec.start()
      setListening(true)
    } catch {
      // start() throws if called while already running. Nothing to repair: the
      // session that is running is the one that was wanted.
      setListening(true)
    }
  }, [])

  // A microphone left listening because a panel closed is the worst outcome
  // here, so it is stopped on unmount whatever the reason.
  useEffect(() => () => recognition.current?.abort(), [])

  return { supported, listening, error, start, stop }
}
