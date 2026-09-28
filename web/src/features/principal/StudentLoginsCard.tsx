import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, Field, FormNotice, Select, Table, Td } from '@/components/ui'

/* STUDENT LOGINS: the school's switch, the lowest class, and issuing a class
   or section in one go (worker routes/admin/student_logins.ts and
   POST /setup/logins/bulk kind=students).

   The sign-in name is the admission number and the first password a printed
   code; the child must choose their own at first sign-in. The codes are shown
   once, so the sheet is printed or downloaded before leaving the page. */

interface Policy {
  enabled: boolean; min_level: number | null; chosen: boolean
  classes: { id: string; name: string; level: number }[]
  students: number; with_login: number; eligible: number
}
interface Section { id: string; class_id: string; class_name: string; name: string }
interface Row {
  name: string; sign_in_as?: string; password?: string; existing: boolean; detail?: string
  admission_no?: string; class_name?: string; section_name?: string; roll_no?: number
}
interface Bulk { created: number; existing: number; skipped: number; rows: Row[]; note: string }

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

export function StudentLoginsCard() {
  const qc = useQueryClient()
  const policy = useQuery({ queryKey: ['student-logins'], queryFn: () => api.get<Policy>('/api/v1/admin/student-logins') })
  const sections = useQuery({ queryKey: ['academics-sections'], queryFn: () => api.get<{ items: Section[] }>('/api/v1/academics/sections') })
  const [minLevel, setMinLevel] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [result, setResult] = useState<Bulk | null>(null)

  const save = useMutation({
    mutationFn: (b: { enabled: boolean; min_level: number | null }) => api.put<Policy & { signed_out: number }>('/api/v1/admin/student-logins', b),
    onSuccess: () => { setMinLevel(null); qc.invalidateQueries({ queryKey: ['student-logins'] }) },
  })
  const issue = useMutation({
    mutationFn: (reset: boolean) => {
      const [kind, id] = target.split(':')
      return api.post<Bulk>('/api/v1/setup/logins/bulk', { kind: 'students', reset, ...(kind === 'class' ? { class_id: id } : { section_id: id }) })
    },
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ['student-logins'] }) },
  })

  const p = policy.data
  if (!p) return null
  const level = minLevel ?? (p.min_level === null ? '' : String(p.min_level))
  const levels = [...new Map(p.classes.map((c) => [c.level, c])).values()]
  const eligibleClass = (id: string) => {
    const c = p.classes.find((x) => x.id === id)
    return !c || p.min_level === null || c.level >= p.min_level
  }
  const targets = [
    ...p.classes.filter((c) => eligibleClass(c.id)).map((c) => ({ value: `class:${c.id}`, label: `${c.name}, every section` })),
    ...(sections.data?.items ?? []).filter((s) => eligibleClass(s.class_id)).map((s) => ({ value: `section:${s.id}`, label: `${s.class_name} ${s.name}` })),
  ]
  const issued = result?.rows.filter((r) => r.password) ?? []

  const download = () => {
    const lines = [['Class', 'Section', 'Roll', 'Admission no', 'Name', 'Sign in as', 'Temporary password'].map(csvCell).join(',')]
    for (const r of issued) lines.push([r.class_name, r.section_name, r.roll_no, r.admission_no, r.name, r.sign_in_as, r.password].map(csvCell).join(','))
    const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'student-logins.csv'; a.click()
    URL.revokeObjectURL(url)
  }
  const print = () => {
    const w = window.open('', '_blank')
    if (!w) return
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
    const site = window.location.origin
    w.document.write(`<!doctype html><title>Student logins</title><style>
      body{font:13px system-ui,sans-serif;margin:16px}.g{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .s{border:1px dashed #888;padding:10px 12px;break-inside:avoid}.n{font-weight:600;font-size:14px}.k{font-family:ui-monospace,monospace;font-size:15px}
      .m{color:#555;font-size:11px}@media print{h1{display:none}}</style>
      <h1>Student logins, cut along the lines</h1><div class="g">${issued.map((r) => `<div class="s">
      <div class="n">${esc(r.name)}</div><div class="m">${esc([r.class_name, r.section_name].filter(Boolean).join(' '))}${r.roll_no ? ` · Roll ${esc(r.roll_no)}` : ''} · ${esc(r.admission_no)}</div>
      <div>Sign in as: <span class="k">${esc(r.sign_in_as)}</span></div><div>Password: <span class="k">${esc(r.password)}</span></div>
      <div class="m">Sign in at ${esc(site)}. You will choose your own password the first time.</div></div>`).join('')}</div>`)
    w.document.close()
    w.focus()
    w.print()
  }

  return (
    <Card>
      <CardHeader
        title="Student logins"
        action={
          <Button
            variant={p.enabled ? 'secondary' : 'primary'}
            pending={save.isPending}
            onClick={() => save.mutate({ enabled: !p.enabled, min_level: p.min_level })}
          >
            {p.enabled ? 'Switch off' : 'Switch on'}
          </Button>
        }
      />
      <div className="space-y-4 px-[var(--card-pad)] py-4 text-[14px]">
        <p>
          {p.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}{' '}
          {p.enabled
            ? `Children${p.min_level !== null ? ` from class level ${p.min_level} up` : ''} can sign in with their own login and see only their own timetable, homework, marks, attendance, fees and courses.`
            : 'Children cannot be given a login, and any login a child already has cannot sign in.'}
          {!p.chosen && ' (Not chosen yet: this follows whether the school has issued student logins before.)'}
        </p>
        <p className="text-muted-foreground">
          {p.with_login} of {p.students} students have a login; {p.eligible} are in a class that may have one.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Field label="Lowest class that gets a login">
              <Select
                value={level}
                onChange={setMinLevel}
                options={[{ value: '', label: 'Every class' }, ...levels.map((c) => ({ value: String(c.level), label: `${c.name} and above` }))]}
              />
            </Field>
          </div>
          {minLevel !== null && (
            <Button pending={save.isPending} onClick={() => save.mutate({ enabled: p.enabled, min_level: level === '' ? null : Number(level) })}>
              Save
            </Button>
          )}
        </div>
        <FormNotice error={save.error} />

        {p.enabled && (
          <div className="space-y-3 border-t pt-4">
            <p className="font-medium">Issue logins for a class or section</p>
            <p className="text-muted-foreground">
              Each child signs in with their admission number and a temporary code, and chooses their own password the first time.
              Children who already have a login keep it. Print the slips or download the list: the codes are shown only once.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-72">
                <Field label="Class or section">
                  <Select value={target} onChange={setTarget} options={targets} placeholder="Choose…" />
                </Field>
              </div>
              <Button disabled={!target} pending={issue.isPending && !issue.variables} onClick={() => issue.mutate(false)}>Issue logins</Button>
              <Button variant="secondary" disabled={!target} pending={issue.isPending && !!issue.variables}
                onClick={() => { if (window.confirm('Give every child in this class or section a new code? The codes they hold now stop working.')) issue.mutate(true) }}>
                Reset every code
              </Button>
            </div>
            <FormNotice error={issue.error} />
          </div>
        )}

        {result && (
          <div className="space-y-3 border-t pt-4">
            <p>
              <strong>{result.created}</strong> issued, {result.existing} already had one{result.skipped ? `, ${result.skipped} skipped` : ''}. {result.note}
            </p>
            {issued.length > 0 && (
              <div className="flex gap-2">
                <Button onClick={print}>Print slips for the class teacher</Button>
                <Button variant="secondary" onClick={download}>Download CSV</Button>
              </div>
            )}
            <Table head={['Name', 'Class', 'Sign in as', 'Temporary password']} empty={!result.rows.length}>
              {result.rows.map((r, i) => (
                <tr key={i}>
                  <Td>{r.name}</Td>
                  <Td>{[r.class_name, r.section_name].filter(Boolean).join(' ')}{r.roll_no ? ` · ${r.roll_no}` : ''}</Td>
                  <Td>{r.sign_in_as ?? '—'}</Td>
                  <Td>{r.password ? <span className="font-mono">{r.password}</span> : <span className="text-muted-foreground">{r.detail ?? 'kept their login'}</span>}</Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </div>
    </Card>
  )
}
