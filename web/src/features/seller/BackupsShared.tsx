import { useState } from 'react'
import { Button, Input, Field, FormNotice } from '@/components/ui'

export const bytes = (n: number | null | undefined) =>
  !n ? '-' : n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`

export const stamp = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : '-')

/**
 * A destructive step that asks for the school's name to be typed back (and,
 * for deletion, a phrase too). The button stays disabled until it matches.
 */
export function TypedConfirm({ name, phrase, label, question, pending, error, onConfirm, onCancel }: {
  name: string
  phrase?: string
  label: string
  question: string
  pending?: boolean
  error?: unknown
  onConfirm: (typedName: string, typedPhrase: string) => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  const [typedPhrase, setTypedPhrase] = useState('')
  const okName = typed.trim() === name.trim()
  const okPhrase = !phrase || typedPhrase === phrase
  return (
    <div className="grid gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4">
      <p className="text-[14px]">{question}</p>
      <Field label={`Type the school's name: ${name}`}>
        <Input value={typed} onChange={setTyped} placeholder={name} />
      </Field>
      {phrase && (
        <Field label={`And type: ${phrase}`}>
          <Input value={typedPhrase} onChange={setTypedPhrase} placeholder={phrase} />
        </Field>
      )}
      <div className="flex gap-2">
        <Button tone="danger" disabled={!okName || !okPhrase} pending={pending} onClick={() => onConfirm(typed, typedPhrase)}>{label}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      {error ? <FormNotice error={error} /> : null}
    </div>
  )
}
