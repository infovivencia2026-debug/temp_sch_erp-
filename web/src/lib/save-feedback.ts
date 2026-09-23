import { lastConfirmationAt, toastBus } from '@/components/Toast'

/* EVERY SAVE SAYS "SAVED".

   Nineteen Save buttons, a handful of which confirmed anything. The rest went
   quiet on success -- the button un-greyed and that was the whole signal --
   so people pressed again, or left not knowing whether the setting took.
   Rather than visit each screen (and every screen written next month), the
   API client reports here after any write the server accepted, and if no
   screen has confirmed it within a beat, a one-line "Saved" goes up.

   What is NOT a save is listed, because a confirmation on a chat message or
   a typing hint or the session heartbeat is noise that would bury the real
   ones by the second day. Anything a screen already confirms in its own
   words -- "Receipt RCPT/0051 issued" -- is left to that screen: the
   fallback only speaks when nothing else did. */

const QUIET: RegExp[] = [
  /\/live\//,                 // stream, typing, seen
  /\/chat\//,                 // messages, read receipts, edits
  /\/messages(\/|\?|$)/,      // sending in any channel
  /\/portal\/messages/,
  /\/session(\/|$)/,          // activity beacon, reauth
  /\/sessions\//,
  /\/files(\/|\?|$)/,         // an upload is confirmed by the thing it is attached to
  /\/login|\/logout|\/mfa/,
  /\/search|\/lookup|\/suggest|\/preview|\/export|\/print|\/pdf/,
  /\/assistant|\/ai\//,
  /\/outbox|\/sync|\/heartbeat|\/ping|\/beacon|\/telemetry|\/analytics/,
  /\/notifications\/read|\/read-all|\/dismiss|\/seen/,
  /\/pay(ments)?\/|\/collect|\/checkout|\/upi|\/gateway/, // money names its receipt itself
]

const WORD: Record<string, string> = {
  DELETE: 'Removed',
}

export function noteWrite(method: string, path: string) {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return
  const clean = path.split('#')[0]
  if (QUIET.some((re) => re.test(clean))) return
  const doneAt = Date.now()
  /* A beat, so a screen's own onSuccess -- which runs after this -- gets to
     speak first. If it did, it said more than "Saved" and this stays quiet. */
  window.setTimeout(() => {
    if (lastConfirmationAt() >= doneAt) return
    toastBus()?.ok(WORD[m] ?? 'Saved')
  }, 250)
}
