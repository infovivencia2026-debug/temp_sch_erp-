import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle2, Paperclip, UploadCloud } from 'lucide-react'

/* A WEBSITE FORM, as the school's website embeds it (owner, 2026-11-05):
   /f/{school}/{form} in an iframe. Renders outside Shell and the session, in
   the school's colour, and posts to /api/v1/public/forms/{school}/{form} like
   any other website would. It tells the page around it how tall it is, so
   the embed code can size the iframe without a scrollbar. */

type FieldType = 'text' | 'long_text' | 'email' | 'phone' | 'number' | 'date' | 'dropdown' | 'checkbox' | 'file'
interface Field { key: string; label: string; type: FieldType; required: boolean; options?: string[] }
interface Def { school_name: string; color: string; title: string; description: string; fields: Field[]; is_open: boolean; submit_label: string; thanks_message: string }

const control = 'w-full rounded-lg border border-[#c5cddb] bg-white px-4 py-3.5 text-[16px] text-[#0f1b3d] outline-none transition placeholder:text-[#7a8499] focus:border-[var(--brand)] focus:ring-4 focus:ring-[color-mix(in_srgb,var(--brand)_12%,transparent)]'

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

  // See-through, so the form sits on the website's own page colour.
  useEffect(() => {
    for (const el of [document.documentElement, document.body]) el.style.background = 'transparent'
  }, [])

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
    <div ref={box} className="bg-transparent p-1 text-[#0f1b3d]" 
      style={{ ['--brand' as string]: def?.color || '#12308a', fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }}>
      <div>
        <div>
          {!def ? <p className="text-slate-600">{err || 'Loading…'}</p> : done ? (
            <div className="py-8 text-center">
              <CheckCircle2 className="mx-auto size-14" style={{ color: 'var(--brand)' }} />
              <p className="mt-3 text-[17px] font-medium text-[#0f1b3d]">{done}</p>
            </div>
          ) : (
            <form onSubmit={submit} noValidate>
                            {!def.is_open ? <p className="rounded-xl bg-slate-100 p-4 text-slate-700">This form is not taking responses now.</p> : (
                <>
                                    <div className="space-y-5">
                    {def.fields.map((f) => (
                      <div key={f.key}>
                        {f.type === 'checkbox' ? (
                          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[#e3e7ef] bg-[#f6f8fb] p-5 text-[16px]">
                            <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]" checked={values[f.key] === 'true'}
                              onChange={(e) => set(f.key, e.target.checked ? 'true' : '')} />
                            <span>{f.label}{f.required && <span className="text-red-600"> *</span>}</span>
                          </label>
                        ) : (
                          <>
                            <label className="mb-2 block text-[15px] font-semibold text-[#0f1b3d]" htmlFor={`f-${f.key}`}>{f.label}{f.required && <span className="text-red-600"> *</span>}</label>
                            {f.type === 'long_text' ? (
                              <textarea id={`f-${f.key}`} rows={4} className={control} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                            ) : f.type === 'dropdown' ? (
                              <select id={`f-${f.key}`} className={control} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                                <option value="">Select</option>
                                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                              </select>
                            ) : f.type === 'file' ? (
                              <label htmlFor={`f-${f.key}`} className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-[#b8c2d4] bg-[#f6f8fb] px-4 py-7 text-center transition hover:border-[var(--brand)]">
                                {files[f.key] ? <Paperclip className="size-6" style={{ color: 'var(--brand)' }} /> : <UploadCloud className="size-7 text-slate-400" />}
                                <span className="text-[14px] font-medium">{files[f.key]?.name ?? 'Choose a file or drop it here'}</span>
                                <span className="text-[12px] text-slate-500">PDF, Word or a clear photo (JPG, PNG, WebP), up to 8 MB</span>
                                <input id={`f-${f.key}`} type="file" className="sr-only" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp"
                                  onChange={(e) => setFiles((o) => ({ ...o, [f.key]: e.target.files?.[0] ?? null }))} />
                              </label>
                            ) : (
                              <input id={`f-${f.key}`} className={control} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}
                                type={f.type === 'phone' ? 'tel' : f.type === 'text' ? 'text' : f.type}
                                inputMode={f.type === 'phone' ? 'numeric' : undefined}
                                placeholder={f.type === 'phone' ? '10-digit mobile number' : f.type === 'email' ? 'name@example.com' : undefined} />
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                  {err && <p role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-[14px] text-red-700">{err}</p>}
                  <button type="submit" disabled={busy}
                    className="mt-8 w-full rounded-xl px-7 py-4 text-[17px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60 sm:ml-auto sm:block sm:w-auto"
                    style={{ background: 'var(--brand)' }}>{busy ? 'Sending…' : def.submit_label}</button>
                </>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
