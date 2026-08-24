import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import AdmitStudent from '@/features/setup/AdmitStudent'
import { Phone, Mail } from 'lucide-react'
import { api, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, FormGrid, Field as FormField, Select, Textarea, FormNotice, Checkbox,
  Table, Td, Badge, Button, Input, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import {
  RecordShell, Field, type RecordTab, type RecordAction,
} from '@/components/RecordShell'
import { StatusPill } from '@/components/NeedsAttention'
import { useActiveRole } from '@/lib/catalog'
import { useSession } from '@/lib/session'
import { formatPaise, formatDate, cn } from '@/lib/utils'
import { useToast } from '@/components/Toast'

/* What GET /students/{id} adds on top of the list row. The editable set is
   split across two endpoints -- names and address here, medium and the
   statutory ids on the profile -- so the form is prefilled from both rather
   than from casts that lie about what the response contains. */
interface StudentDetail extends Student {
  blood_group?: string; religion?: string; nationality?: string
  address_line1?: string; city?: string; state?: string; pincode?: string
}

interface Profile {
  id: string; admission_no: string; full_name: string; status: string
  class_name?: string; section_name?: string; roll_no?: number
  gender?: string; date_of_birth?: string; medium?: string; blood_group?: string
  mother_tongue?: string; apaar_id?: string; child_info_id?: string
  primary_phone?: string; city?: string; prior_school?: string
  is_rte: boolean; is_cwsn: boolean; admission_date: string
  attendance: { present: number; total: number; percent: number; below_threshold: boolean }
  fees: { outstanding_paise: number; paid_paise: number }
  guardians: { id?: string; full_name: string; relation: string; phone: string; email: string; is_primary: boolean }[]
  recent_attendance: { date: string; status: string }[]
  results: { exam: string; percentage: string; grade: string; rank: string }[]
  invoices: { date: string; invoice_no: string; net_paise: number; paid_paise: number; status: string }[]
  documents: { serial_no: string; type: string; issued_on: string }[]
  enrolments: {
    year: string; class: string; section: string
    roll_no: number | null; from: string; status: string
  }[]
  transport: {
    route: string; vehicle: string
    pickup_stop: string; pickup_time: string
    drop_stop: string; drop_time: string
    from: string; to: string
  }[]
}

const DOT: Record<string, string> = {
  present: 'bg-success', late: 'bg-warning', absent: 'bg-destructive',
  half_day: 'bg-warning/60', leave: 'bg-muted-foreground/40', holiday: 'bg-border',
}

/**
 * Student 360 — the screen a school opens most often, usually with a parent on
 * the phone. It answers the questions actually asked in that moment: which
 * class, who do we call, are they attending, what do they owe, how are they
 * doing.
 */
export default function StudentProfile() {
  const [search, setSearch] = useState('')

  /* Which student is open lives in the query string, not in component state.

     Two things follow, and both are asked for daily. The student directory can
     hand a child straight to this screen instead of making the clerk retype a
     name they are already looking at — the directory used to be a dead end,
     rows of text with nowhere to click. And the address bar now identifies a
     child, so "look at this one" is a link rather than a set of instructions.

     Back also works, which it did not: the browser button used to leave the
     feature entirely rather than return to the search. */
  const [params, setParams] = useSearchParams()
  const selected = params.get('student')
  const setSelected = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('student', id)
    else next.delete('student')
    setParams(next, { replace: !id })
  }

  const results = useQuery({
    queryKey: ['profile-search', search],
    queryFn: () => api.get<Page<Student>>(`/api/v1/students?q=${encodeURIComponent(search)}&limit=15`),
    enabled: search.trim().length >= 2 && !selected,
  })

  const profile = useQuery({
    queryKey: ['student-profile', selected],
    queryFn: () => api.get<Profile>(`/api/v1/students/${selected}/profile`),
    enabled: !!selected,
  })

  /* The profile view carries full_name; the write API wants the parts. Rather
     than split a name on spaces -- which mangles "Meera Sai Menon" and every
     name that does not have exactly two words -- the record is fetched for the
     fields the form actually edits. */
  const [editing, setEditing] = useState(false)
  const [admitting, setAdmitting] = useState(false)
  const record = useQuery({
    queryKey: ['student-record', selected],
    queryFn: () => api.get<StudentDetail>(`/api/v1/students/${selected}`),
    enabled: !!selected && editing,
  })

  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put(`/api/v1/students/${selected}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['student-profile', selected] })
      qc.invalidateQueries({ queryKey: ['student-record', selected] })
      setEditing(false)
    },
  })

  /* Where a record action sends you.

     An action names what it wants — "fees", "certificates" — and the concrete
     route depends on which workspace this role keeps that in. A principal's
     fee screen and an accountant's are different URLs and the same intent, so
     the record must not hard-code either. Resolving against the caller's own
     catalogue means the same action works from every role that has it, and
     silently does nothing from the ones that do not. */
  /* Issued, shown once, never stored. The response is held in component state
     rather than refetched, because the server does not keep the password and a
     second request would issue a different one.

     These three sat below the early returns — after "no student selected" and
     after "still loading". React counts hooks by call order, so the render
     that showed the search box ran twelve of them and the render after
     clicking Open ran fifteen, which is error #310 and a blank screen. A hook
     cannot live behind a condition; the early returns stay, and every hook
     now runs before them. */
  const toast = useToast()
  const [issued, setIssued] = useState<IssuedLogin | null>(null)
  /* Both of these had onSuccess and nothing else.

     Issuing a login is a one-shot act — the server does not keep the password —
     so a failure that says nothing is the worst possible outcome: the clerk
     sees no panel, assumes the click missed, and presses again. The error is
     named rather than generic, because "could not issue a login" and "this
     guardian already has one" need different next steps from whoever is
     standing at the desk. */
  const studentLogin = useMutation({
    mutationFn: () => api.post<IssuedLogin>(`/api/v1/setup/students/${selected}/login`, {}),
    onSuccess: (v) => setIssued({ ...v, who: v.full_name }),
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : 'Could not issue a login for this student'),
  })
  const guardianLogin = useMutation({
    mutationFn: (g: Profile['guardians'][number]) =>
      api.post<IssuedLogin>(`/api/v1/setup/guardians/${g.id}/login`, {}),
    onSuccess: (v) => setIssued({ ...v, who: v.full_name }),
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : 'Could not issue a login for this guardian'),
  })

  const role = useActiveRole()
  const navigate = useNavigate()
  const session = useSession()
  const held = new Set(session.permissions)

  function can(featureKey: string) {
    if (held.has(featureKey)) return true
    // A capability may be granted through a different role's feature key —
    // match on the trailing slug so "issue a certificate" is answered by
    // whichever workspace this person reaches it through.
    const slug = featureKey.split('.').slice(-1)[0]
    return [...held].some((k) => k.endsWith('.' + slug))
  }

  function go(target: string) {
    if (!role) return
    for (const section of role.sections) {
      for (const f of section.features) {
        if (f.live && f.in_scope && `${section.slug} ${f.slug}`.includes(target)) {
          navigate(`/${role.key}/${section.slug}/${f.slug}`)
          return
        }
      }
    }
  }

  if (!selected) {
    return (
      <>
        <PageHead
          eyebrow="Student Information"
          title="Student 360"
          description="Search a student to see everything about them on one page."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Input value={search} onChange={setSearch} placeholder="Name or admission no." />
              {can('students.write') && (
                <Button variant={admitting ? 'secondary' : 'primary'} onClick={() => setAdmitting(!admitting)}>
                  {admitting ? 'Close' : 'Admit a student'}
                </Button>
              )}
            </div>
          }
        />
        <PageBody>
          {/* This screen is where somebody looking to add a child ends up, so
              the form belongs here rather than only in the setup wizard: a
              search box that answers "no student matches" and offers no way to
              create one is a dead end at the exact moment it matters. */}
          {admitting && can('students.write') && (
            <div className="mb-4">
              <AdmitStudent onDone={() => results.refetch()} />
            </div>
          )}
          {search.trim().length < 2 ? (
            <EmptyState title="Search for a student" body="Type at least two characters." />
          ) : results.isLoading ? (
            <Loading />
          ) : (
            <Card>
              <Table head={['Admission no.', 'Name', 'Class', 'Status', '']}
                empty={!results.data?.items.length} emptyLabel="No student matches.">
                {(results.data?.items ?? []).map((s) => (
                  <tr key={s.id}>
                    <Td className="font-mono text-[12px]">{s.admission_no}</Td>
                    <Td className="font-medium">{s.full_name}</Td>
                    <Td>{s.class_name ? `${s.class_name}-${s.section_name}` : '—'}</Td>
                    <Td><Badge tone={s.status === 'active' ? 'success' : 'neutral'}>{s.status}</Badge></Td>
                    <Td><Button size="sm" onClick={() => setSelected(s.id)}>Open</Button></Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
        </PageBody>
      </>
    )
  }

  if (profile.isLoading) return <Loading />
  if (profile.error) return <ErrorState error={profile.error} />
  const p = profile.data!

  /* Whether the person reading this is teaching the child or filing returns
     about them. The workspace they are actually in, not the roles they hold:
     a principal who also teaches a class still runs the school, and while
     they are standing in the principal's workspace they still need the
     admissions identifiers on this page. */
  const teacherOnly = role?.key === 'faculty'

  const cls = p.class_name ? `${p.class_name}${p.section_name ? `-${p.section_name}` : ''}` : 'Unplaced'
  const overdue = p.invoices.filter((i) => i.status === 'overdue').length

  /* Actions live on the record, not scattered across the modules that own
     them. Issuing a TC is a thing you do *to a student*; making someone find
     the certificates screen and search for the child again is how an ERP
     turns a thirty-second job into a three-minute one.

     Two different things used to be greyed out here and they are not the
     same thing. An action this account lacks the permission for stays,
     disabled, with the permission named beside it — somebody has to be able
     to see what to ask for. An action nobody can perform because it is not
     written yet is gone; "Not built yet" in a menu is our roadmap, printed
     where a person was looking for a control. */
  const mayIssue = can('students.write')
  const issueGuardian = (g: Profile['guardians'][number]) => guardianLogin.mutate(g)

  const actions: RecordAction[] = [
    { label: 'Record payment', onClick: () => go('fees'),
      disabled: !can('finance.fees.collect_payment'),
      disabledReason: 'Needs the fee counter permission' },
    { label: 'Issue certificate', onClick: () => go('certificates'),
      disabled: !can('institution_admin.students.certificates_documents'),
      disabledReason: 'Needs the certificates permission' },
    { label: 'Generate transfer certificate', onClick: () => go('certificates'),
      disabled: !can('institution_admin.students.certificates_documents'),
      disabledReason: 'Needs the certificates permission' },
    { label: 'Send message', onClick: () => go('announcements'),
      disabled: !can('comms.messages.send'), disabledReason: 'Needs the messaging permission' },
    /* "Change section" was here, permanently disabled with "Not built yet"
       for its reason. A menu item that can never be clicked is not a control,
       it is an announcement; it comes back when moving a child between
       sections is something this screen can actually do. */
    /* The child's own way in. Nothing outside the demo seeder had ever given
       a student an account, so the whole student workspace was unreachable in
       a real school. The admission number becomes the username. */
    { label: 'Give this student a login', onClick: () => studentLogin.mutate(),
      disabled: !can('students.write') || studentLogin.isPending,
      disabledReason: 'Needs permission to change student records' },
    { label: editing ? 'Stop editing' : 'Edit student', onClick: () => setEditing(!editing),
      disabled: !can('students.write'),
      disabledReason: 'Needs permission to change student records' },
  ]

  const credentials = issued && (
    <Card className="mb-4 border-success">
      <CardHeader
        title={`Login issued for ${issued.who}`}
        description="Shown once and not stored anywhere. Copy it now — if it is lost, issue another rather than looking this one up."
      />
      <dl className="divide-y text-[14px]">
        <Field k="Sign in as" v={issued.sign_in_as} mono />
        <Field k="Password" v={issued.password} mono />
        {issued.relation && <Field k="Relation" v={issued.relation} />}
      </dl>
      <div className="px-5 py-3">
        <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
          I have copied it
        </Button>
      </div>
    </Card>
  )

  const tabs: RecordTab[] = [
    {
      key: 'overview', label: 'Overview',
      render: () => (
        <div className="grid gap-6 lg:grid-cols-2">
          {editing ? (
            <Card className="lg:col-span-2">
              <CardHeader
                title="Edit details"
                description="Everything the school holds about this child. Blank is allowed — a field nobody has filled in yet is better than a guess."
              />
              <div className="p-4">
                {record.isLoading ? <Loading /> : record.error ? (
                  <ErrorState error={record.error} />
                ) : (
                  <StudentForm
                    student={record.data!}
                    profile={p}
                    saving={save.isPending}
                    error={save.error}
                    onCancel={() => setEditing(false)}
                    onSave={(body) => save.mutate(body)}
                  />
                )}
              </div>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Details" />
            <dl className="divide-y text-[14px]">
              <Field k="Admission no." v={p.admission_no} mono />
              <Field k="Admitted on" v={formatDate(p.admission_date)} />
              <Field k="Class" v={cls} />
              <Field k="Roll no." v={p.roll_no ? String(p.roll_no) : undefined} />
              <Field k="Date of birth" v={formatDate(p.date_of_birth)} />
              <Field k="Gender" v={p.gender} />
              <Field k="Blood group" v={p.blood_group} />
              <Field k="Mother tongue" v={p.mother_tongue} />
              <Field k="Medium" v={p.medium} />
              {/* APAAR, Child Info, the previous school and the RTE/CWSN
                  category are admissions records. The office needs them to
                  file returns; a teacher opening a child's page wants to know
                  who to ring, and four government identifiers between them and
                  the phone number is four rows of noise.

                  Hidden rather than deleted: the same component serves the
                  front office and the principal, and taking these off their
                  screen would break the returns those screens exist to file. */}
              {!teacherOnly && (
                <>
                  <Field k="APAAR ID" v={p.apaar_id ?? 'not issued'} mono />
                  <Field k="Child Info ID" v={p.child_info_id ?? 'not linked'} mono />
                  <Field k="Previous school" v={p.prior_school} />
                  <Field k="Category" v={[p.is_rte && 'RTE', p.is_cwsn && 'CWSN'].filter(Boolean).join(' · ') || 'General'} />
                </>
              )}
            </dl>
          </Card>
          <Guardians p={p} onIssue={mayIssue ? issueGuardian : undefined} />
        </div>
      ),
    },
    {
      key: 'academics', label: 'Academics',
      render: () => (
        <Card>
          <CardHeader title="Results" description="Published report cards only" />
          <Table head={['Exam', 'Percentage', 'Grade', 'Rank']} empty={!p.results.length}
            emptyLabel="Nothing published yet.">
            {p.results.map((x, i) => (
              <tr key={i}>
                <Td className="font-medium">{x.exam || '—'}</Td>
                <Td>{x.percentage ? `${x.percentage}%` : '—'}</Td>
                <Td>{x.grade ? <Badge tone="primary">{x.grade}</Badge> : '—'}</Td>
                <Td>{x.rank || '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      ),
    },
    {
      key: 'attendance', label: 'Attendance',
      render: () => (
        <>
          <Card>
            <CardHeader
              title="Last 30 marked days"
              description={p.attendance.below_threshold
                ? 'Below the 75% board threshold for exam eligibility.'
                : 'Most recent first.'}
            />
            <div className="p-5">
              {p.recent_attendance.length === 0 ? (
                <p className="py-4 text-center text-[14px] text-muted-foreground">Nothing marked yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {p.recent_attendance.map((d) => (
                    <span key={d.date} title={`${d.date} — ${d.status}`}
                      className={cn('h-4 w-4 rounded-sm', DOT[d.status] ?? 'bg-muted')} />
                  ))}
                </div>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title="Recent days" />
            <Table head={['Date', 'Status']} empty={!p.recent_attendance.length}>
              {p.recent_attendance.slice(0, 15).map((d) => (
                <tr key={d.date}>
                  <Td className="text-muted-foreground">{formatDate(d.date)}</Td>
                  <Td><StatusPill status={d.status} /></Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      ),
    },
    {
      key: 'fees', label: 'Fees', badge: overdue || undefined,
      render: () => (
        <Card>
          <CardHeader
            title="Fee history"
            description={p.fees.outstanding_paise
              ? `${formatPaise(p.fees.outstanding_paise)} outstanding`
              : 'Settled in full'}
          />
          <Table head={['Date', 'Invoice', 'Amount', 'Paid', 'Status']} empty={!p.invoices.length}
            emptyLabel="No invoices raised.">
            {p.invoices.map((x) => (
              <tr key={x.invoice_no}>
                <Td className="text-muted-foreground">{formatDate(x.date)}</Td>
                <Td className="font-mono text-[12px]">{x.invoice_no}</Td>
                <Td>{formatPaise(x.net_paise)}</Td>
                <Td>{formatPaise(x.paid_paise)}</Td>
                <Td><StatusPill status={x.status} /></Td>
              </tr>
            ))}
          </Table>
        </Card>
      ),
    },
    {
      key: 'documents', label: 'Documents',
      render: () => (
        <Card>
          <CardHeader title="Certificates issued" />
          <Table head={['Serial', 'Type', 'Issued']} empty={!p.documents.length}
            emptyLabel="Nothing issued for this child yet.">
            {p.documents.map((d) => (
              <tr key={d.serial_no}>
                <Td className="font-mono text-[12px]">{d.serial_no}</Td>
                <Td>{d.type}</Td>
                <Td className="text-muted-foreground">{formatDate(d.issued_on)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      ),
    },
    /* Transport came back, because there is now something to put in it.

       It was removed for being a tab that opened on "Not built yet" — a
       promise that paid out an apology. What was actually missing was a
       query: a bus seat has always been a transport_allocations row, and the
       record simply never asked for one. The front desk with a mother at the
       gate asking which bus her daughter takes was being sent to the
       transport module to find out about a child whose record was already
       open.

       Communication stays out. A child's messages are a real thing to show
       and there is no one place they live yet, so the tab returns when there
       is something behind it and not before. */
    {
      key: 'transport', label: 'Transport',
      render: () => (
        <Card>
          <CardHeader
            title="Bus route"
            description="The route this child is allotted, and where they are picked up and dropped."
          />
          <Table
            head={['Route', 'Vehicle', 'Pick-up', 'Drop', 'From']}
            empty={!p.transport.length}
            emptyLabel="This child does not use school transport."
          >
            {p.transport.map((t, i) => (
              <tr key={`${t.route}-${t.from}-${i}`}>
                <Td>{t.route}</Td>
                <Td className="font-mono text-[12px]">{t.vehicle || '—'}</Td>
                <Td>
                  {t.pickup_stop || '—'}
                  {t.pickup_time && (
                    <span className="text-muted-foreground"> · {t.pickup_time}</span>
                  )}
                </Td>
                <Td>
                  {t.drop_stop || '—'}
                  {t.drop_time && <span className="text-muted-foreground"> · {t.drop_time}</span>}
                </Td>
                <Td className="text-muted-foreground">
                  {formatDate(t.from)}
                  {t.to ? ` — ${formatDate(t.to)}` : ''}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      ),
    },
    {
      key: 'history', label: 'History',
      render: () => (
        <Card>
          <CardHeader
            title="Enrolment history"
            description="Every year this child has been on the roll, and how each one ended."
          />
          {/* This said three things the header already said. A promotion
              closes one enrolments row and opens the next, so the record of
              where a child has been was sitting there the whole time — which
              is what a class teacher is asking when they ask whether a child
              has been detained before. */}
          <Table
            head={['Year', 'Class', 'Roll', 'From', 'Outcome']}
            empty={!p.enrolments.length}
            emptyLabel="No enrolment recorded."
          >
            {p.enrolments.map((e, i) => (
              <tr key={`${e.year}-${e.from}-${i}`}>
                <Td>{e.year}</Td>
                <Td>
                  {e.class}-{e.section}
                </Td>
                <Td className="tabular-nums">{e.roll_no ?? '—'}</Td>
                <Td className="text-muted-foreground">{formatDate(e.from)}</Td>
                <Td>
                  <Badge tone={e.status === 'active' ? 'success' : e.status === 'detained' ? 'warning' : undefined}>
                    {e.status}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
          <dl className="divide-y border-t text-[14px]">
            <Field k="Admitted" v={formatDate(p.admission_date)} />
          </dl>
        </Card>
      ),
    },
  ]

  return (
    <>
    {credentials}
    <RecordShell
      title={p.full_name}
      subtitle={`${p.admission_no} · ${cls}${p.roll_no ? ` · Roll ${p.roll_no}` : ''}`}
      status={p.status}
      facts={[
        {
          label: 'Attendance',
          value: `${p.attendance.percent}%`,
          tone: p.attendance.below_threshold ? 'bad' : 'good',
        },
        // "Fees settled" over a bare 0 read as "nothing has been settled",
        // the opposite of what it means. The nothing-due case says so in
        // words; the amount is only shown when there is one.
        {
          label: 'Outstanding',
          value: p.fees.outstanding_paise ? formatPaise(p.fees.outstanding_paise) : 'Nothing due',
          tone: p.fees.outstanding_paise ? 'warn' : 'good',
        },
        // Every receipt this child's account has ever taken, across all years
        // and any advance not yet applied to a bill — which is why it can
        // exceed the one invoice the Fees tab shows for this year.
        { label: 'Receipts, all years', value: formatPaise(p.fees.paid_paise) },
      ]}
      tabs={tabs}
      actions={actions}
      onBack={() => { setSelected(null); setSearch('') }}
      backLabel="Back to search"
    />
    </>
  )
}

/** A login handed over once. The server does not keep the password, so this
 *  lives in component state and a refetch would lose it -- which is correct:
 *  a password a system can show you twice is one it is storing in a form
 *  somebody else can read. */
interface IssuedLogin {
  sign_in_as: string
  full_name: string
  password: string
  relation?: string
  note: string
  who: string
}

/** Who to call. First thing anyone needs when a child is the subject. */
function Guardians({ p, onIssue }: { p: Profile; onIssue?: (g: Profile['guardians'][number]) => void }) {
  return (
    <Card>
      {/* The block a teacher opens this page for. Father and mother first,
          because "ring the parents" is the action, and a list sorted by a
          primary-contact flag put an uncle at the top of it whenever somebody
          had ticked that box.

          The email is printed rather than hidden behind the word "email". A
          teacher writing to a parent copies the address; a mailto link is the
          wrong tool on a school desktop where the default mail client is
          usually nothing at all. Email stays optional — a phone number is the
          contact that matters and a parent without an address is not a
          record with something missing from it. */}
      <CardHeader title="Parents and guardians" description="Father and mother first" />
      {p.guardians.length === 0 ? (
        <div className="p-6">
          <EmptyState title="No guardian on record"
            body="Nobody can be contacted about this child." />
        </div>
      ) : (
        <ul className="divide-y">
          {[...p.guardians]
            .sort((a, b) => rankRelation(a.relation) - rankRelation(b.relation))
            .map((g) => (
            <li key={g.full_name + g.phone} className="px-5 py-3">
              {/* The name gets a floor, and the row is allowed to wrap.

                  It was `min-w-0` with no basis, beside a `shrink-0` cluster
                  holding a button, a phone number and an email address. In
                  the two-column overview that cluster is wider than the card,
                  so the name was left about eleven pixels and "Guardian of
                  Aarav ADM0001" came down the card a letter at a time.

                  flex-1 alone does not fix it — what is left over is still
                  almost nothing. The name claims a 12rem basis and the row
                  wraps, so when the two do not fit side by side the contacts
                  drop to their own line instead of crushing the name. A
                  viewport breakpoint would be the wrong instrument: this card
                  is narrow because it is in a two-up grid, not because the
                  window is. */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                <div className="min-w-0 flex-1 basis-48">
                  {/* gap-1.5 rather than nothing: the badge butted straight
                      against the last character of the name. */}
                  <p className="flex flex-wrap items-center gap-x-1.5 text-[14px] font-medium">
                    {g.full_name}
                    {g.is_primary && <Badge tone="primary">primary</Badge>}
                  </p>
                  <p className="text-[13px] text-muted-foreground">{g.relation}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3 text-[13px]">
                  {onIssue && (
                    <Button size="sm" variant="secondary" onClick={() => onIssue(g)}>
                      Give a login
                    </Button>
                  )}
                  {g.phone && (
                    <a href={`tel:${g.phone}`} className="inline-flex items-center gap-1 text-primary">
                      <Phone className="h-3 w-3" />{g.phone}
                    </a>
                  )}
                  {/* The address is the longest thing in the row and the
                      least urgent, so it is the one that gives way: capped
                      and truncated rather than pushing the name off the
                      card. The full address is still on the link, and
                      copying it copies all of it. */}
                  {g.email && (
                    <a
                      href={`mailto:${g.email}`}
                      title={g.email}
                      className="inline-flex min-w-0 max-w-[15rem] items-center gap-1 text-primary"
                    >
                      <Mail className="h-3 w-3 shrink-0" />
                      <span className="truncate">{g.email}</span>
                    </a>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* The student form.
 *
 * One form, every field the write API accepts, because the alternative -- a
 * profile screen that shows fourteen facts and lets you change none of them --
 * is what a principal reported after buying the product: a record they could
 * read and not correct.
 *
 * Nothing here is required except a first name, which is the only thing the
 * server insists on. Schools fill records in over weeks, and a form that
 * demands a blood group before it will save a corrected spelling is a form
 * people work around by not using it.
 */
function StudentForm({
  student, profile, saving, error, onSave, onCancel,
}: {
  student: StudentDetail
  profile: Profile
  saving: boolean
  error: unknown
  onSave: (body: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const [f, setF] = useState({
    admission_no: student.admission_no ?? '',
    first_name: student.first_name ?? '',
    middle_name: student.middle_name ?? '',
    last_name: student.last_name ?? '',
    date_of_birth: student.date_of_birth ?? '',
    gender: student.gender ?? '',
    blood_group: student.blood_group ?? '',
    medium: profile.medium ?? '',
    mother_tongue: profile.mother_tongue ?? '',
    religion: student.religion ?? '',
    address_line1: student.address_line1 ?? '',
    city: student.city ?? '',
    state: student.state ?? '',
    pincode: student.pincode ?? '',
    apaar_id: profile.apaar_id ?? '',
    child_info_id: profile.child_info_id ?? '',
    prior_school: profile.prior_school ?? '',
  })
  const [rte, setRte] = useState(profile.is_rte)
  const [cwsn, setCwsn] = useState(profile.is_cwsn)
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v })

  return (
    <>
      <FormNotice error={error} />
      <FormGrid>
        <FormField label="Admission no."><Input value={f.admission_no} onChange={set('admission_no')} /></FormField>
        <FormField label="First name" required><Input value={f.first_name} onChange={set('first_name')} /></FormField>
        <FormField label="Middle name"><Input value={f.middle_name} onChange={set('middle_name')} /></FormField>
        <FormField label="Last name"><Input value={f.last_name} onChange={set('last_name')} /></FormField>
        <FormField label="Date of birth"><Input type="date" value={f.date_of_birth} onChange={set('date_of_birth')} /></FormField>
        <FormField label="Gender">
          <Select value={f.gender} onChange={set('gender')} placeholder="Not recorded"
            options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} />
        </FormField>
        <FormField label="Blood group">
          <Select kind="blood_group" addLabel="Add another group" value={f.blood_group} onChange={set('blood_group')} placeholder="Not recorded"
            options={['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => ({ value: b, label: b }))} />
        </FormField>
        <FormField label="Medium">
          <Select kind="medium" addLabel="Add another medium" value={f.medium} onChange={set('medium')} placeholder="Not recorded"
            options={['telugu', 'english', 'urdu', 'hindi', 'other'].map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) }))} />
        </FormField>
        <FormField label="Mother tongue">
          <Select kind="mother_tongue" addLabel="Add a language" value={f.mother_tongue} onChange={set('mother_tongue')} placeholder="Not recorded" options={[]} />
        </FormField>
        <FormField label="Religion">
          <Select kind="religion" addLabel="Add one" value={f.religion} onChange={set('religion')} placeholder="Not recorded" options={[]} />
        </FormField>
        <FormField label="City"><Input value={f.city} onChange={set('city')} /></FormField>
        <FormField label="State"><Input value={f.state} onChange={set('state')} /></FormField>
        <FormField label="Pincode" hint="Six digits"><Input value={f.pincode} onChange={set('pincode')} /></FormField>
        <FormField label="APAAR ID" hint="Twelve digits"><Input value={f.apaar_id} onChange={set('apaar_id')} /></FormField>
        <FormField label="Child Info ID"><Input value={f.child_info_id} onChange={set('child_info_id')} /></FormField>
        <FormField label="Previous school"><Input value={f.prior_school} onChange={set('prior_school')} /></FormField>
      </FormGrid>

      <FormField label="Address">
        <Textarea value={f.address_line1} onChange={set('address_line1')} rows={2} />
      </FormField>

      <div className="mt-3 flex flex-wrap gap-4">
        <Checkbox label="Admitted under RTE" checked={rte} onChange={setRte} />
        <Checkbox label="Child with special needs (CWSN)" checked={cwsn} onChange={setCwsn} />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          disabled={saving || !f.first_name.trim()}
          onClick={() => onSave({ ...f, is_rte: rte, is_cwsn: cwsn })}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </>
  )
}


/**
 * Father, then mother, then everybody else.
 *
 * The list was ordered by the is_primary flag, which is a billing and consent
 * field — whoever the office ticked. A teacher looking for a parent wants the
 * parents, and an uncle recorded as the primary contact should not be the
 * first row on the page every time.
 *
 * Unknown relations sort last rather than being hidden. A grandmother who is
 * raising the child is exactly the person somebody needs to reach.
 */
function rankRelation(relation: string): number {
  const r = (relation || '').trim().toLowerCase()
  if (r.startsWith('father') || r === 'dad') return 0
  if (r.startsWith('mother') || r === 'mum' || r === 'mom') return 1
  if (r.startsWith('guardian')) return 2
  return 3
}
