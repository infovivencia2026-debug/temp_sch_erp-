import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Paperclip } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'

/* School Quality Assessment and Accreditation, the school's half.

   The framework itself — domains, standards, indicators — is published by the
   vendor and read here; this screen never edits it. What it captures is the
   rating, the evidence behind each rating, and the gaps carried into an action
   plan with an owner and a date. The action plan is the part an inspector
   actually reads. */

interface Framework {
  code: string
  name: string
  authority: string
  version: string
  status: string
  effective_from?: string
  standards: number
  weight_bp: number
}

interface Assessment {
  id: string
  framework_code: string
  framework_name?: string
  framework_version?: string
  title: string
  status: string
  started_on?: string
  due_on?: string
  score_bp?: number
  max_score_bp?: number
  submitted_at?: string
  submitted_by?: string
  rated_count: number
  standard_count: number
  gap_count: number
  open_action_count: number
}

interface Evidence {
  id: string
  file_id?: string
  file_name?: string
  external_url?: string
  caption: string
  added_by?: string
  added_at: string
}

interface Entry {
  id: string
  standard_id: string
  standard_code?: string
  standard_name?: string
  domain_code?: string
  domain_name?: string
  rating: string
  score_bp?: number
  weight_bp: number
  evidence_required: boolean
  remarks?: string
  assessed_by?: string
  assessed_at?: string
  evidence: Evidence[]
}

interface Action {
  id: string
  assessment_id: string
  entry_id?: string
  standard_code?: string
  title: string
  detail?: string
  owner_name?: string
  due_on?: string
  priority: string
  status: string
  overdue: boolean
  assessment_title: string
}

interface Detail {
  assessment: Assessment
  entries: Entry[]
  actions: Action[]
  frozen: boolean
}

const RATINGS = [
  { value: 'not_assessed', label: 'Not assessed' },
  { value: 'not_met', label: 'Not met' },
  { value: 'partially_met', label: 'Partially met' },
  { value: 'met', label: 'Met' },
  { value: 'exceeds', label: 'Exceeds' },
  { value: 'not_applicable', label: 'Not applicable' },
]

const RATING_TONE: Record<string, 'neutral' | 'danger' | 'warning' | 'success' | 'info'> = {
  not_assessed: 'neutral',
  not_met: 'danger',
  partially_met: 'warning',
  met: 'success',
  exceeds: 'info',
  not_applicable: 'neutral',
}

const pct = (bp?: number) => (bp == null ? '—' : `${(bp / 100).toFixed(1)}%`)

export default function SQAACompliance() {
  const qc = useQueryClient()
  /* Reading a self-assessment is admin.reports.read; starting one, rating a
     standard, attaching evidence and submitting are institution.write
     (statutory.go:97-105). `!d.frozen` was the only guard, so a reader saw
     every control and got a 403 from each. */
  const can = useCan()
  const mayEdit = can('institution.write')
  const [selected, setSelected] = useState<string | null>(null)
  const [newA, setNewA] = useState({ framework_code: '', title: '', due_on: '' })
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null)
  const [ev, setEv] = useState({ external_url: '', caption: '' })
  const [action, setAction] = useState({ title: '', detail: '', due_on: '', priority: 'normal' })

  const frameworks = useQuery({
    queryKey: ['sqaa-frameworks'],
    queryFn: () => api.get<List<Framework>>('/api/v1/statutory/sqaa/frameworks'),
  })
  const list = useQuery({
    queryKey: ['sqaa-assessments'],
    queryFn: () => api.get<List<Assessment>>('/api/v1/statutory/sqaa/assessments'),
  })
  const current = selected ?? list.data?.items[0]?.id ?? null
  const detail = useQuery({
    queryKey: ['sqaa-detail', current],
    queryFn: () => api.get<Detail>(`/api/v1/statutory/sqaa/assessments/${current}`),
    enabled: !!current,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sqaa-assessments'] })
    qc.invalidateQueries({ queryKey: ['sqaa-detail'] })
  }

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/v1/statutory/sqaa/assessments', {
        framework_code: newA.framework_code,
        title: newA.title || undefined,
        due_on: newA.due_on || undefined,
      }),
    onSuccess: (r) => {
      setSelected(r.id)
      setNewA({ framework_code: '', title: '', due_on: '' })
      refresh()
    },
  })

  const rate = useMutation({
    mutationFn: (v: { standard_id: string; rating: string; remarks?: string }) =>
      api.put(`/api/v1/statutory/sqaa/assessments/${current}/entries`, v),
    onSuccess: refresh,
  })

  const submit = useMutation({
    mutationFn: (force: boolean) =>
      api.post(`/api/v1/statutory/sqaa/assessments/${current}/submit`, { force }),
    onSuccess: refresh,
  })

  const attach = useMutation({
    mutationFn: (entryID: string) =>
      api.post(`/api/v1/statutory/sqaa/entries/${entryID}/evidence`, {
        external_url: ev.external_url,
        caption: ev.caption,
      }),
    onSuccess: () => {
      setEv({ external_url: '', caption: '' })
      setEvidenceFor(null)
      refresh()
    },
  })

  const addAction = useMutation({
    mutationFn: (entryID?: string) =>
      api.post('/api/v1/statutory/sqaa/actions', {
        assessment_id: current,
        entry_id: entryID,
        title: action.title,
        detail: action.detail || undefined,
        due_on: action.due_on || undefined,
        priority: action.priority,
      }),
    onSuccess: () => {
      setAction({ title: '', detail: '', due_on: '', priority: 'normal' })
      refresh()
    },
  })

  const closeAction = useMutation({
    mutationFn: (a: Action) =>
      api.post('/api/v1/statutory/sqaa/actions', {
        id: a.id,
        title: a.title,
        status: 'done',
        priority: a.priority,
        due_on: a.due_on,
      }),
    onSuccess: refresh,
  })

  const d = detail.data

  return (
    <>
      <PageHead
        eyebrow="Boards & accreditation"
        title="SQAA compliance tracking"
        description="Rate the school against the published framework, attach the evidence, and carry every gap into an action plan with a name and a date against it."
        width="wide"
      />
      <PageBody width="wide">
        {frameworks.isLoading || list.isLoading ? (
          <Loading />
        ) : frameworks.error ? (
          <ErrorState error={frameworks.error} />
        ) : list.error ? (
          /* Only the frameworks query was checked, so a failed assessments call
             fell through and rendered the empty state: "no self-assessment
             started yet" to a school that has one. */
          <ErrorState error={list.error} />
        ) : (
          <>
            {!frameworks.data?.items.length && (
              <Card>
                <EmptyState
                  title="No framework has been published yet"
                  body="SQAA frameworks are configured at platform level under Statutory & Boards. Until one is published there is nothing for a school to assess itself against."
                />
              </Card>
            )}

            {!!frameworks.data?.items.length && (
              <Card>
                <CardHeader
                  title="Start an assessment"
                  description="Every standard in the framework is laid out unrated, so progress is visible from the first day."
                />
                <div className="space-y-3 px-5 pb-5">
                  <FormGrid>
                    <Field label="Framework" required>
                      <Select
                        value={newA.framework_code}
                        onChange={(v) => setNewA({ ...newA, framework_code: v })}
                        options={frameworks.data.items.map((f) => ({
                          value: f.code,
                          label: `${f.name} v${f.version} — ${f.authority} (${f.standards} standards)`,
                        }))}
                        placeholder="Choose a published framework"
                      />
                    </Field>
                    <Field label="Due by">
                      <Input
                        type="date"
                        value={newA.due_on}
                        onChange={(v) => setNewA({ ...newA, due_on: v })}
                      />
                    </Field>
                    <Field label="Title" hint="Defaults to the framework and year" wide>
                      <Input value={newA.title} onChange={(v) => setNewA({ ...newA, title: v })} />
                    </Field>
                  </FormGrid>
                  <Button
                    disabled={!mayEdit || !newA.framework_code || create.isPending}
                    onClick={() => create.mutate()}
                  >
                    {create.isPending ? 'Laying out the standards…' : 'Start the assessment'}
                  </Button>
                  <FormNotice error={create.error} />
                </div>
              </Card>
            )}

            {!!list.data?.items.length && (
              <Card>
                <CardHeader title="Assessments" />
                <Table
                  head={['Title', 'Framework', 'Rated', 'Gaps', 'Open actions', 'Score', 'Status', '']}
                >
                  {list.data.items.map((a) => (
                    <tr key={a.id} className={a.id === current ? 'bg-accent/40' : undefined}>
                      <Td className="font-medium">{a.title}</Td>
                      <Td>
                        {a.framework_name ?? a.framework_code}
                        {a.framework_version ? ` v${a.framework_version}` : ''}
                      </Td>
                      <Td className="tabular-nums">
                        {a.rated_count}/{a.standard_count}
                      </Td>
                      <Td className="tabular-nums">{a.gap_count || '—'}</Td>
                      <Td className="tabular-nums">{a.open_action_count || '—'}</Td>
                      <Td className="tabular-nums">{pct(a.score_bp)}</Td>
                      <Td>
                        <Badge
                          tone={
                            a.status === 'submitted' || a.status === 'closed'
                              ? 'success'
                              : a.status === 'in_progress'
                                ? 'info'
                                : 'neutral'
                          }
                        >
                          {a.status.replace(/_/g, ' ')}
                        </Badge>
                      </Td>
                      <Td>
                        <Button
                          size="sm"
                          variant="ghost"
                          /* The half-written corrective action and the evidence
                             box belong to the assessment they were typed
                             against. addAction posts `assessment_id: current`,
                             so carrying them across filed one assessment's
                             action, in its own words, against another. */
                          onClick={() => {
                            setSelected(a.id)
                            setAction({ title: '', detail: '', due_on: '', priority: 'normal' })
                            setEv({ external_url: '', caption: '' })
                            setEvidenceFor(null)
                          }}
                        >
                          Open
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}

            {detail.isLoading && current ? (
              <Loading />
            ) : detail.error ? (
              <ErrorState error={detail.error} />
            ) : d ? (
              <>
                <CellGrid cols={4}>
                  <Stat
                    label="Rated"
                    value={`${d.assessment.rated_count}/${d.assessment.standard_count}`}
                  />
                  <Stat label="Weighted score" value={pct(d.assessment.score_bp)} />
                  <Stat
                    label="Gaps"
                    value={d.assessment.gap_count}
                    hint="Rated not met or partially met"
                  />
                  <Stat
                    label="Open actions"
                    value={d.assessment.open_action_count}
                    delta={{
                      value: d.actions.some((a) => a.overdue) ? 'Some overdue' : 'On track',
                      positive: !d.actions.some((a) => a.overdue),
                    }}
                  />
                </CellGrid>

                {d.frozen && (
                  <Card>
                    <div className="flex items-start gap-3 px-5 py-4">
                      <Lock className="mt-0.5 h-4 w-4 text-muted-foreground" />
                      <div className="text-[13px]">
                        <div className="font-medium">
                          Submitted
                          {d.assessment.submitted_at
                            ? ` on ${formatDate(d.assessment.submitted_at)}`
                            : ''}
                          {d.assessment.submitted_by ? ` by ${d.assessment.submitted_by}` : ''}
                        </div>
                        <div className="text-muted-foreground">
                          Ratings and evidence are fixed. The action plan below stays live — the
                          gap is still a gap after the return has gone in.
                        </div>
                      </div>
                    </div>
                  </Card>
                )}

                <Card>
                  <CardHeader
                    title="Standards"
                    description={`${d.assessment.framework_name ?? d.assessment.framework_code} — the framework is published centrally and is not editable here.`}
                  />
                  <Table
                    head={['Domain', 'Standard', 'Weight', 'Rating', 'Evidence', 'Remarks', '']}
                    empty={!d.entries.length}
                  >
                    {d.entries.map((e) => (
                      <tr key={e.id}>
                        <Td className="text-[13px] text-muted-foreground">
                          {e.domain_name ?? e.domain_code ?? '—'}
                        </Td>
                        <Td>
                          <div className="font-medium">{e.standard_name ?? '—'}</div>
                          <div className="font-mono text-[12px] text-muted-foreground">
                            {e.standard_code ?? ''}
                          </div>
                        </Td>
                        <Td className="tabular-nums">{e.weight_bp ? pct(e.weight_bp) : '—'}</Td>
                        <Td>
                          {d.frozen || !mayEdit ? (
                            <Badge tone={RATING_TONE[e.rating] ?? 'neutral'}>
                              {e.rating.replace(/_/g, ' ')}
                            </Badge>
                          ) : (
                            <Select
                              value={e.rating}
                              onChange={(v) =>
                                rate.mutate({ standard_id: e.standard_id, rating: v, remarks: e.remarks })
                              }
                              options={RATINGS}
                            />
                          )}
                        </Td>
                        <Td>
                          <div className="space-y-1">
                            {e.evidence.map((v) => (
                              <div key={v.id} className="flex items-center gap-1 text-[12px]">
                                <Paperclip className="h-3 w-3 text-muted-foreground" />
                                {v.external_url ? (
                                  <a
                                    href={v.external_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline"
                                  >
                                    {v.caption}
                                  </a>
                                ) : (
                                  <span>{v.caption}</span>
                                )}
                              </div>
                            ))}
                            {e.evidence_required && !e.evidence.length && (
                              <Badge tone="warning">evidence required</Badge>
                            )}
                            {!d.frozen && mayEdit && evidenceFor === e.id && (
                              <div className="space-y-1 pt-1">
                                <Input
                                  value={ev.caption}
                                  onChange={(v) => setEv({ ...ev, caption: v })}
                                  placeholder="What this document shows"
                                />
                                <Input
                                  value={ev.external_url}
                                  onChange={(v) => setEv({ ...ev, external_url: v })}
                                  placeholder="Link to the document"
                                />
                                <div className="flex gap-1.5">
                                  <Button
                                    size="sm"
                                    disabled={!ev.caption || !ev.external_url}
                                    onClick={() => attach.mutate(e.id)}
                                  >
                                    Attach
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setEvidenceFor(null)}
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        </Td>
                        <Td className="max-w-xs text-[13px]">{e.remarks ?? '—'}</Td>
                        <Td>
                          {!d.frozen && mayEdit && evidenceFor !== e.id && (
                            <Button size="sm" variant="ghost" onClick={() => setEvidenceFor(e.id)}>
                              Attach evidence
                            </Button>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </Table>
                  <FormNotice error={rate.error ?? attach.error} />
                </Card>

                <Card>
                  <CardHeader
                    title="Action plan"
                    description="A gap without an owner and a date is a gap that is still there next year."
                  />
                  <div className="space-y-3 px-5 pb-5 pt-1">
                    <FormGrid>
                      <Field label="What needs doing" required wide>
                        <Input
                          value={action.title}
                          onChange={(v) => setAction({ ...action, title: v })}
                          placeholder="Run the annual fire drill and file the certificate"
                        />
                      </Field>
                      <Field label="Due by">
                        <Input
                          type="date"
                          value={action.due_on}
                          onChange={(v) => setAction({ ...action, due_on: v })}
                        />
                      </Field>
                      <Field label="Priority">
                        <Select
                          value={action.priority}
                          onChange={(v) => setAction({ ...action, priority: v })}
                          options={[
                            { value: 'low', label: 'Low' },
                            { value: 'normal', label: 'Normal' },
                            { value: 'high', label: 'High' },
                          ]}
                        />
                      </Field>
                      <Field label="Detail" wide>
                        <Textarea
                          value={action.detail}
                          onChange={(v) => setAction({ ...action, detail: v })}
                          rows={2}
                        />
                      </Field>
                    </FormGrid>
                    <Button
                      disabled={!mayEdit || !action.title.trim() || addAction.isPending}
                      onClick={() => addAction.mutate(undefined)}
                    >
                      Add to the plan
                    </Button>
                    <FormNotice error={addAction.error} />
                  </div>
                  <Table
                    head={['Action', 'Standard', 'Owner', 'Due', 'Priority', 'Status', '']}
                    empty={!d.actions.length}
                    emptyLabel="Nothing on the plan yet."
                  >
                    {d.actions.map((a) => (
                      <tr key={a.id}>
                        <Td className="font-medium">
                          {a.title}
                          {a.detail ? (
                            <div className="text-[12px] text-muted-foreground">{a.detail}</div>
                          ) : null}
                        </Td>
                        <Td className="font-mono text-[12px]">{a.standard_code ?? '—'}</Td>
                        <Td>{a.owner_name ?? 'Unassigned'}</Td>
                        <Td>
                          {a.due_on ? (
                            <span className={a.overdue ? 'text-destructive' : undefined}>
                              {formatDate(a.due_on)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </Td>
                        <Td>
                          <Badge tone={a.priority === 'high' ? 'danger' : 'neutral'}>
                            {a.priority}
                          </Badge>
                        </Td>
                        <Td>
                          <Badge
                            tone={
                              a.status === 'done'
                                ? 'success'
                                : a.overdue
                                  ? 'danger'
                                  : 'neutral'
                            }
                          >
                            {a.status.replace(/_/g, ' ')}
                          </Badge>
                        </Td>
                        <Td>
                          {mayEdit && (a.status === 'open' || a.status === 'in_progress') ? (
                            <Button size="sm" variant="ghost" onClick={() => closeAction.mutate(a)}>
                              Mark done
                            </Button>
                          ) : null}
                        </Td>
                      </tr>
                    ))}
                  </Table>
                </Card>

                {!d.frozen && mayEdit && (
                  <Card>
                    <CardHeader
                      title="Submit the assessment"
                      description="Fixes the ratings and the evidence. Unrated standards and missing required evidence are refused, because a half-rated framework reads to a board as a school that scored badly rather than one that had not finished."
                    />
                    <div className="flex flex-wrap gap-2 px-5 pb-5">
                      <Button disabled={submit.isPending} onClick={() => submit.mutate(false)}>
                        {submit.isPending ? 'Submitting…' : 'Submit'}
                      </Button>
                      <ConfirmButton
                        variant="secondary"
                        tone="danger"
                        confirmLabel="Submit incomplete"
                        question="Submit with standards still unrated or evidence missing?"
                        onConfirm={() => submit.mutate(true)}
                      >
                        Submit anyway
                      </ConfirmButton>
                    </div>
                    <div className="px-5 pb-5">
                      <FormNotice error={submit.error} />
                    </div>
                  </Card>
                )}
              </>
            ) : null}
          </>
        )}
      </PageBody>
    </>
  )
}
