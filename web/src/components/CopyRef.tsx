import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

/* "Ref: K7Q2X9" with a copy button, wherever an error line carries one.
   The server gives every unexpected error a six-character reference
   (worker/src/services/error_refs.ts); a help request that quotes it opens
   onto what happened. Renders nothing when the text has no reference. */
export const REF_IN_TEXT = /Ref: ([A-HJ-NP-Z2-9]{6})\b/

export function CopyRef({ text }: { text: string }) {
  const ref = REF_IN_TEXT.exec(text)?.[1]
  const [done, setDone] = useState(false)
  if (!ref) return null
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(ref).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }, () => {})
      }}
      title="Copy the reference"
      aria-label={`Copy reference ${ref}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[12px] font-medium text-foreground hover:bg-muted"
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}
