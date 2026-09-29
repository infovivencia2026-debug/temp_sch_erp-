import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, Field, FormNotice, Select, Table, Td, Input } from '@/components/ui'

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

/* One list and one sheet of slips, whoever they are for.

   Written twice would be written differently the second time, and the half a
   school actually uses -- the printed slip a class teacher cuts up and hands
   out -- is the half that would drift. */
/* A login that already worked still belongs on the sheet.

   Filtering to the passwords just issued left every child who already had one
   off the class list, so the teacher handing slips out had a pile with gaps in
   it and no way to tell a missing child from a forgotten one. They go on it
   with their sign-in name and a line saying the password cannot be read back,
   which is the true answer and tells the parent what to do about it. */
export const passwordOrNote = (r: Row) =>
  r.password ?? 'Already set. Ask the office to reset it if it is lost.'

export function downloadLogins(rows: Row[], stem: string) {
  const head = ['Class', 'Section', 'Roll', 'Admission no', 'Name', 'Sign in as', 'First password']
  const lines = [head.map(csvCell).join(',')]
  for (const r of rows) {
    lines.push([r.class_name, r.section_name, r.roll_no, r.admission_no, r.name, r.sign_in_as, passwordOrNote(r)]
      .map(csvCell).join(','))
  }
  // The BOM is what makes Excel read the file as UTF-8 rather than mangling it.
  const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${stem}-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function printSlips(rows: Row[], title: string) {
  const w = window.open('', '_blank')
  if (!w) return
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
  const site = window.location.origin
  w.document.write(`<!doctype html><title>${esc(title)}</title><style>
    body{font:13px system-ui,sans-serif;margin:16px}.g{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .s{border:1px dashed #888;padding:10px 12px;break-inside:avoid}.n{font-weight:600;font-size:14px}
    .k{font-family:ui-monospace,monospace;font-size:15px}.m{color:#555;font-size:11px}
    @media print{h1{display:none}}</style>
    <h1>${esc(title)}, cut along the lines</h1><div class="g">${rows.map((r) => `<div class="s">
    <div class="n">${esc(r.name)}</div><div class="m">${esc([r.class_name, r.section_name].filter(Boolean).join(' '))}${r.roll_no ? ` · Roll ${esc(r.roll_no)}` : ''}${r.admission_no ? ` · ${esc(r.admission_no)}` : ''}</div>
    <div>Sign in as: <span class="k">${esc(r.sign_in_as)}</span></div>${r.password
      ? `<div>Password: <span class="k">${esc(r.password)}</span></div>
    <div class="m">Sign in at ${esc(site)}. You will choose your own password the first time.</div>`
      : `<div>Password: <span class="m">${esc(passwordOrNote(r))}</span></div>
    <div class="m">Sign in at ${esc(site)}.</div>`}</div>`).join('')}</div>`)
  w.document.close()
  w.focus()
  w.print()
}

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

  /* Every eligible student at once, 60 per call until none are left. */
  const [fillBusy, setFillBusy] = useState(false)
  const [fillDone, setFillDone] = useState<{ issued: number; skipped: number } | null>(null)
  const [fillErr, setFillErr] = useState<unknown>(null)
  const fill = {
    busy: fillBusy, done: fillDone, err: fillErr,
    run: async () => {
      setFillBusy(true); setFillErr(null)
      let issued = 0, skipped = 0
      try {
        for (let i = 0; i < 100; i++) {
          const r = await api.post<{ issued: number; skipped: number; remaining: number }>('/api/v1/admin/student-logins/issue-missing')
          issued += r.issued; skipped += r.skipped
          if (r.remaining <= 0 || r.issued === 0) break
        }
        setFillDone({ issued, skipped })
      } catch (e) { setFillErr(e) } finally { setFillBusy(false); qc.invalidateQueries({ queryKey: ['student-logins'] }); qc.invalidateQueries({ queryKey: ['school-logins'] }) }
    },
  }

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
  /* The whole class goes on the sheet, not only the codes issued just now.
     A child who already had a login is on it too, with their sign-in name:
     their password cannot be read back, so the slip says so and how to get a
     new one, instead of the child being missing from the class list. */
  const sheet = result?.rows.filter((r) => r.sign_in_as) ?? []


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
        {p.enabled && p.with_login < p.eligible && (
          <div className="flex flex-wrap items-center gap-3">
            <Button pending={fill.busy} onClick={fill.run}>Give every student a login</Button>
            {fill.done && <span className="text-success">Issued {fill.done.issued}{fill.done.skipped ? `; ${fill.done.skipped} skipped` : ''}.</span>}
            {fill.err ? <FormNotice error={fill.err} /> : null}
          </div>
        )}
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
              Each child signs in with their admission number as both the username and the first password, and chooses their own password the first time.
              Children who already have a login keep it. Print the slips or download the list for class teachers.
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
            {sheet.length > 0 && (
              <div className="flex gap-2">
                <Button onClick={() => printSlips(sheet, 'Student logins')}>Print slips for the class teacher</Button>
                <Button variant="secondary" onClick={() => downloadLogins(sheet, 'student-logins')}>Download CSV</Button>
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

/* THE SAME ERRAND FOR A PARENT OR A MEMBER OF STAFF.

   Issuing a class of children their logins, printing the slips and keeping the
   list was built here and built well, and then it was the only audience that
   had it: a school wanting to give sixty parents their logins had a screen that
   made accounts one at a time. The endpoint never cared -- POST
   /setup/logins/bulk takes kind students, guardians or staff -- so the whole
   difference was which card existed.

   Staff take no class: the school employs whom it employs, and the bulk route
   reads the roll rather than a section. Guardians take a class or a section,
   because a parent belongs to the school through their child.

   Reset stays a separate, confirmed button rather than a checkbox, for the same
   reason it does above: the two look alike and only one of them locks people
   out of an account they are already using. */
export function IssueLoginsCard({ kind }: { kind: 'guardians' | 'staff' }) {
  const qc = useQueryClient()
  const sections = useQuery({
    queryKey: ['academics-sections'],
    queryFn: () => api.get<{ items: Section[] }>('/api/v1/academics/sections'),
    enabled: kind === 'guardians',
  })
  const [target, setTarget] = useState('')
  const [result, setResult] = useState<Bulk | null>(null)

  const issue = useMutation({
    mutationFn: (reset: boolean) => {
      const [t, id] = target.split(':')
      return api.post<Bulk>('/api/v1/setup/logins/bulk', {
        kind, reset,
        ...(kind === 'guardians' && t === 'class' ? { class_id: id } : {}),
        ...(kind === 'guardians' && t === 'section' ? { section_id: id } : {}),
      })
    },
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: ['admin-users'] }) },
  })

  const people = kind === 'staff' ? 'staff' : 'parents'
  const items = sections.data?.items ?? []
  const targets = [
    ...[...new Map(items.map((s) => [s.class_id, s])).values()]
      .map((s) => ({ value: `class:${s.class_id}`, label: `${s.class_name}, every section` })),
    ...items.map((s) => ({ value: `section:${s.id}`, label: `${s.class_name} ${s.name}` })),
  ]
  const ready = kind === 'staff' || !!target
  const sheet = result?.rows.filter((r) => r.sign_in_as) ?? []

  return (
    <Card>
      <CardHeader
        title={kind === 'staff' ? 'Issue staff logins' : 'Issue parent logins'}
        description={
          kind === 'staff'
            ? 'Everybody on the roll who has no login yet. They sign in with their staff number, email or phone.'
            : 'Every guardian of the children in a class or section. They sign in with their phone number.'
        }
      />
      <div className="space-y-4 px-[var(--card-pad)] py-4 text-[14px]">
        <p className="text-muted-foreground">
          The first password is the person&rsquo;s own phone number, and they are asked to choose their
          own the first time. Anyone who already has a working login keeps it, unless you reset.
          Print the slips or download the list before leaving: a password is shown once and cannot be
          read back afterwards.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          {kind === 'guardians' && (
            <div className="w-72">
              <Field label="Class or section">
                <Select value={target} onChange={setTarget} options={targets} placeholder="Choose…" />
              </Field>
            </div>
          )}
          <Button disabled={!ready} pending={issue.isPending && !issue.variables} onClick={() => issue.mutate(false)}>
            Issue logins
          </Button>
          <Button
            variant="secondary"
            disabled={!ready}
            pending={issue.isPending && !!issue.variables}
            onClick={() => {
              if (window.confirm(`Give every one of these ${people} a new password? The one they hold now stops working.`)) issue.mutate(true)
            }}
          >
            Reset every password
          </Button>
        </div>
        <FormNotice error={issue.error} />

        {result && (
          <div className="space-y-3 border-t pt-4">
            <p>
              <strong>{result.created}</strong> issued, {result.existing} already had one
              {result.skipped ? `, ${result.skipped} skipped` : ''}. {result.note}
            </p>
            {sheet.length > 0 && (
              <div className="flex gap-2">
                <Button onClick={() => printSlips(sheet, kind === 'staff' ? 'Staff logins' : 'Parent logins')}>
                  Print the slips
                </Button>
                <Button variant="secondary" onClick={() => downloadLogins(sheet, `${kind}-logins`)}>
                  Download CSV
                </Button>
              </div>
            )}
            <Table head={['Name', 'Belongs to', 'Sign in as', 'First password']} empty={!result.rows.length}>
              {result.rows.map((r, i) => (
                <tr key={i}>
                  <Td>{r.name}</Td>
                  <Td>{[r.class_name, r.section_name].filter(Boolean).join(' ') || '—'}</Td>
                  <Td>{r.sign_in_as ?? '—'}</Td>
                  <Td>
                    {r.password
                      ? <span className="font-mono">{r.password}</span>
                      : <span className="text-muted-foreground">{r.detail ?? 'kept their login'}</span>}
                  </Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </div>
    </Card>
  )
}

/* ONE CHILD, OR ONE PARENT, WITHOUT LEAVING THIS SCREEN.

   Issuing for a single person lived only on Student 360: to give one parent
   their login you opened the child, found the guardian and pressed it there.
   That is a reasonable place for it and a hopeless place to look for it, and
   the question people arrive at this screen holding is nearly always about one
   person -- somebody rang the office because they cannot get in.

   Search is the child either way, because that is what the office knows. For a
   parent the child's guardians are listed once a child is chosen, since a
   guardian is reached through their child and not out of a directory of
   grown-ups. */
export function IssueOneCard({ kind }: { kind: 'students' | 'guardians' }) {
  const qc = useQueryClient()
  const [needle, setNeedle] = useState('')
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null)
  const [done, setDone] = useState<{ name: string; signIn: string; password: string } | null>(null)

  const found = useQuery({
    queryKey: ['issue-one', needle],
    queryFn: () => api.get<{ items: { id: string; full_name: string; admission_no?: string; class_name?: string; section_name?: string }[] }>(
      `/api/v1/students?q=${encodeURIComponent(needle.trim())}&status=active&limit=8`),
    enabled: needle.trim().length >= 2 && !picked,
  })
  const child = useQuery({
    queryKey: ['issue-one-child', picked?.id],
    queryFn: () => api.get<{ guardians: { id: string; full_name: string; relation: string; phone?: string }[] }>(
      `/api/v1/students/${picked!.id}`),
    enabled: !!picked && kind === 'guardians',
  })

  const issue = useMutation({
    mutationFn: (v: { id: string; name: string; reset: boolean }) =>
      api.post<{ sign_in_as?: string; password?: string; temporary_password?: string }>(
        `/api/v1/setup/${kind === 'students' ? 'students' : 'guardians'}/${v.id}/login${v.reset ? '?reset=true' : ''}`, {})
        .then((r) => ({ name: v.name, signIn: r.sign_in_as ?? '', password: r.password ?? r.temporary_password ?? '' })),
    onSuccess: (r) => { setDone(r); qc.invalidateQueries({ queryKey: ['admin-users'] }) },
  })

  const clear = () => { setPicked(null); setNeedle(''); setDone(null) }
  const guardians = child.data?.guardians ?? []

  return (
    <Card>
      <CardHeader
        title={kind === 'students' ? 'Issue a login for one child' : 'Issue a login for one parent'}
        description="Search the child by name or admission number."
        action={picked ? <Button variant="ghost" onClick={clear}>Start again</Button> : undefined}
      />
      <div className="space-y-4 px-[var(--card-pad)] py-4 text-[14px]">
        {!picked && (
          <>
            <Field label="Child">
              <Input value={needle} onChange={setNeedle} placeholder="Name or admission number" />
            </Field>
            {needle.trim().length >= 2 && (
              <Table head={['Child', 'Class', '']} empty={!(found.data?.items ?? []).length}
                     emptyLabel={found.isLoading ? 'Looking…' : 'Nobody matches that.'}>
                {(found.data?.items ?? []).map((st) => (
                  <tr key={st.id}>
                    <Td>{st.full_name}<span className="ml-2 text-muted-foreground">{st.admission_no}</span></Td>
                    <Td>{[st.class_name, st.section_name].filter(Boolean).join(' ') || '—'}</Td>
                    <Td>
                      <Button size="sm" variant="secondary" onClick={() => setPicked({ id: st.id, name: st.full_name })}>
                        Choose
                      </Button>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </>
        )}

        {picked && kind === 'students' && !done && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-medium">{picked.name}</p>
            <Button pending={issue.isPending} onClick={() => issue.mutate({ id: picked.id, name: picked.name, reset: false })}>
              Issue the login
            </Button>
            <Button variant="secondary" pending={issue.isPending}
              onClick={() => { if (window.confirm(`Give ${picked.name} a new password? The one they hold now stops working.`)) issue.mutate({ id: picked.id, name: picked.name, reset: true }) }}>
              Reset the password
            </Button>
          </div>
        )}

        {picked && kind === 'guardians' && !done && (
          <>
            <p className="font-medium">{picked.name}&rsquo;s family</p>
            <Table head={['Parent', 'Relation', 'Phone', '']} empty={!guardians.length}
                   emptyLabel={child.isLoading ? 'Reading the family…' : 'This child has no guardian on record.'}>
              {guardians.map((g) => (
                <tr key={g.id}>
                  <Td>{g.full_name}</Td>
                  <Td className="text-muted-foreground">{g.relation}</Td>
                  <Td>{g.phone ?? '—'}</Td>
                  <Td className="whitespace-nowrap">
                    <Button size="sm" pending={issue.isPending} onClick={() => issue.mutate({ id: g.id, name: g.full_name, reset: false })}>
                      Issue
                    </Button>
                    <Button size="sm" variant="secondary" pending={issue.isPending}
                      onClick={() => { if (window.confirm(`Give ${g.full_name} a new password? The one they hold now stops working.`)) issue.mutate({ id: g.id, name: g.full_name, reset: true }) }}>
                      Reset
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </>
        )}

        <FormNotice error={issue.error} />

        {done && (
          <div className="space-y-2 border-t pt-4">
            <p className="font-medium">{done.name} can sign in</p>
            <p>Sign in as: <span className="font-mono">{done.signIn || '—'}</span></p>
            <p>
              Password:{' '}
              {done.password
                ? <span className="font-mono text-[16px]">{done.password}</span>
                : <span className="text-muted-foreground">already set, reset it to see one</span>}
            </p>
            <p className="text-[13px] text-muted-foreground">
              Shown once. Write it down or send it now; it cannot be read back.
            </p>
            <Button size="sm" variant="secondary" onClick={clear}>Do another</Button>
          </div>
        )}
      </div>
    </Card>
  )
}

/* ONE MEMBER OF STAFF, FROM THE SAME SCREEN.

   The staff equivalent lived on HR > Employees, which is the right place for
   somebody already working through the roll and the wrong place for somebody
   answering the phone to a teacher who cannot get in.

   The roll is fetched whole and filtered here rather than asked for by name,
   because GET /hr/employees has no text search and a school has tens of staff,
   not thousands: two hundred rows is a smaller thing to ask of the server than
   a new endpoint, and it lets the code, the name and the phone all match. */
export function IssueOneStaffCard() {
  const qc = useQueryClient()
  const [needle, setNeedle] = useState('')
  const [done, setDone] = useState<{ name: string; signIn: string; password: string } | null>(null)

  const staff = useQuery({
    queryKey: ['issue-one-staff'],
    queryFn: () => api.get<{ items: { id: string; employee_code?: string; name?: string; full_name?: string; phone?: string }[] }>(
      '/api/v1/hr/employees?status=active&limit=200&with_total=0'),
  })

  const issue = useMutation({
    mutationFn: (v: { id: string; name: string; reset: boolean }) =>
      api.post<{ sign_in_as?: string; password?: string; temporary_password?: string }>(
        `/api/v1/setup/employees/${v.id}/login${v.reset ? '?reset=true' : ''}`, {})
        .then((r) => ({ name: v.name, signIn: r.sign_in_as ?? '', password: r.password ?? r.temporary_password ?? '' })),
    onSuccess: (r) => { setDone(r); qc.invalidateQueries({ queryKey: ['admin-users'] }) },
  })

  const term = needle.trim().toLowerCase()
  const rows = (staff.data?.items ?? [])
    .map((e) => ({ ...e, label: e.full_name ?? e.name ?? '' }))
    .filter((e) => !term || `${e.label} ${e.employee_code ?? ''} ${e.phone ?? ''}`.toLowerCase().includes(term))
    .slice(0, 8)

  return (
    <Card>
      <CardHeader
        title="Issue a login for one member of staff"
        description="Search by name, staff code or phone."
      />
      <div className="space-y-4 px-[var(--card-pad)] py-4 text-[14px]">
        <Field label="Member of staff">
          <Input value={needle} onChange={setNeedle} placeholder="Name, code or phone" />
        </Field>
        {term.length >= 2 && (
          <Table head={['Name', 'Code', 'Phone', '']} empty={!rows.length}
                 emptyLabel={staff.isLoading ? 'Reading the roll…' : 'Nobody matches that.'}>
            {rows.map((e) => (
              <tr key={e.id}>
                <Td>{e.label}</Td>
                <Td className="text-muted-foreground">{e.employee_code ?? '—'}</Td>
                <Td>{e.phone ?? '—'}</Td>
                <Td className="whitespace-nowrap">
                  <Button size="sm" pending={issue.isPending}
                    onClick={() => issue.mutate({ id: e.id, name: e.label, reset: false })}>
                    Issue
                  </Button>
                  <Button size="sm" variant="secondary" pending={issue.isPending}
                    onClick={() => { if (window.confirm(`Give ${e.label} a new password? The one they hold now stops working.`)) issue.mutate({ id: e.id, name: e.label, reset: true }) }}>
                    Reset
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <FormNotice error={issue.error} />
        {done && (
          <div className="space-y-2 border-t pt-4">
            <p className="font-medium">{done.name} can sign in</p>
            <p>Sign in as: <span className="font-mono">{done.signIn || '—'}</span></p>
            <p>
              Password:{' '}
              {done.password
                ? <span className="font-mono text-[16px]">{done.password}</span>
                : <span className="text-muted-foreground">already set, reset it to see one</span>}
            </p>
            <p className="text-[13px] text-muted-foreground">
              Shown once. Write it down or send it now; it cannot be read back.
            </p>
            <Button size="sm" variant="secondary" onClick={() => { setDone(null); setNeedle('') }}>Do another</Button>
          </div>
        )}
      </div>
    </Card>
  )
}
