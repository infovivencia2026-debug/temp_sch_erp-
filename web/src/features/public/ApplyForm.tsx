import { useEffect, useRef, useState } from 'react'
import { useAutoGrow } from '@/lib/auto-grow'
import { PickerMenu } from '@/components/PickerMenu'
import { useParams, useSearchParams } from 'react-router-dom'
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
interface Payload { school: string; form: FormDef; prefill?: Record<string, string> }
interface Bring { label: string; note?: string }

export default function ApplyForm() {
  const { slug = '' } = useParams()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [done, setDone] = useState<{ no: string; bring: Bring[] } | null>(null)
  const [list, setList] = useState<string[]>([])
  /* A lead's own link (?lead=...): the school signed it for one enquiry, so
     the form opens with what that family already told the school, and what
     is sent is attached to that enquiry. Passed through untouched. */
  const [params] = useSearchParams()
  const lead = params.get('lead')
  const q = lead ? `?lead=${encodeURIComponent(lead)}` : ''

  const form = useQuery({
    queryKey: ['public-form', slug, lead],
    queryFn: async (): Promise<Payload> => {
      const res = await fetch(`/api/v1/public/admissions/forms/${encodeURIComponent(slug)}${q}`)
      if (!res.ok) throw new Error('not_found')
      return res.json()
    },
    retry: false,
  })

  const submit = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/public/admissions/forms/${encodeURIComponent(slug)}${q}`, {
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
        // The server sends a list of sentences, each naming its question.
        if (Array.isArray(details)) setList(details.map(String))
        else if (details && typeof details === 'object') setProblems(details as Record<string, string>)
        throw new Error(body?.error?.message ?? 'Could not submit')
      }
      return body as { application_no: string; bring?: Bring[] }
    },
    onSuccess: (b) => setDone({ no: b.application_no, bring: b.bring ?? [] }),
  })

  // Filled in once, when the form arrives; never over something already typed.
  const prefill = form.data?.prefill
  useEffect(() => {
    if (prefill) setAnswers((a) => ({ ...prefill, ...a }))
  }, [prefill])

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
          <strong>{done.no}</strong>.
        </p>
        <p style={{ opacity: 0.75, lineHeight: 1.6, marginTop: 12 }}>
          Write it down. The school will ask for it when you call, and this page
          will not show it again.
        </p>
        <BringList items={done.bring} />
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
      {prefill && (
        <p style={{ marginTop: 10, padding: '10px 12px', background: '#f1f6ff', borderRadius: 8, fontSize: 14, lineHeight: 1.5 }}>
          We have filled in what you already told the school. Please check it and complete the rest.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          setProblems({})
          setList([])
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
              {sec.fields.filter((f) => f.field_type !== 'bring').map((f) => (
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

        {/* What is not asked here because it is brought on paper. */}
        <BringList items={def.sections.flatMap((sec) => sec.fields.filter((f) => f.field_type === 'bring').map((f) => ({ label: f.label, note: f.help_text })))} />

        {submit.error && (
          <div style={{ color: '#c0392b', marginTop: 20, fontSize: 14 }}>
            <p style={{ margin: 0 }}>{(submit.error as Error).message}</p>
            {list.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{list.map((x) => <li key={x}>{x}</li>)}</ul>}
          </div>
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
      return <GrowingTextarea {...common} rows={3} />
    case 'select':
      return (
        <PickerMenu
          value={value}
          options={[{ value: '', label: 'Choose…' }, ...field.options.map((o) => ({ value: o.value, label: o.label }))]}
          onChange={(v) => onChange(v)}
          ariaLabel={field.label}
          align="start"
          className="w-full justify-between !h-[44px] !rounded-[3px] !border !border-solid !border-[#c9c9cf] !bg-white !px-3 !text-[15px] !text-[#111] !shadow-none"
        />
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
/* The originals the school wants to see in person, said once and plainly so a
   family does not go looking for a place to upload them. */
function BringList({ items }: { items: Bring[] }) {
  if (!items.length) return null
  return (
    <section style={{ marginTop: 28, padding: '14px 16px', background: '#f7f7f8', borderRadius: 8 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Bring these to the school</h2>
      <p style={{ opacity: 0.7, fontSize: 13.5, margin: '4px 0 0' }}>Nothing to upload for these: carry them when you visit.</p>
      <ul style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
        {items.map((b) => (
          <li key={b.label}>{b.label}{b.note && <span style={{ opacity: 0.65 }}> · {b.note}</span>}</li>
        ))}
      </ul>
    </section>
  )
}

export function Frame({ children }: { children: React.ReactNode }) {
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

export const h1: React.CSSProperties = { fontSize: 24, fontWeight: 600, margin: '6px 0 0' }
export const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 15,
  border: '1px solid #c9c9cf', borderRadius: 3, background: '#fff', color: '#111',
}
export const button: React.CSSProperties = {
  marginTop: 26, width: '100%', padding: '14px 16px', fontSize: 16, fontWeight: 600,
  color: '#fff', background: '#111', border: 0, borderRadius: 3, cursor: 'pointer',
}

/** The form's own textarea, growing from three lines to ten (lib/auto-grow). */
export function GrowingTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(ref, { minRows: props.rows ?? 3, maxRows: 10 }, typeof props.value === 'string' ? props.value : undefined)
  return <textarea ref={ref} {...props} style={{ ...props.style, resize: 'none' }} />
}
