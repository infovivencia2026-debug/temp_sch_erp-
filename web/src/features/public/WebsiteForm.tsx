import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Frame, GrowingTextarea, button, h1, input } from './ApplyForm'

/* A WEBSITE FORM, as the school's website embeds it (owner, 2026-11-05):
   /f/{school}/{form} in an iframe. Renders outside Shell and the session, and
   posts to /api/v1/public/forms/{school}/{form} like any other website would.
   It tells the page around it how tall it is, so the embed code can size the
   iframe without a scrollbar. */

type FieldType = 'text' | 'long_text' | 'email' | 'phone' | 'number' | 'date' | 'dropdown' | 'checkbox' | 'file'
interface Field { key: string; label: string; type: FieldType; required: boolean; options?: string[] }
interface Def { school_name: string; title: string; description: string; fields: Field[]; is_open: boolean; submit_label: string; thanks_message: string }

const label: React.CSSProperties = { display: 'block', fontWeight: 600, fontSize: 14, margin: '18px 0 6px' }

export default function WebsiteForm() {
  const { school = '', form = '' } = useParams()
  const url = `/api/v1/public/forms/${encodeURIComponent(school)}/${encodeURIComponent(form)}`
  const [def, setDef] = useState<Def | null>(null)
  const [err, setErr] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404 ? 'This form could not be found.' : 'This form could not be loaded.')
      setDef(await r.json())
    }).catch((e: Error) => setErr(e.message))
  }, [url])

  // The page's height, for the embed code's iframe.
  useEffect(() => {
    if (!box.current || window.parent === window) return
    const send = () => window.parent.postMessage({ type: 'xulo-form-height', form, height: document.documentElement.scrollHeight }, '*')
    const ro = new ResizeObserver(send)
    ro.observe(box.current)
    send()
    return () => ro.disconnect()
  }, [def, done, err, form])

  const set = (k: string, v: string) => setValues((o) => ({ ...o, [k]: v }))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!def) return
    setBusy(true); setErr('')
    const fd = new FormData()
    for (const f of def.fields) {
      if (f.type === 'file') { const x = files[f.key]; if (x) fd.append(f.key, x) }
      else if (f.type === 'checkbox') fd.append(f.key, values[f.key] === 'true' ? 'true' : 'false')
      else fd.append(f.key, values[f.key] ?? '')
    }
    fd.append('_source', 'embed')
    fd.append('_page', document.referrer || '')
    try {
      const r = await fetch(url, { method: 'POST', body: fd })
      const b = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(b?.error?.message || b?.message || 'Could not send. Please try again.')
      setDone(b.message || def.thanks_message)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div ref={box}>
      <Frame>
        {!def ? <p>{err || 'Loading…'}</p> : done ? (
          <>
            <h1 style={h1}>{def.title}</h1>
            <p style={{ marginTop: 12 }}>{done}</p>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <p style={{ opacity: 0.7, fontSize: 13.5, margin: 0 }}>{def.school_name}</p>
            <h1 style={h1}>{def.title}</h1>
            {def.description && <p style={{ margin: '8px 0 0', whiteSpace: 'pre-line' }}>{def.description}</p>}
            {!def.is_open ? <p style={{ marginTop: 16 }}>This form is not taking responses now.</p> : (
              <>
                {def.fields.map((f) => (
                  <div key={f.key}>
                    {f.type === 'checkbox' ? (
                      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '18px 0 0', fontSize: 15 }}>
                        <input type="checkbox" style={{ marginTop: 4, width: 18, height: 18 }} checked={values[f.key] === 'true'}
                          onChange={(e) => set(f.key, e.target.checked ? 'true' : '')} />
                        <span>{f.label}{f.required && <span style={{ color: '#b42318' }}> *</span>}</span>
                      </label>
                    ) : (
                      <>
                        <label style={label} htmlFor={`f-${f.key}`}>{f.label}{f.required && <span style={{ color: '#b42318' }}> *</span>}</label>
                        {f.type === 'long_text' ? (
                          <GrowingTextarea id={`f-${f.key}`} style={input} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                        ) : f.type === 'dropdown' ? (
                          <select id={`f-${f.key}`} style={input} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                            <option value="">Select</option>
                            {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : f.type === 'file' ? (
                          <input id={`f-${f.key}`} type="file" style={input} accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp"
                            onChange={(e) => setFiles((o) => ({ ...o, [f.key]: e.target.files?.[0] ?? null }))} />
                        ) : (
                          <input id={`f-${f.key}`} style={input} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}
                            type={f.type === 'phone' ? 'tel' : f.type === 'text' ? 'text' : f.type}
                            inputMode={f.type === 'phone' ? 'numeric' : undefined} />
                        )}
                      </>
                    )}
                  </div>
                ))}
                {err && <p role="alert" style={{ color: '#b42318', marginTop: 16 }}>{err}</p>}
                <button type="submit" style={{ ...button, opacity: busy ? 0.6 : 1 }} disabled={busy}>{busy ? 'Sending…' : def.submit_label}</button>
              </>
            )}
          </form>
        )}
      </Frame>
    </div>
  )
}
