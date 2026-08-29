import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'

/* THE APPLICATION FORM, FOR SOMEBODY WITH NO ACCOUNT.

   The server has served this form since migration 00095 — GET and POST on
   /api/v1/public/admissions/forms/{slug}, a published version, conditional
   fields, server-side validation — and nothing in the SPA ever rendered it. A
   school could build a form, open it, print the slug on a poster, and the
   parent who typed the URL got the app's own "not found".

   So this exists because the enquiry link needs somewhere to land. Sending a
   parent a URL that 404s is worse than sending nothing.

   ---------------------------------------------------------------------------
   WHY IT IS NOT A FEATURE SCREEN

   Every other screen in this product is inside `Shell`, which is inside
   `SessionProvider`, which redirects to /login when there is no session. An
   applicant has no session and never will — that is the whole point of a
   public form. So App.tsx branches on the path BEFORE the session provider and
   renders this on its own.

   It follows that nothing here may import from the app's own chrome. No
   catalogue, no session, no dock. It has its own markup deliberately.

   ---------------------------------------------------------------------------
   THE ONE RULE ABOUT VALIDATION

   The server validates and this does not, beyond `required`. Conditional
   visibility is resolved server-side in order, and a field whose condition is
   not met is neither required nor stored — trusting the client's view of what
   was on screen would let a submission skip a required field by claiming it
   was hidden. So the client shows what it can and reports what the server
   says, field by field.
*/

interface Option { value: string; label: string }
interface Field {
  id: string
  code: string
  label: string
  field_type: string
  help_text?: string
  placeholder?: string
  is_required: boolean
  options: Option[]
}
interface Section {
  id: string
  title: string
  description?: string
  fields: Field[]
}
interface FormDef {
  form_name: string
  slug: string
  sections: Section[]
}
interface Payload { school: string; form: FormDef }

export default function ApplyForm() {
  const { slug = '' } = useParams()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)

  const form = useQuery({
    queryKey: ['public-form', slug],
    queryFn: async (): Promise<Payload> => {
      const res = await fetch(`/api/v1/public/admissions/forms/${encodeURIComponent(slug)}`)
      if (!res.ok) throw new Error('not_found')
      return res.json()
    },
    retry: false,
  })

  const submit = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/public/admissions/forms/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        /* The server answers 400 with a per-field details map. Showing it
           against the fields is the difference between "some answers need
           attention" and knowing which. */
        const details = body?.error?.details
        if (details && typeof details === 'object') setProblems(details as Record<string, string>)
        throw new Error(body?.error?.message ?? 'Could not submit')
      }
      return body as { application_no: string }
    },
    onSuccess: (b) => setDone(b.application_no),
  })

  if (form.isLoading) {
    return <Frame><p style={{ opacity: 0.7 }}>Loading the form…</p></Frame>
  }

  if (form.error || !form.data) {
    return (
      <Frame>
        <h1 style={h1}>This form is not open</h1>
        <p style={{ opacity: 0.75, lineHeight: 1.6 }}>
          The link may have expired, or admissions may not be open yet. Please
          contact the school office.
        </p>
      </Frame>
    )
  }

  const { school, form: def } = form.data

  if (done) {
    return (
      <Frame>
        <h1 style={h1}>Application received</h1>
        <p style={{ lineHeight: 1.6 }}>
          {school} has your application. Your application number is{' '}
          <strong>{done}</strong>.
        </p>
        <p style={{ opacity: 0.75, lineHeight: 1.6, marginTop: 12 }}>
          Write it down. The school will ask for it when you call, and this page
          will not show it again.
        </p>
      </Frame>
    )
  }

  const set = (code: string, v: string) => {
    setAnswers((a) => ({ ...a, [code]: v }))
    if (problems[code]) setProblems((p) => ({ ...p, [code]: '' }))
  }

  return (
    <Frame>
      <p style={{ opacity: 0.7, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {school}
      </p>
      <h1 style={h1}>{def.form_name}</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          setProblems({})
          submit.mutate()
        }}
      >
        {def.sections.map((sec) => (
          <section key={sec.id} style={{ marginTop: 28 }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>{sec.title}</h2>
            {sec.description && (
              <p style={{ opacity: 0.7, fontSize: 14, marginTop: 4 }}>{sec.description}</p>
            )}
            <div style={{ marginTop: 14, display: 'grid', gap: 14 }}>
              {sec.fields.map((f) => (
                <label key={f.id} style={{ display: 'block' }}>
                  <span style={{ display: 'block', fontSize: 14, marginBottom: 5 }}>
                    {f.label}
                    {f.is_required && <span style={{ color: '#c0392b' }}> *</span>}
                  </span>
                  <FieldInput field={f} value={answers[f.code] ?? ''} onChange={(v) => set(f.code, v)} />
                  {f.help_text && (
                    <span style={{ display: 'block', fontSize: 12.5, opacity: 0.65, marginTop: 4 }}>
                      {f.help_text}
                    </span>
                  )}
                  {problems[f.code] && (
                    <span style={{ display: 'block', fontSize: 13, color: '#c0392b', marginTop: 4 }}>
                      {problems[f.code]}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </section>
        ))}

        {submit.error && (
          <p style={{ color: '#c0392b', marginTop: 20, fontSize: 14 }}>
            {(submit.error as Error).message}
          </p>
        )}

        <button type="submit" disabled={submit.isPending} style={button}>
          {submit.isPending ? 'Sending…' : 'Submit application'}
        </button>
        <p style={{ opacity: 0.6, fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>
          The school will contact you on the number you give here.
        </p>
      </form>
    </Frame>
  )
}

function FieldInput({
  field, value, onChange,
}: {
  field: Field
  value: string
  onChange: (v: string) => void
}) {
  const common = {
    value,
    required: field.is_required,
    placeholder: field.placeholder ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange(e.target.value),
    style: input,
  }
  switch (field.field_type) {
    case 'textarea':
      return <textarea {...common} rows={3} />
    case 'select':
      return (
        <select {...common}>
          <option value="">Choose…</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )
    case 'checkbox':
      return (
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          style={{ width: 18, height: 18 }}
        />
      )
    /* date, number, email, phone and text all map onto one input with the
       right type, which is what gives a phone the correct keypad. `file` is
       deliberately absent: the server takes a presigned id and an applicant
       with no account cannot presign, so a form asking for one is a form the
       office has to chase anyway. */
    case 'number': return <input {...common} type="number" />
    case 'date': return <input {...common} type="date" />
    case 'email': return <input {...common} type="email" />
    case 'phone': return <input {...common} type="tel" inputMode="numeric" />
    default: return <input {...common} type="text" />
  }
}

/* Its own styling, inline, on purpose. This page renders outside Shell and
   must not depend on the app's stylesheet loading or on any token the theme
   sets — a parent on a slow connection should get a readable form even if the
   CSS never arrives. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f7f7f8', color: '#111', padding: '24px 16px' }}>
      <div
        style={{
          maxWidth: 640, margin: '0 auto', background: '#fff', border: '1px solid #e3e3e6',
          borderRadius: 4, padding: '28px 24px',
          font: '15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        {children}
      </div>
    </div>
  )
}

const h1: React.CSSProperties = { fontSize: 24, fontWeight: 600, margin: '6px 0 0' }
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 15,
  border: '1px solid #c9c9cf', borderRadius: 3, background: '#fff', color: '#111',
}
const button: React.CSSProperties = {
  marginTop: 26, width: '100%', padding: '14px 16px', fontSize: 16, fontWeight: 600,
  color: '#fff', background: '#111', border: 0, borderRadius: 3, cursor: 'pointer',
}
