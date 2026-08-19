import { useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { Gauge, GraduationCap, CalendarClock } from 'lucide-react'
import { api, ApiError, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, ConfirmButton, Field, FormGrid, FormNotice,
  Input, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* What a member of staff may see about themselves.

   The server has carried these six routes since the appraisal landed and
   nothing called them, so the status chain stopped at the point HR could
   reach: an appraisal could be raised and published, and the person it was
   about could neither write their self-assessment nor sign the outcome. The
   endpoints sit in their own group on self.profile.read (hr_growth.go:61-69)
   because a teacher holds nothing else in that file, and nesting them under
   the HR gate would 403 them out of their own record.

   Every list here is narrowed on the server from the session, never from a
   parameter this screen sends. There is no employee id in any URL below, and
   that is the whole access-control story: what the screen asks for cannot
   widen what it is given.

   Written as panels so the same code serves the teacher's own-profile screen
   — where they will actually look for it — and a page of its own if the
   catalogue ever grows a key for staff self-service. */

interface MyAppraisal {
  id: string
  cycle: string
  employee_code: string
  full_name: string
  designation?: string
  department?: string
  reviewer?: string
  status: string
  self_score?: number
  reviewer_score?: number
  final_score?: number
  final_band?: string
  score_scale_max: number
  discussion_on?: string
  increment_percent?: number
  published_at?: string
  acknowledged: boolean
}

interface Rating {
  id: string
  kpi_id: string
  code: string
  title: string
  description?: string
  source: string
  weight: number
  self_score?: number
  self_note?: string
  reviewer_score?: number
  reviewer_note?: string
  moderated_score?: number
}

interface MyAppraisalDetail extends MyAppraisal {
  self_comments?: string
  reviewer_comments?: string
  discussion_note?: string
  employee_comments?: string
  ratings: Rating[]
}

interface MyTraining {
  id: string
  programme: string
  provider?: string
  starts_on: string
  status: string
  attended_on?: string
  hours_completed?: number
  score?: number
  certificate_no?: string
  certificate_issued_on?: string
  counts_towards_requirement: boolean
}

interface MyDuty {
  id: string
  shift_code: string
  shift_name: string
  duty_kind: string
  is_onerous: boolean
  on_date: string
  starts_at: string
  ends_at: string
  status: string
  notes?: string
}

const STATUS_LABEL: Record<string, string> = {
  not_started: 'Yours to fill in',
  self_submitted: 'Self-assessment sent',
  published: 'Published — please acknowledge',
  acknowledged: 'Acknowledged',
}

function statusTone(s: string) {
  if (s === 'acknowledged') return 'success' as const
  if (s === 'published') return 'primary' as const
  if (s === 'not_started') return 'neutral' as const
  return 'info' as const
}

/* A staff record is what makes any of this meaningful, and its absence is an
   answer rather than a failure: a guardian or a student signing in has none.
   Anything else that comes back is a fault and says so — "no appraisal yet"
   from a 500 would be this screen making a claim about the school that it
   never actually checked. */
function notStaff(e: unknown) {
  return e instanceof ApiError && e.status === 404 && e.code === 'not_staff'
}

function thisMonth() {
  const now = new Date()
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return {
    from: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
  }
}

export default function MyGrowth() {
  return (
    <>
      <PageHead
        eyebrow="My profile"
        title="My appraisal, training and duties"
        description="Your own record and nobody else's: the appraisal you are asked to assess yourself against and to sign, the training hours logged in your name, and the duties you are rostered for."
      />
      <PageBody>
        <MyGrowthPanels />
      </PageBody>
    </>
  )
}

export function MyGrowthPanels({
  /* On a page of its own, "you have no staff record" is the answer to why the
     page is empty and has to be said. Embedded in a profile screen that a
     student or a guardian may also open, it is an answer to a question they
     never asked, so the panels simply do not appear. Either way it is decided
     by the server's reply, never by guessing from a role. */
  quiet,
}: { quiet?: boolean } = {}) {
  const appraisals = useQuery({
    queryKey: ['hr-self', 'appraisals'],
    queryFn: () => api.get<List<MyAppraisal>>('/api/v1/hr-growth/me/appraisals'),
    retry: false,
  })

  /* One query decides it for all three panels: the same staff record backs
     every one of them, so asking three times in order to hide three panels
     would be three identical 404s. */
  if (notStaff(appraisals.error)) {
    if (quiet) return null
    return (
      <EmptyState
        title="You have no staff record in this school"
        body="Appraisals, training hours and duty rosters are kept against a staff record. Ask the office if you believe you should have one."
      />
    )
  }

  return (
    <>
      <MyAppraisalsPanel query={appraisals} />
      <MyTrainingPanel />
      <MyDutiesPanel />
    </>
  )
}

/* The appraisal.

   Only the stages that are the employee's own business are listed by the
   server: not_started, self_submitted, published and acknowledged. What a
   reviewer has typed but not published is not here, and this screen does not
   pretend it is missing — it says nothing about it at all. */
function MyAppraisalsPanel({
  query,
}: {
  query: UseQueryResult<List<MyAppraisal>, unknown>
}) {
  const [openID, setOpenID] = useState('')

  const rows = query.data?.items ?? []
  const awaiting = rows.filter((a) => a.status === 'not_started').length
  const toSign = rows.filter((a) => a.status === 'published').length

  return (
    <>
      <CellGrid cols={3}>
        <Stat label="My appraisals" value={rows.length} icon={Gauge} />
        <Stat
          label="Awaiting my self-assessment"
          value={awaiting}
          hint={awaiting ? 'Your reviewer cannot rate you until this is in' : undefined}
        />
        <Stat
          label="Awaiting my acknowledgement"
          value={toSign}
          hint={toSign ? 'A published score is not closed until you sign it' : undefined}
        />
      </CellGrid>

      <Card>
        <CardHeader
          title="My appraisals"
          description="Yours alone. The score shown is the final one once published — never a draft somebody is still calibrating."
        />
        {query.isLoading ? (
          <Loading label="Reading your appraisals…" />
        ) : query.error ? (
          <ErrorState error={query.error} />
        ) : (
          <Table
            head={['Cycle', 'Reviewer', 'Status', { label: 'Score', align: 'right' }, '']}
            empty={rows.length === 0}
            emptyLabel="No appraisal has been raised for you yet."
          >
            {rows.map((a) => (
              <tr key={a.id}>
                <Td>
                  <span className="font-medium">{a.cycle}</span>
                  {a.designation && (
                    <span className="block text-[12.5px] text-muted-foreground">
                      {a.designation}
                    </span>
                  )}
                </Td>
                <Td>{a.reviewer ?? <span className="text-muted-foreground">Not named yet</span>}</Td>
                <Td><Badge tone={statusTone(a.status)}>{STATUS_LABEL[a.status] ?? a.status}</Badge></Td>
                <Td className="text-right">
                  {a.final_score != null ? (
                    <span className="font-medium">
                      {a.final_score.toFixed(2)} / {a.score_scale_max}
                      {a.final_band && (
                        <span className="block text-[12.5px] font-normal text-muted-foreground">
                          {a.final_band}
                        </span>
                      )}
                    </span>
                  ) : a.self_score != null ? (
                    <span className="text-muted-foreground">
                      {a.self_score.toFixed(2)} self-assessed
                    </span>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpenID(openID === a.id ? '' : a.id)}
                  >
                    {openID === a.id ? 'Close' : 'Open'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {/* Keyed by the appraisal. Every field in the form below is initialised
          from the record, and a form that survives the swap posts last
          cycle's answers against this one. */}
      {openID && <MyAppraisalCard key={openID} id={openID} onClose={() => setOpenID('')} />}
    </>
  )
}

function MyAppraisalCard({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['hr-self', 'appraisal', id],
    queryFn: () => api.get<MyAppraisalDetail>(`/api/v1/hr-growth/me/appraisals/${id}`),
  })

  if (detail.isLoading) return <Card><Loading label="Reading the appraisal…" /></Card>
  if (detail.error) return <Card><ErrorState error={detail.error} /></Card>
  if (!detail.data) return null

  return <MyAppraisalForm key={detail.data.id} appraisal={detail.data} onClose={onClose} />
}

function MyAppraisalForm({
  appraisal, onClose,
}: { appraisal: MyAppraisalDetail; onClose: () => void }) {
  const qc = useQueryClient()
  const editable = appraisal.status === 'not_started' || appraisal.status === 'self_submitted'

  /* Scores as text, deliberately.

     An empty box is not a zero. Held as the string the person typed, an
     untouched box and one they cleared are both '' and both send null, which
     is "no score" — whereas Number('') is 0, and a zero against a KPI is a
     judgement nobody made. */
  const [scores, setScores] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      appraisal.ratings.map((r) => [r.kpi_id, r.self_score != null ? String(r.self_score) : '']),
    ),
  )
  const [notes, setNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(appraisal.ratings.map((r) => [r.kpi_id, r.self_note ?? ''])),
  )
  const [comments, setComments] = useState(appraisal.self_comments ?? '')
  const [reply, setReply] = useState(appraisal.employee_comments ?? '')

  const max = appraisal.score_scale_max
  const badScore = appraisal.ratings.some((r) => {
    const raw = (scores[r.kpi_id] ?? '').trim()
    if (raw === '') return false
    const n = Number(raw)
    return !Number.isFinite(n) || n < 0 || n > max
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['hr-self'] })
    qc.invalidateQueries({ queryKey: ['hr-growth'] })
  }

  const submit = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/hr-growth/me/appraisals/${appraisal.id}/self-assessment`, {
        ratings: appraisal.ratings.map((r) => {
          const raw = (scores[r.kpi_id] ?? '').trim()
          return {
            kpi_id: r.kpi_id,
            score: raw === '' ? null : Number(raw),
            note: (notes[r.kpi_id] ?? '').trim() || undefined,
          }
        }),
        comments: comments.trim() || undefined,
      }),
    onSuccess: invalidate,
  })

  const acknowledge = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/hr-growth/me/appraisals/${appraisal.id}/acknowledge`, {
        comments: reply.trim() || undefined,
      }),
    onSuccess: invalidate,
  })

  return (
    <>
      <Card>
        <CardHeader
          title={`${appraisal.cycle} — my appraisal`}
          description={
            editable
              ? 'Rate yourself against each KPI and say why. Your reviewer reads this before they rate you, and the weighted total is worked out by the school rather than by this page.'
              : 'The ratings as they stand. Self-assessment closes once the cycle moves past it.'
          }
          action={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}
        />
        <Table
          head={[
            'KPI',
            { label: 'Weight %', align: 'right' },
            { label: `My score (of ${max})`, align: 'right' },
            'Why',
          ]}
          empty={appraisal.ratings.length === 0}
          emptyLabel="No KPIs are attached to this appraisal."
        >
          {appraisal.ratings.map((r) => (
            <tr key={r.kpi_id}>
              <Td>
                <span className="font-medium">{r.title}</span>
                <span className="block text-[12.5px] text-muted-foreground">
                  {r.code}
                  {r.description ? ` — ${r.description}` : ''}
                </span>
              </Td>
              <Td className="text-right tabular-nums">{r.weight}</Td>
              <Td className="text-right">
                {editable ? (
                  <Input
                    type="number"
                    srLabel={`My score out of ${max} for ${r.title}`}
                    value={scores[r.kpi_id] ?? ''}
                    onChange={(v) => setScores({ ...scores, [r.kpi_id]: v })}
                  />
                ) : (
                  <span className="tabular-nums">
                    {r.self_score != null ? r.self_score.toFixed(2) : '—'}
                  </span>
                )}
              </Td>
              <Td>
                {editable ? (
                  <Input
                    srLabel={`My note for ${r.title}`}
                    placeholder="Took the Class 9 remedial group all year"
                    value={notes[r.kpi_id] ?? ''}
                    onChange={(v) => setNotes({ ...notes, [r.kpi_id]: v })}
                  />
                ) : (
                  <span className="text-muted-foreground">{r.self_note ?? '—'}</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>

        <div className="space-y-5 p-5">
          {editable ? (
            <>
              <Field label="Anything else about this year" wide>
                <Textarea
                  value={comments}
                  onChange={setComments}
                  rows={3}
                  placeholder="Ran the science exhibition; would like training on the new assessment framework."
                />
              </Field>
              <FormNotice
                error={submit.error}
                ok={submit.isSuccess ? 'Self-assessment sent to your reviewer.' : undefined}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => submit.mutate()} disabled={badScore || submit.isPending}>
                  {submit.isPending ? 'Sending…' : 'Send my self-assessment'}
                </Button>
                <span className="text-[13px] text-muted-foreground">
                  {badScore
                    ? `Every score must be a number between 0 and ${max}.`
                    : 'You may send it again while the cycle is still open. A box left empty is sent as no score, not as a zero.'}
                </span>
              </div>
            </>
          ) : (
            <FormGrid>
              <Field label="What I said">
                <p className="text-[14px] text-muted-foreground">{appraisal.self_comments ?? '—'}</p>
              </Field>
              <Field label="What my reviewer said">
                <p className="text-[14px] text-muted-foreground">
                  {appraisal.reviewer_comments ?? '—'}
                </p>
              </Field>
            </FormGrid>
          )}
        </div>
      </Card>

      {(appraisal.status === 'published' || appraisal.status === 'acknowledged') && (
        <Card>
          <CardHeader
            title="The outcome"
            description="The final score, the band it falls in, and your right of reply."
          />
          <div className="space-y-5 p-5">
            <CellGrid cols={3}>
              <Stat
                label="Final score"
                value={
                  appraisal.final_score != null
                    ? `${appraisal.final_score.toFixed(2)} / ${max}`
                    : '—'
                }
                hint={appraisal.final_band ?? undefined}
              />
              <Stat
                label="Increment"
                value={
                  appraisal.increment_percent != null
                    ? `${appraisal.increment_percent}%`
                    : 'Not stated'
                }
              />
              <Stat
                label="Published"
                value={appraisal.published_at ? formatDate(appraisal.published_at) : '—'}
                hint={
                  appraisal.discussion_on
                    ? `Discussed on ${formatDate(appraisal.discussion_on)}`
                    : undefined
                }
              />
            </CellGrid>

            {appraisal.reviewer_comments && (
              <Field label="Your reviewer's comments" wide>
                <p className="text-[14px] text-muted-foreground">{appraisal.reviewer_comments}</p>
              </Field>
            )}
            {appraisal.discussion_note && (
              <Field label="Note of the appraisal conversation" wide>
                <p className="text-[14px] text-muted-foreground">{appraisal.discussion_note}</p>
              </Field>
            )}

            {appraisal.status === 'acknowledged' ? (
              <Field label="What I said when I acknowledged this" wide>
                <p className="text-[14px] text-muted-foreground">
                  {appraisal.employee_comments ?? 'Acknowledged without comment.'}
                </p>
              </Field>
            ) : (
              <>
                <Field
                  label="Your reply, if you have one"
                  hint="Filed with your acknowledgement and read alongside the score. Write it before you sign — there is no way to add it afterwards."
                  wide
                >
                  <Textarea
                    value={reply}
                    onChange={setReply}
                    rows={3}
                    placeholder="I accept the rating but would like the remedial group counted next year."
                  />
                </Field>
                <FormNotice error={acknowledge.error} />
                {/* An acknowledgement is a signature, so it asks first and
                    says what it means. Nothing takes it back — no endpoint
                    moves an appraisal out of 'acknowledged' — and a control
                    that looked reversible would be lying about that. */}
                <ConfirmButton
                  variant="primary"
                  size="md"
                  confirmLabel="Acknowledge"
                  question="Signs off this score and files your reply. This cannot be undone."
                  disabled={acknowledge.isPending}
                  onConfirm={() => acknowledge.mutate()}
                >
                  {acknowledge.isPending ? 'Signing…' : 'Acknowledge this appraisal'}
                </ConfirmButton>
              </>
            )}
          </div>
        </Card>
      )}
    </>
  )
}

/* Training.

   The hours the school will be asked to evidence, in the name of the person
   who sat them. The requirement itself is HR's number and this endpoint does
   not carry it, so the panel counts what counts rather than asserting a
   shortfall against a target it was never told. */
function MyTrainingPanel() {
  const q = useQuery({
    queryKey: ['hr-self', 'training'],
    queryFn: () => api.get<List<MyTraining>>('/api/v1/hr-growth/me/training'),
    retry: false,
  })

  const rows = q.data?.items ?? []
  const counted = rows
    .filter((t) => t.status === 'completed' && t.counts_towards_requirement)
    .reduce((n, t) => n + (t.hours_completed ?? 0), 0)
  const certificates = rows.filter((t) => t.certificate_no).length

  if (notStaff(q.error)) return null

  return (
    <Card>
      <CardHeader
        title="My training"
        description="Every programme logged against you, and how much of it counts towards the school's training requirement."
        action={
          <span className="text-[13px] text-muted-foreground">
            <GraduationCap className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
            {counted.toFixed(1)} hours counted · {certificates} certificate(s)
          </span>
        }
      />
      {q.isLoading ? (
        <Loading label="Reading your training record…" />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : (
        <Table
          head={[
            'Programme', 'Provider', 'Attended',
            { label: 'Hours', align: 'right' }, 'Counts', 'Status', 'Certificate',
          ]}
          empty={rows.length === 0}
          emptyLabel="No training has been logged against you yet."
        >
          {rows.map((t) => (
            <tr key={t.id}>
              <Td><span className="font-medium">{t.programme}</span></Td>
              <Td className="text-muted-foreground">{t.provider ?? '—'}</Td>
              <Td className="text-muted-foreground">{formatDate(t.attended_on ?? t.starts_on)}</Td>
              <Td className="text-right tabular-nums">
                {t.hours_completed != null ? t.hours_completed.toFixed(1) : '—'}
              </Td>
              <Td>
                {t.counts_towards_requirement
                  ? <Badge tone="success">Counts</Badge>
                  : <Badge tone="neutral">Does not count</Badge>}
              </Td>
              <Td>
                <Badge tone={t.status === 'completed' ? 'success' : 'info'}>
                  {t.status.replace(/_/g, ' ')}
                </Badge>
              </Td>
              <Td className="text-muted-foreground">
                {t.certificate_no
                  ? `${t.certificate_no}${t.certificate_issued_on ? ` · ${formatDate(t.certificate_issued_on)}` : ''}`
                  : '—'}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

/* Duties.

   The gate at seven, dispersal at three, invigilation in March. Shown for a
   window rather than "what is coming", because the question a teacher asks of
   a roster is as often "was I on the gate last Tuesday" as "am I on it
   tomorrow". */
function MyDutiesPanel() {
  const [range, setRange] = useState(thisMonth)

  const q = useQuery({
    queryKey: ['hr-self', 'duties', range],
    queryFn: () =>
      api.get<List<MyDuty>>(`/api/v1/hr-growth/me/duties?from=${range.from}&to=${range.to}`),
    retry: false,
  })

  const rows = q.data?.items ?? []
  const onerous = rows.filter((d) => d.is_onerous).length

  if (notStaff(q.error)) return null

  return (
    <Card>
      <CardHeader
        title="My duties"
        description="Non-teaching duty only — the gate, the ground, dispersal, escorts and invigilation. Your lessons are on your timetable."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              srLabel="Duties from"
              value={range.from}
              onChange={(v) => setRange({ ...range, from: v })}
            />
            <Input
              type="date"
              srLabel="Duties to"
              value={range.to}
              onChange={(v) => setRange({ ...range, to: v })}
            />
          </div>
        }
      />
      <div className="p-5">
        <CellGrid cols={2}>
          <Stat label="Duties in this window" value={rows.length} icon={CalendarClock} />
          <Stat
            label="Of them onerous"
            value={onerous}
            hint="Early, late or outdoor duty — what a fair roster shares out"
          />
        </CellGrid>
      </div>
      {q.isLoading ? (
        <Loading label="Reading your duty roster…" />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : (
        <Table
          head={['Date', 'Duty', 'From', 'To', 'Status', 'Note']}
          empty={rows.length === 0}
          emptyLabel="You are not rostered for any duty in this window."
        >
          {rows.map((d) => (
            <tr key={d.id}>
              <Td className="font-medium">{formatDate(d.on_date)}</Td>
              <Td>
                {d.shift_name}
                <span className="block text-[12.5px] text-muted-foreground">
                  {d.shift_code} · {d.duty_kind.replace(/_/g, ' ')}
                  {d.is_onerous ? ' · onerous' : ''}
                </span>
              </Td>
              <Td className="tabular-nums">{d.starts_at}</Td>
              <Td className="tabular-nums">{d.ends_at}</Td>
              <Td>
                <Badge tone={d.status === 'assigned' ? 'info' : 'neutral'}>
                  {d.status.replace(/_/g, ' ')}
                </Badge>
              </Td>
              <Td className="text-muted-foreground">{d.notes ?? '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
