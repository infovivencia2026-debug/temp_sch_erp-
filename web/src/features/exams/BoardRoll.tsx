import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, FileWarning, Send, Users } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  ConfirmButton, Checkbox, Field, FormGrid, FormNotice, Input, Select, Loading,
  ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* The nominal roll for one board examination.

   One component behind two catalogue entries: the SSC roll and the
   Intermediate roll differ in the board, the class that sits it and whether a
   group is asked for, and in nothing else. Two screens would be two places to
   fix the same defect.

   The screen is built around the one distinction the module turns on. A draft
   can be corrected in place; a submitted candidate cannot, and the row's
   controls change accordingly — "correct" becomes "raise an amendment", which
   asks for a reason because the board does. The numbers the board issues come
   back through their own panel rather than the correction window, since they
   are the board's facts and not a correction to anything the school said. */

export interface RollProps {
  stage: 'ssc' | 'inter_first_year' | 'inter_second_year'
  eyebrow: string
  title: string
  description: string
  defaultBoard: string
  defaultExamName: string
  defaultSubjects: string
  /** Groups are an Intermediate thing; the SSC has none. */
  groups?: string[]
}

interface Candidate {
  id: string
  student_id: string
  admission_no: string
  candidate_name: string
  school_record_name: string
  class_name: string
  board: string
  exam_name: string
  stage: string
  candidate_type: string
  group_code?: string
  medium?: string
  second_language?: string
  father_name?: string
  mother_name?: string
  date_of_birth?: string
  apaar_id?: string
  registration_no?: string
  hall_ticket_no?: string
  subjects: string[]
  status: string
  verified: boolean
  submitted_on?: string
  board_ack_no?: string
  open_amendments: number
  problems: string[]
  locked: boolean
}

interface RollResponse {
  items: Candidate[]
  summary: Record<string, number>
}

interface Eligible {
  student_id: string
  admission_no: string
  name: string
  class_name: string
  date_of_birth?: string
  father_name?: string
  medium?: string
}

interface SubmitResult {
  submitted: number
  already_submitted: number
  held_back: number
  submitted_on: string
  rejected: { registration_id: string; candidate_name: string; admission_no: string; problems: string[] }[]
}

interface Amendment {
  id: string
  registration_id: string
  candidate_name: string
  admission_no: string
  field: string
  old_value?: string
  new_value?: string
  reason: string
  status: string
  board_ref?: string
  requested_at: string
}

const AMENDABLE = [
  'candidate_name', 'father_name', 'mother_name', 'date_of_birth', 'medium',
  'second_language', 'group_code', 'candidate_type', 'apaar_id',
  'registration_no', 'hall_ticket_no',
]

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'primary'> = {
  draft: 'neutral',
  verified: 'warning',
  submitted: 'primary',
  accepted: 'success',
  hall_ticket_issued: 'success',
  rejected: 'danger',
}

export function BoardRoll(props: RollProps) {
  const qc = useQueryClient()
  const [board, setBoard] = useState(props.defaultBoard)
  const [examName, setExamName] = useState(props.defaultExamName)
  const [subjects, setSubjects] = useState(props.defaultSubjects)
  const [group, setGroup] = useState(props.groups?.[0] ?? '')
  const [picked, setPicked] = useState<string[]>([])
  const [selected, setSelected] = useState<Candidate | null>(null)
  const [edit, setEdit] = useState({ candidate_name: '', father_name: '', mother_name: '', date_of_birth: '', medium: '' })
  const [amend, setAmend] = useState({ field: 'candidate_name', new_value: '', reason: '' })
  const [response, setResponse] = useState({ registration_no: '', hall_ticket_no: '', status: 'accepted' })
  const [ackNo, setAckNo] = useState('')

  const roll = useQuery({
    queryKey: ['board-roll', props.stage],
    queryFn: () => api.get<RollResponse>(`/api/v1/exams/board/registrations?stage=${props.stage}`),
  })
  const eligible = useQuery({
    queryKey: ['board-eligible', props.stage],
    queryFn: () => api.get<List<Eligible>>(`/api/v1/exams/board/eligible?stage=${props.stage}`),
  })
  const amendments = useQuery({
    queryKey: ['board-amendments', props.stage],
    queryFn: () => api.get<List<Amendment>>(`/api/v1/exams/board/amendments?stage=${props.stage}`),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['board-roll', props.stage] })
    qc.invalidateQueries({ queryKey: ['board-eligible', props.stage] })
    qc.invalidateQueries({ queryKey: ['board-amendments', props.stage] })
    setSelected(null)
  }

  const add = useMutation({
    mutationFn: () =>
      api.post('/api/v1/exams/board/registrations', {
        student_ids: picked,
        board,
        exam_name: examName,
        stage: props.stage,
        group_code: props.groups ? group : '',
        subjects: subjects.split(',').map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: () => { setPicked([]); refresh() },
  })
  const verify = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/exams/board/registrations/${id}/verify`, {}),
    onSuccess: refresh,
  })
  const correct = useMutation({
    mutationFn: (id: string) => api.put(`/api/v1/exams/board/registrations/${id}`, edit),
    onSuccess: refresh,
  })
  const submit = useMutation({
    mutationFn: () =>
      api.post<SubmitResult>('/api/v1/exams/board/submit', {
        stage: props.stage, exam_name: examName, board_ack_no: ackNo,
      }),
    onSuccess: refresh,
  })
  const raise = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/exams/board/registrations/${id}/amendments`, amend),
    onSuccess: () => { setAmend({ field: 'candidate_name', new_value: '', reason: '' }); refresh() },
  })
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: string }) =>
      api.post(`/api/v1/exams/board/amendments/${v.id}/decide`, { decision: v.decision }),
    onSuccess: refresh,
  })
  const record = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/exams/board/registrations/${id}/board-response`, response),
    onSuccess: refresh,
  })

  if (roll.isLoading) return <Loading label="Reading the roll…" />
  if (roll.error) return <ErrorState error={roll.error} />

  const rows = roll.data?.items ?? []
  const s = roll.data?.summary ?? {}
  const pending = amendments.data?.items.filter((a) => a.status === 'requested' || a.status === 'sent') ?? []
  const result = submit.data

  return (
    <>
      <PageHead
        eyebrow={props.eyebrow}
        title={props.title}
        description={props.description}
        actions={
          <ConfirmButton
            variant="primary"
            size="md"
            confirmLabel="Submit the roll"
            question="Sent once. Afterwards a change is an amendment."
            onConfirm={() => submit.mutate()}
            disabled={submit.isPending || !(s.draft || s.verified)}
          >
            Submit {(s.draft ?? 0) + (s.verified ?? 0)} candidate(s)
          </ConfirmButton>
        }
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="On the roll" value={s.candidates ?? 0} icon={Users} />
          <Stat
            label="Checked, not yet sent"
            value={s.verified ?? 0}
            icon={CheckCircle2}
            hint={`${s.draft ?? 0} still in draft`}
          />
          <Stat label="Sent to the board" value={s.submitted ?? 0} icon={Send} />
          <Stat
            label="Would be rejected"
            value={s.incomplete ?? 0}
            icon={FileWarning}
            hint="Missing something the board asks for"
          />
        </CellGrid>

        {result && (
          <Card>
            <CardHeader
              title={`${result.submitted} candidate(s) submitted on ${formatDate(result.submitted_on)}`}
              description={
                result.held_back
                  ? `${result.held_back} were held back rather than sent. The board would have rejected them, and the rest of the roll went without them.`
                  : 'Every candidate on the roll was accepted for submission.'
              }
            />
            {result.held_back > 0 && (
              <Table head={['Candidate', 'Admission no', 'What is missing']}>
                {result.rejected.map((r) => (
                  <tr key={r.registration_id}>
                    <Td className="font-medium">{r.candidate_name}</Td>
                    <Td>{r.admission_no}</Td>
                    <Td className="text-destructive">{r.problems.join('; ')}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        <Card>
          <CardHeader
            title="The roll"
            description="What the school has entered, and what the board has said about it. A submitted candidate can no longer be edited — corrections after submission are amendments."
          />
          {rows.length === 0 ? (
            <EmptyState
              title="Nobody entered yet"
              body="Choose candidates below and add them to the roll."
            />
          ) : (
            <Table
              head={[
                'Candidate', 'Admission no', 'Class', 'Date of birth', "Father's name",
                'Medium', ...(props.groups ? ['Group'] : []), 'Registration no',
                'Hall ticket', 'Status', '',
              ]}
            >
              {rows.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">
                    {c.candidate_name}
                    {c.candidate_name !== c.school_record_name && (
                      <span className="block text-[12px] text-muted-foreground">
                        school record: {c.school_record_name}
                      </span>
                    )}
                    {c.problems.length > 0 && (
                      <span className="block text-[12px] text-destructive">
                        {c.problems.join('; ')}
                      </span>
                    )}
                  </Td>
                  <Td>{c.admission_no}</Td>
                  <Td>{c.class_name}</Td>
                  <Td>{c.date_of_birth ? formatDate(c.date_of_birth) : '—'}</Td>
                  <Td>{c.father_name ?? '—'}</Td>
                  <Td>{c.medium ?? '—'}</Td>
                  {props.groups && <Td>{c.group_code ?? '—'}</Td>}
                  <Td className="tabular-nums">{c.registration_no ?? '—'}</Td>
                  <Td className="tabular-nums">{c.hall_ticket_no ?? '—'}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>
                      {c.status.replace(/_/g, ' ')}
                    </Badge>
                    {c.open_amendments > 0 && (
                      <span className="block text-[12px] text-muted-foreground">
                        {c.open_amendments} correction(s) open
                      </span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex gap-2">
                      {!c.locked && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={verify.isPending || c.problems.length > 0}
                          title={c.problems.length ? c.problems.join('; ') : 'Checked against the certificate'}
                          onClick={() => verify.mutate(c.id)}
                        >
                          Check
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setSelected(c)
                          setEdit({
                            candidate_name: c.candidate_name,
                            father_name: c.father_name ?? '',
                            mother_name: c.mother_name ?? '',
                            date_of_birth: c.date_of_birth ?? '',
                            medium: c.medium ?? '',
                          })
                        }}
                      >
                        {c.locked ? 'Amend' : 'Correct'}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <div className="px-5 pb-5">
            <FormNotice error={verify.error ?? submit.error} />
          </div>
        </Card>

        {selected && !selected.locked && (
          <Card>
            <CardHeader
              title={`Correct ${selected.candidate_name}`}
              description="Still a draft, so the particulars can be changed in place. Correcting a row clears its check — somebody has to look at the new values."
            />
            <div className="space-y-5 p-5">
              <FormGrid>
                <Field label="Name as it must appear on the certificate">
                  <Input value={edit.candidate_name} onChange={(v) => setEdit({ ...edit, candidate_name: v })} />
                </Field>
                <Field label="Father's name">
                  <Input value={edit.father_name} onChange={(v) => setEdit({ ...edit, father_name: v })} />
                </Field>
                <Field label="Mother's name">
                  <Input value={edit.mother_name} onChange={(v) => setEdit({ ...edit, mother_name: v })} />
                </Field>
                <Field label="Date of birth" hint="As on the birth certificate, yyyy-mm-dd">
                  <Input type="date" value={edit.date_of_birth} onChange={(v) => setEdit({ ...edit, date_of_birth: v })} />
                </Field>
                <Field label="Medium of instruction">
                  <Input value={edit.medium} onChange={(v) => setEdit({ ...edit, medium: v })} />
                </Field>
              </FormGrid>
              <div className="flex gap-2">
                <Button disabled={correct.isPending} onClick={() => correct.mutate(selected.id)}>
                  Save the correction
                </Button>
                <Button variant="ghost" onClick={() => setSelected(null)}>Close</Button>
              </div>
              <FormNotice error={correct.error} />
            </div>
          </Card>
        )}

        {selected && selected.locked && (
          <>
            <Card>
              <CardHeader
                title={`Amend ${selected.candidate_name}`}
                description="This candidate has been sent. The board holds a copy, so the change is recorded as a correction with a before, an after and a reason, and the school's own copy moves only when the board accepts it."
              />
              <div className="space-y-5 p-5">
                <FormGrid>
                  <Field label="What is being corrected">
                    <Select
                      value={amend.field}
                      onChange={(v) => setAmend({ ...amend, field: v })}
                      options={AMENDABLE.map((f) => ({ value: f, label: f.replace(/_/g, ' ') }))}
                    />
                  </Field>
                  <Field label="What it should say">
                    <Input value={amend.new_value} onChange={(v) => setAmend({ ...amend, new_value: v })} />
                  </Field>
                  <Field label="Why" hint="The board asks, and so will an inspection." wide>
                    <Input
                      value={amend.reason}
                      onChange={(v) => setAmend({ ...amend, reason: v })}
                      placeholder="Spelling on the birth certificate"
                    />
                  </Field>
                </FormGrid>
                <div className="flex gap-2">
                  <Button
                    disabled={raise.isPending || !amend.reason.trim()}
                    onClick={() => raise.mutate(selected.id)}
                  >
                    Raise the correction
                  </Button>
                  <Button variant="ghost" onClick={() => setSelected(null)}>Close</Button>
                </div>
                <FormNotice error={raise.error} />
              </div>
            </Card>

            <Card>
              <CardHeader
                title="What the board sent back"
                description="A registration or hall ticket number is the board's own fact, not a correction to anything the school claimed, so it is recorded here rather than through the correction window."
              />
              <div className="space-y-5 p-5">
                <FormGrid>
                  <Field label="Registration number">
                    <Input
                      value={response.registration_no}
                      onChange={(v) => setResponse({ ...response, registration_no: v })}
                    />
                  </Field>
                  <Field label="Hall ticket number">
                    <Input
                      value={response.hall_ticket_no}
                      onChange={(v) => setResponse({ ...response, hall_ticket_no: v })}
                    />
                  </Field>
                  <Field label="What the board decided">
                    <Select
                      value={response.status}
                      onChange={(v) => setResponse({ ...response, status: v })}
                      options={[
                        { value: 'accepted', label: 'Accepted' },
                        { value: 'hall_ticket_issued', label: 'Hall ticket issued' },
                        { value: 'rejected', label: 'Rejected' },
                      ]}
                    />
                  </Field>
                </FormGrid>
                <Button disabled={record.isPending} onClick={() => record.mutate(selected.id)}>
                  Record it
                </Button>
                <FormNotice error={record.error} />
              </div>
            </Card>
          </>
        )}

        {pending.length > 0 && (
          <Card>
            <CardHeader
              title="Corrections with the board"
              description="Raised after submission and not yet settled. The school's own copy changes only when the board accepts."
            />
            <Table head={['Candidate', 'Field', 'As sent', 'Should read', 'Reason', 'Raised', 'Status', '']}>
              {pending.map((a) => (
                <tr key={a.id}>
                  <Td className="font-medium">{a.candidate_name}</Td>
                  <Td>{a.field.replace(/_/g, ' ')}</Td>
                  <Td className="text-muted-foreground">{a.old_value ?? '—'}</Td>
                  <Td>{a.new_value ?? '—'}</Td>
                  <Td className="text-muted-foreground">{a.reason}</Td>
                  <Td>{a.requested_at}</Td>
                  <Td><Badge tone={a.status === 'sent' ? 'warning' : 'neutral'}>{a.status}</Badge></Td>
                  <Td>
                    <div className="flex gap-2">
                      {a.status === 'requested' && (
                        <Button size="sm" variant="secondary" onClick={() => decide.mutate({ id: a.id, decision: 'sent' })}>
                          Sent to the board
                        </Button>
                      )}
                      <Button size="sm" onClick={() => decide.mutate({ id: a.id, decision: 'accepted' })}>
                        Board accepted
                      </Button>
                      <Button size="sm" variant="ghost" tone="danger" onClick={() => decide.mutate({ id: a.id, decision: 'rejected' })}>
                        Refused
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
            <div className="px-5 pb-5"><FormNotice error={decide.error} /></div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Add candidates"
            description="Particulars are copied from the child's own record as the draft is made, and stay as they were sent even if the record is later corrected."
            action={
              <Button
                disabled={picked.length === 0 || add.isPending}
                onClick={() => add.mutate()}
              >
                Add {picked.length || ''} to the roll
              </Button>
            }
          />
          <div className="space-y-5 p-5">
            <FormGrid>
              <Field label="Board">
                <Input value={board} onChange={setBoard} />
              </Field>
              <Field label="Examination" hint="As the board names it on the notification.">
                <Input value={examName} onChange={setExamName} />
              </Field>
              <Field label="Subjects" hint="Comma separated, in the order the board asks for them." wide>
                <Input value={subjects} onChange={setSubjects} />
              </Field>
              {props.groups && (
                <Field label="Group">
                  <Select
                    value={group}
                    onChange={setGroup}
                    options={props.groups.map((g) => ({ value: g, label: g }))}
                  />
                </Field>
              )}
              <Field label="Acknowledgement number" hint="What the board gave back when it took the file.">
                <Input value={ackNo} onChange={setAckNo} placeholder="BSE/2027/NR/0041" />
              </Field>
            </FormGrid>
            <FormNotice error={add.error} />
          </div>
          {(eligible.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="Everyone eligible is already on the roll"
              body="Children enrolled in the class that sits this examination and not yet entered appear here."
            />
          ) : (
            <Table head={['', 'Candidate', 'Admission no', 'Class', 'Date of birth', "Father's name", 'Medium']}>
              {(eligible.data?.items ?? []).map((e) => (
                <tr key={e.student_id}>
                  <Td>
                    <Checkbox
                      checked={picked.includes(e.student_id)}
                      onChange={(v) =>
                        setPicked(v ? [...picked, e.student_id] : picked.filter((p) => p !== e.student_id))
                      }
                      label=""
                    />
                  </Td>
                  <Td className="font-medium">{e.name}</Td>
                  <Td>{e.admission_no}</Td>
                  <Td>{e.class_name}</Td>
                  <Td>{e.date_of_birth ? formatDate(e.date_of_birth) : '—'}</Td>
                  <Td>{e.father_name ?? '—'}</Td>
                  <Td>{e.medium ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
