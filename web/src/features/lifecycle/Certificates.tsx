import { useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, type List, type Page, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Input, Field, SkeletonTable, ErrorState,
} from '@/components/ui'
import { useRouteFeature } from '@/lib/catalog'
import { formatDate, formatPaise } from '@/lib/utils'
import CardViewer from '@/components/CardViewer'
import BulkImport from '@/components/BulkImport'
import { useDebouncedValue } from '@/lib/debounce'

interface Cert {
  id: string
  serial_no: string; type: string; student_name: string
  issued_on: string; status: string
  snapshot: Record<string, unknown>
  class_name?: string; section_name?: string; admission_no?: string
  asked_by?: string; asked_phone?: string
}

/* A status is not always good news.

   Every row wore a green badge, so a request the office had DECLINED read as
   a success, in green, in the register — and so did one still sitting
   unanswered. */
function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'issued') return 'success'
  if (status === 'approved') return 'neutral'
  if (status === 'cancelled') return 'danger'
  return 'warning' // requested, and waiting on somebody here
}

const TYPES = [
  { value: 'BONAFIDE', label: 'Bonafide certificate' },
  { value: 'CONDUCT', label: 'Character certificate' },
  { value: 'TC', label: 'Transfer certificate' },
]

/* The prescribed fields a transfer certificate carries that no table holds.

   Nationality and category are read from the child's record and only asked
   here to override; the rest — games, conduct, NCC, the date the family
   applied — are what the office writes on the form and nowhere else. */
interface TCForm {
  nationality: string; category: string; ncc_scout: string; games: string
  conduct: string; date_of_application: string; date_of_issue: string
  qualified_for_promotion: string; dues_paid_up_to: string; fee_concession: string
  last_exam_passed: string
}
const EMPTY_TC: TCForm = {
  nationality: '', category: '', ncc_scout: '', games: '', conduct: '',
  date_of_application: '', date_of_issue: '', qualified_for_promotion: '',
  dues_paid_up_to: '', fee_concession: '', last_exam_passed: '',
}

/** Certificates freeze a snapshot of the student at issue time, so an old TC
    keeps showing the class and dues it was issued with. */
export default function Certificates() {
  const nav = useRouteFeature()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [studentId, setStudentId] = useState('')
  const [type, setType] = useState('BONAFIDE')
  const [reason, setReason] = useState('')
  const [answering, setAnswering] = useState<Cert | null>(null)
  const [tc, setTc] = useState<TCForm>(EMPTY_TC)
  const [overrideReason, setOverrideReason] = useState('')
  const [card, setCard] = useState<{ html: string; name?: string } | null>(null)
  const [decision, setDecision] = useState('issued')
  const [note, setNote] = useState('')

  const decide = useMutation({
    mutationFn: (v: { id: string; status: string; note: string }) =>
      // Registered under /lifecycle, beside the list this row came from --
      // not under /students, which is where this call had been pointed and
      // where chi has nothing to answer with but a 404.
      api.post(`/api/v1/lifecycle/certificates/${v.id}/decide`,
        { status: v.status, note: v.note }),
    onSuccess: () => {
      setAnswering(null)
      setNote('')
      qc.invalidateQueries({ queryKey: ['certificates'] })
    },
  })

  const needle = useDebouncedValue(search.trim())
  const results = useQuery({
    queryKey: ['cert-search', needle],
    queryFn: () => api.get<Page<Student>>(`/api/v1/students?q=${encodeURIComponent(needle)}&limit=10`),
    enabled: needle.length >= 2,
    placeholderData: keepPreviousData,
  })
  const list = useQuery({
    queryKey: ['certificates'],
    queryFn: () => api.get<List<Cert>>('/api/v1/lifecycle/certificates'),
  })
  const issue = useMutation({
    mutationFn: (override: boolean) =>
      api.post<{ serial_no: string; dues_overridden?: boolean }>('/api/v1/lifecycle/certificates', {
        student_id: studentId, type_code: type, reason,
        ...(type === 'TC'
          ? {
              ...tc,
              qualified_for_promotion:
                tc.qualified_for_promotion === '' ? undefined : tc.qualified_for_promotion === 'yes',
              override_dues: override,
              override_dues_reason: override ? overrideReason : undefined,
            }
          : {}),
      }),
    onSuccess: () => {
      setStudentId(''); setSearch(''); setReason(''); setTc(EMPTY_TC); setOverrideReason('')
      qc.invalidateQueries({ queryKey: ['certificates'] })
    },
  })
  // Fees owed. The server says how much and on how many bills; the office
  // either collects or issues anyway with a reason that goes on the record.
  const duesBlock =
    issue.error instanceof ApiError && issue.error.code === 'dues_unpaid' ? issue.error : null
  const setTcField = (k: keyof TCForm) => (v: string) => setTc((t) => ({ ...t, [k]: v }))

  const rows = list.data?.items ?? []
  // What is waiting on somebody here, separated from the register. A queue
  // mixed into 200 rows of history is a queue nobody works.
  const pending = rows.filter((c) => c.status === 'requested' || c.status === 'approved')

  return (
    <>
      {card && <CardViewer card={card} onClose={() => setCard(null)} />}
      {/* The name in the menu, not a second name invented here.

          A principal clicked "Certificates & transfers" under Students and
          arrived at "Administration / Certificates" — a different section and
          a different title, so nothing on the page confirmed they had landed
          where they aimed. The catalogue is what the menu, the command
          palette and search all read, which makes it the name that has to
          win. Read per route rather than hard-coded, because this screen is
          also reached from the registrar's own section under another name. */}
      <PageHead
        eyebrow={nav.section?.name ?? 'Students'}
        title={nav.feature?.name ?? 'Certificates & transfers'}
        description="Issue bonafide, character and transfer certificates with a numbered serial and a frozen record snapshot."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Issued" value={rows.length} />
          <Stat label="Transfer certificates" value={rows.filter((r) => r.type.includes('Transfer')).length}
            hint="Each one exits a student" />
          <Stat label="This month"
            value={rows.filter((r) => r.issued_on.slice(0, 7) === new Date().toISOString().slice(0, 7)).length} />
        </CellGrid>

        {/* WHAT SOMEBODY WAS SENT HERE TO DO COMES FIRST.

            The dashboard alert says "1 certificate request to issue" and links
            here, and here opened on an empty form: a blank student search and
            a document dropdown, with the family's actual request below the
            fold. So the answer to "who asked, and for what" was two screens of
            scrolling away, and the obvious move -- fill in the empty form --
            issues a second certificate on a second serial and leaves the
            family's request open for ever. The queue goes above the form. */}
        {pending.length > 0 && (
          <Card>
            <CardHeader
              title={`${pending.length} ${pending.length === 1 ? 'request' : 'requests'} from families`}
              description="Asked for through the parent and student portal. Answering one tells the whole household."
            />
            <Table head={['Serial', 'Document', 'For which child', 'Who asked', 'Asked', 'Reason', '']}
              empty={false}>
              {pending.map((c) => (
                <tr key={c.id}>
                  <Td className="font-mono text-[12px]">{c.serial_no}</Td>
                  <Td className="font-medium">{c.type}</Td>
                  {/* THE CHILD, WITH THEIR CLASS. The queue said a name and
                      nothing else, so a clerk holding the signed paper still
                      had to look the child up to know where to send it. */}
                  <Td>
                    <span className="font-medium">{c.student_name}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {[c.class_name && c.section_name
                        ? `${c.class_name}-${c.section_name}` : c.class_name,
                        c.admission_no].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </Td>
                  {/* WHO TO HAND IT TO, and the number to ring. */}
                  <Td>
                    {c.asked_by || (
                      <span className="text-muted-foreground">
                        Asked from the portal, no name on the account
                      </span>
                    )}
                    {c.asked_phone && (
                      <a href={`tel:${c.asked_phone}`}
                        className="block text-[12px] text-primary">
                        {c.asked_phone}
                      </a>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(c.issued_on)}</Td>
                  <Td className="text-muted-foreground">
                    {String(c.snapshot?.reason || 'No reason given')}
                  </Td>
                  <Td>
                    <Button size="sm" variant="secondary" onClick={() => setAnswering(c)}>
                      Answer
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader title="Issue a certificate" />
          <div className="space-y-3 p-5">
            <Input value={search} onChange={setSearch} placeholder="Search student by name or admission no." className="w-full" />
            {search.trim().length >= 2 && (
              <div className="flex flex-wrap gap-1.5">
                {(results.data?.items ?? []).map((s) => (
                  <button
                    key={s.id} type="button" onClick={() => setStudentId(s.id)}
                    className={`rounded-md border px-2 py-1 text-[13px] ${
                      studentId === s.id ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                    }`}
                  >
                    {s.full_name} · {s.admission_no}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <Select value={type} onChange={setType} options={TYPES} />
              <Input value={reason} onChange={setReason}
                placeholder={type === 'TC' ? 'Reason for leaving' : 'Reason (optional)'} />
              <Button disabled={!studentId || issue.isPending} onClick={() => issue.mutate(false)}>
                {issue.isPending ? 'Issuing…' : 'Issue certificate'}
              </Button>
            </div>
            {type === 'TC' && (
              <>
                <p className="text-[13px] text-warning">
                  A transfer certificate exits the student and closes their enrolment. It is refused
                  while fees are owed.
                </p>
                {/* What the register asks and the record does not hold. Blank
                    nationality and category fall back to the child's record. */}
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Nationality" hint="Blank: as on the record">
                    <Input value={tc.nationality} onChange={setTcField('nationality')} placeholder="Indian" />
                  </Field>
                  <Field label="Category" hint="Blank: as on the record">
                    <Input value={tc.category} onChange={setTcField('category')} placeholder="General" />
                  </Field>
                  <Field label="NCC / Scout / Guide">
                    <Input value={tc.ncc_scout} onChange={setTcField('ncc_scout')} placeholder="No" />
                  </Field>
                  <Field label="Games / activities">
                    <Input value={tc.games} onChange={setTcField('games')} placeholder="Kabaddi, chess" />
                  </Field>
                  <Field label="General conduct">
                    <Input value={tc.conduct} onChange={setTcField('conduct')} placeholder="Good" />
                  </Field>
                  <Field label="Qualified for promotion" hint="Blank: from the last published result">
                    <Select
                      value={tc.qualified_for_promotion}
                      onChange={setTcField('qualified_for_promotion')}
                      options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
                      placeholder="From the result"
                    />
                  </Field>
                  <Field label="Last examination taken" hint="Blank: the last published card">
                    <Input value={tc.last_exam_passed} onChange={setTcField('last_exam_passed')} />
                  </Field>
                  <Field label="Date of application">
                    <Input type="date" value={tc.date_of_application} onChange={setTcField('date_of_application')} />
                  </Field>
                  <Field label="Date of issue" hint="Blank: today">
                    <Input type="date" value={tc.date_of_issue} onChange={setTcField('date_of_issue')} />
                  </Field>
                  <Field label="Dues paid up to" hint="Blank: the last bill settled">
                    <Input type="date" value={tc.dues_paid_up_to} onChange={setTcField('dues_paid_up_to')} />
                  </Field>
                  <Field label="Fee concession availed" hint="Blank: from the concession register">
                    <Input value={tc.fee_concession} onChange={setTcField('fee_concession')} placeholder="Nil" />
                  </Field>
                </div>
              </>
            )}
            {duesBlock ? (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                <p className="text-[13px]">{duesBlock.message}</p>
                <Input value={overrideReason} onChange={setOverrideReason}
                  placeholder="Why the certificate goes out anyway — recorded with your name" className="w-full" />
                <Button size="sm" variant="secondary"
                  disabled={!overrideReason.trim() || issue.isPending}
                  onClick={() => issue.mutate(true)}>
                  Issue anyway, over the dues
                </Button>
              </div>
            ) : issue.isError && (
              <p className="text-[13px] text-destructive">
                {issue.error instanceof Error ? issue.error.message : 'Could not issue'}
              </p>
            )}
            {issue.isSuccess && (
              <p className="text-[13px] text-success">
                Issued {issue.data.serial_no}.
                {issue.data.dues_overridden ? ' Dues were outstanding; the override is on the record.' : ''}
              </p>
            )}
          </div>
        </Card>

        {/* WHAT FAMILIES HAVE ASKED FOR.

            The request half of this has worked for a long time — a parent
            picks from what the school issues and the office is notified. What
            was missing was any way to ANSWER: the Issue button inserts, so a
            clerk acting on a request created a second certificate with a
            second serial and left the family's request sitting in their list
            for ever, reading "requested" a fortnight after they collected the
            document from the counter. */}
        {answering && (
          <Card>
            <CardHeader
              title={`${answering.type} for ${answering.student_name}`
                + (answering.class_name ? ` · ${answering.class_name}-${answering.section_name}` : '')}
              description={
                (answering.asked_by ? `Asked for by ${answering.asked_by}. ` : '')
                + 'What you write here is what the family reads. Everyone in the household is told, and the child.'
              }
            />
            <div className="space-y-3 p-4">
              <Select
                value={decision}
                onChange={setDecision}
                options={[
                  { value: 'issued', label: 'Ready — they can collect it' },
                  { value: 'approved', label: 'Approved, not ready yet' },
                  { value: 'cancelled', label: 'Decline' },
                ]}
              />
              <Input
                value={note}
                onChange={setNote}
                placeholder={decision === 'cancelled'
                  ? 'Why it was declined — the family will read this'
                  : 'e.g. Given to your son on Tuesday at the office'}
              />
              {decide.isError && (
                <p className="text-[13px] text-destructive">
                  {decide.error instanceof Error ? decide.error.message : 'Could not save'}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: answering.id, status: decision, note })}
                >
                  {decide.isPending ? 'Saving…' : 'Tell the family'}
                </Button>
                <Button variant="secondary" onClick={() => setAnswering(null)}>Cancel</Button>
              </div>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader title="Register" description="Every certificate issued, with its frozen snapshot" />
          {list.isLoading ? <SkeletonTable columns={7} /> : list.error ? <ErrorState error={list.error} /> : (
            <Table head={['Serial', 'Type', 'Student', 'Class at issue', 'Dues at issue', 'Issued', 'Status', '']}
              empty={!rows.length} emptyLabel="No certificates issued yet.">
              {rows.map((c) => (
                <tr key={c.serial_no}>
                  <Td className="font-mono text-[12px]">{c.serial_no}</Td>
                  <Td className="font-medium">{c.type}</Td>
                  <Td>{c.student_name}</Td>
                  <Td>{String(c.snapshot?.class ?? '—')}</Td>
                  <Td>{formatPaise(Number(c.snapshot?.dues_paise ?? 0))}</Td>
                  <Td className="text-muted-foreground">{formatDate(c.issued_on)}</Td>
                  <Td><Badge tone={statusTone(c.status)}>{c.status}</Badge></Td>
                  <Td>
                    {/* From the frozen snapshot, so a TC printed again a year
                        on says what it said the day it was handed over. */}
                    {c.status === 'issued' && (
                      <Button size="sm" variant="ghost"
                        onClick={async () => {
                          const v = await api.get<{ html: string; name?: string }>(
                            `/api/v1/lifecycle/certificates/${c.id}/render`)
                          setCard(v)
                        }}>
                        Print
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {/* THE LEAVERS A SCHOOL ALREADY HAS ON PAPER.

            This screen issues certificates one at a time, which is right for
            the child leaving on Friday and useless for the school arriving
            with a TC register covering three years. That register was
            importable, but only from inside School setup -- a first-run
            wizard nobody opens again once the school is running, and not
            where anybody would look for it.

            An importer belongs beside the work it does. Behind a line,
            because a school does this rarely and reads the certificate list
            daily. */}
        <details className="mt-5 rounded-[10px] border bg-card">
          <summary className="cursor-pointer px-5 py-3 text-[13.5px] text-muted-foreground">
            Load a TC register — children who have already left
          </summary>
          <div className="border-t p-5">
            <BulkImport
              entity="student_exits"
              title="Children who have left, from your register"
              hint={
                'The admission number, the date they left, whether they were ' +
                'transferred or simply did not return, and why. Only the ' +
                'admission number is required — a school that has the dates but ' +
                'not the reasons can upload what it has and fill the rest in ' +
                'later. Uploading again updates a child rather than exiting them twice.'
              }
              onDone={() => qc.invalidateQueries({ queryKey: ['certificates'] })}
            />
          </div>
        </details>
      </PageBody>
    </>
  )
}
