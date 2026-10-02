import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { PickerMenu } from '@/components/PickerMenu'
import { Frame, GrowingTextarea, button, h1, input } from './ApplyForm'

/* THE ENQUIRY FORM, FOR A FAMILY WITH NO ACCOUNT.

   A school hands out a link (a WhatsApp reply, a poster, its website) and
   whoever opens it lands here: /admissions/enquire/<slug>. A minute of typing
   and the family is a lead in the school's enquiry list, due a call today,
   instead of a chat somebody has to remember to copy across.

   The child's name, a parent's name and a phone number are always asked.
   Everything else is the school's choice, and comes from the server as
   'off' | 'optional' | 'required' per question, so the form is exactly as
   long as the school decided. The server validates; this shows what it says.

   Like ApplyForm beside it, this renders outside Shell and the session, and
   carries its own plain styling so it reads on any phone and any connection.

   `website` is a field no person sees or fills: a script that fills every
   input gives itself away, and the server thanks it and keeps nothing. */

type Level = 'off' | 'optional' | 'required'
interface Payload {
  school: string
  open: boolean
  heading: string
  intro: string
  ask: Record<'class_sought' | 'email' | 'date_of_birth' | 'current_school' | 'how_heard' | 'visit_date' | 'message', Level>
  classes: { value: string; label: string }[]
}

export default function EnquireForm() {
  const { slug = '' } = useParams()
  const [params] = useSearchParams()
  const [a, setA] = useState<Record<string, string>>({})
  const [problems, setProblems] = useState<string[]>([])
  const [done, setDone] = useState<{ message: string; apply_url?: string } | null>(null)
  const set = (k: string, v: string) => setA((x) => ({ ...x, [k]: v }))
  const url = `/api/v1/public/admissions/enquiry/${encodeURIComponent(slug)}`

  const form = useQuery({
    queryKey: ['public-enquiry', slug],
    queryFn: async (): Promise<Payload> => {
      const res = await fetch(url)
      if (!res.ok) throw new Error('not_found')
      return res.json()
    },
    retry: false,
  })

  const submit = useMutation({
    mutationFn: async () => {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const details = body?.error?.details
        setProblems(Array.isArray(details) ? details.map(String) : [])
        throw new Error(body?.error?.message ?? 'Could not send your enquiry')
      }
      return body as { message: string; apply_url?: string }
    },
    onSuccess: setDone,
  })

  if (form.isLoading) return <Frame><p style={{ opacity: 0.7 }}>Loading…</p></Frame>
  if (form.error || !form.data || !form.data.open) {
    return (
      <Frame>
        <h1 style={h1}>This enquiry form is not open</h1>
        <p style={{ opacity: 0.75, lineHeight: 1.6 }}>The link may be old, or the school may have closed it. Please contact the school office.</p>
      </Frame>
    )
  }
  const { school, heading, intro, ask, classes } = form.data

  if (done) {
    return (
      <Frame>
        <p style={eyebrow}>{school}</p>
        <h1 style={h1}>Enquiry sent</h1>
        <p style={{ lineHeight: 1.6, marginTop: 10 }}>{done.message}</p>
        {done.apply_url && (
          <>
            <p style={{ opacity: 0.75, lineHeight: 1.6, marginTop: 16 }}>
              You can also fill in the application now. What you just told us is already filled in.
            </p>
            <a href={done.apply_url + (params.get('embed') ? '&embed=1' : '')} style={{ ...button, display: 'block', textAlign: 'center', textDecoration: 'none', boxSizing: 'border-box' }}>
              Continue to the application
            </a>
          </>
        )}
      </Frame>
    )
  }

  const row = (key: string, label: string, level: Level | 'required', node: React.ReactNode, help?: string) =>
    level === 'off' ? null : (
      <label key={key} style={{ display: 'block' }}>
        <span style={{ display: 'block', fontSize: 14, marginBottom: 5 }}>
          {label}{level === 'required' ? <span style={{ color: '#c0392b' }}> *</span> : <span style={{ opacity: 0.55 }}> (optional)</span>}
        </span>
        {node}
        {help && <span style={{ display: 'block', fontSize: 12.5, opacity: 0.65, marginTop: 4 }}>{help}</span>}
      </label>
    )
  const text = (key: string, type = 'text', extra: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    <input style={input} type={type} value={a[key] ?? ''} onChange={(e) => set(key, e.target.value)} {...extra} />
  const today = new Date().toISOString().slice(0, 10)

  return (
    <Frame>
      <p style={eyebrow}>{school}</p>
      <h1 style={h1}>{heading}</h1>
      {intro && <p style={{ opacity: 0.75, lineHeight: 1.6, marginTop: 8, whiteSpace: 'pre-wrap' }}>{intro}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          setProblems([])
          submit.mutate()
        }}
        style={{ marginTop: 22, display: 'grid', gap: 14 }}
      >
        {row('student_name', "Child's name", 'required', text('student_name', 'text', { required: true, autoComplete: 'off' }))}
        {row('parent_name', 'Your name', 'required', text('parent_name', 'text', { required: true, autoComplete: 'name' }))}
        {row('phone', 'Phone number', 'required', text('phone', 'tel', { required: true, inputMode: 'tel', autoComplete: 'tel' }), 'The school will call you on this number.')}
        {row('class_sought', 'Class sought', ask.class_sought,
          <PickerMenu value={a.class_sought ?? ''} options={[{ value: '', label: 'Choose…' }, ...classes]} onChange={(v) => set('class_sought', v)}
            ariaLabel="Class sought" align="start" className="w-full justify-between !h-[44px] !rounded-[3px] !border !border-solid !border-[#c9c9cf] !bg-white !px-3 !text-[15px] !text-[#111] !shadow-none" />)}
        {row('email', 'Email', ask.email, text('email', 'email', { autoComplete: 'email' }))}
        {row('date_of_birth', "Child's date of birth", ask.date_of_birth, text('date_of_birth', 'date', { max: today }))}
        {row('current_school', 'Present school', ask.current_school, text('current_school'))}
        {row('how_heard', 'How did you hear of us?', ask.how_heard, text('how_heard'))}
        {row('visit_date', 'A day you would like to visit', ask.visit_date, text('visit_date', 'date', { min: today }))}
        {row('message', 'Anything you would like to ask', ask.message,
          <GrowingTextarea style={input} rows={3} value={a.message ?? ''} onChange={(e) => set('message', e.target.value)} />)}

        {/* Not for people. See the note at the top. */}
        <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden value={a.website ?? ''} onChange={(e) => set('website', e.target.value)}
          style={{ position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0 }} />

        {submit.error && (
          <div style={{ color: '#c0392b', fontSize: 14 }}>
            <p style={{ margin: 0 }}>{(submit.error as Error).message}</p>
            {problems.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{problems.map((x) => <li key={x}>{x}</li>)}</ul>}
          </div>
        )}

        <button type="submit" disabled={submit.isPending} style={{ ...button, marginTop: 8 }}>
          {submit.isPending ? 'Sending…' : 'Send enquiry'}
        </button>
        <p style={{ opacity: 0.6, fontSize: 12.5, margin: 0, lineHeight: 1.5 }}>
          Your details go only to {school}, to answer this enquiry.
        </p>
      </form>
    </Frame>
  )
}

const eyebrow: React.CSSProperties = { opacity: 0.7, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', margin: 0 }
