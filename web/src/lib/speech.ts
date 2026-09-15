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

/* SPEAKING THE ANSWER BACK.

   The recogniser hears the question; this reads the reply. Both are the
   browser's own Web Speech API, so there is no service, no key and nothing to
   deploy -- and, like dictation, it is simply absent where the browser has no
   support rather than being faked. */
export function speechOutputSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/* PICK A HUMAN-SOUNDING VOICE, NOT THE ONE THE OS HANDS OUT.

   Left alone, speechSynthesis reads in the platform's default engine, which on
   many machines is the old formant synth -- the flat, robotic "Stephen Hawking"
   voice. But the browser almost always also exposes far better ones: the
   operating system's neural voices (named "... Natural" / "... Neural" / "...
   Online") and, in Chrome, the network-backed "Google" voices. This scores what
   is installed and keeps the best English one.

   English, and Indian English first, because that is the school. A voice is
   scored, not matched by an exact name, because the exact names differ across
   Windows, macOS, iOS, Android and Chrome and a fixed list would find nothing
   on the next machine. */
let chosenVoice: SpeechSynthesisVoice | null = null

function scoreVoice(v: SpeechSynthesisVoice): number {
  const name = v.name.toLowerCase()
  const lang = (v.lang || '').toLowerCase().replace('_', '-')
  if (!lang.startsWith('en')) return -1
  let s = 0
  // The quality signal, worth the most: a neural/natural/online engine.
  if (/(natural|neural|online)/.test(name)) s += 100
  // Chrome's Google voices are network-backed and markedly better than local.
  if (name.includes('google')) s += 60
  // Apple's better voices; and mark the low-quality ones down hard.
  if (/(siri|premium|enhanced)/.test(name)) s += 50
  if (/(compact|espeak|pico|robo)/.test(name)) s -= 80
  // The school is Indian English; then British, then anything English.
  if (lang === 'en-in') s += 25
  else if (lang === 'en-gb') s += 12
  else if (lang.startsWith('en')) s += 6
  // A default flag on a poor engine should not win; a small nudge only.
  if (v.default) s += 2
  return s
}

function pickVoice(): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis?.getVoices?.() ?? []
    let best: SpeechSynthesisVoice | null = null
    let bestScore = -1
    for (const v of voices) {
      const sc = scoreVoice(v)
      if (sc > bestScore) {
        bestScore = sc
        best = v
      }
    }
    return bestScore >= 0 ? best : null
  } catch {
    return null
  }
}

// The voice list loads asynchronously on some browsers -- getVoices() is empty
// until 'voiceschanged' fires -- so recompute whenever it changes.
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  chosenVoice = pickVoice()
  try {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      chosenVoice = pickVoice()
    })
  } catch {
    /* older engines expose onvoiceschanged only; the eager call above still ran */
  }
}

/* Read one answer aloud. Cancels whatever is mid-sentence first, so a new
   answer does not queue behind the last one. onEnd fires when it finishes (or
   is cut off), which is what a hands-free loop waits on before listening
   again. Markdown is stripped to spoken words -- nobody wants "asterisk
   asterisk" read out. */
export function speak(text: string, onEnd?: () => void) {
  try {
    const synth = window.speechSynthesis
    if (!synth) {
      onEnd?.()
      return
    }
    synth.cancel()
    const spoken = text
      .replace(/[*_`#>]/g, '')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (!spoken) {
      onEnd?.()
      return
    }
    const u = new SpeechSynthesisUtterance(spoken)
    // The best installed voice, recomputed if the list only just loaded.
    const voice = chosenVoice ?? (chosenVoice = pickVoice())
    if (voice) {
      u.voice = voice
      u.lang = voice.lang
    }
    // A touch slower and lower than default reads as calmer and less synthetic;
    // the natural voices in particular sound rushed at exactly 1.0.
    u.rate = 0.98
    u.pitch = 1
    if (onEnd) {
      u.onend = () => onEnd()
      u.onerror = () => onEnd()
    }
    synth.speak(u)
  } catch {
    onEnd?.()
  }
}

export function stopSpeaking() {
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* nothing to stop */
  }
}

/* A SUBTLE TYPEWRITER TICK, for the assistant's printing answer.

   A short, quiet click as characters appear -- the mechanical half of a
   typewriter to go with the visible one. Deliberately faint (a low-gain blip a
   few milliseconds long) and best called every few characters, not every one,
   or it becomes a buzz.

   Web Audio only, and it fails silent: no AudioContext, a blocked autoplay
   policy, anything -- the printing still runs, just without the sound. The
   context is created lazily and resumed on use, because it is first reached
   from a real user gesture (asking a question), which is what the policy wants. */
let audioCtx: AudioContext | null = null
let lastTick = 0

export function playTypeTick() {
  try {
    if (typeof window === 'undefined') return
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    // No faster than ~18ms apart, so a fast printer does not stack blips.
    const now = performance.now()
    if (now - lastTick < 18) return
    lastTick = now
    audioCtx = audioCtx ?? new Ctor()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    const ctx = audioCtx
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    // A high, short square blip reads as a key strike rather than a tone.
    osc.type = 'square'
    osc.frequency.setValueAtTime(1500 + Math.random() * 400, t)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.03, t + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.035)
  } catch {
    /* no sound is fine; the animation carries the effect on its own */
  }
}
