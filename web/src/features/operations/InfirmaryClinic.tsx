import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Pill, Stethoscope } from 'lucide-react'
import { api, type List, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea, Checkbox,
  Loading, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'

/* The nurse's day: who came in, and what they were given.

   Two registers on one screen because they are one job. A child arrives with a
   temperature, is rested, and may or may not be given something — and the dose
   is the part the school is asked about afterwards.

   Neither table keeps its own copy of a child's allergies. Those come from the
   health master file, joined on the way out, so the line a nurse reads before
   opening a bottle is the one somebody last edited rather than a stale copy
   made when the visit was recorded. */

interface Visit {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  class_name?: string
  on_date: string
  arrived_at: string
  complaint: string
  temperature_c?: string
  pulse_bpm?: number
  bp?: string
  observations?: string
  treatment?: string
  rested_minutes?: number
  outcome: string
  referred_to?: string
  parent_informed: boolean
  seen_by: string
  allergies?: string
  chronic_conditions?: string
  blood_group?: string
  doses_given: number
}

interface Dose {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  medicine: string
  dose: string
  route: string
  authority: string
  authorised_by_name: string
  authority_ref?: string
  authorised_on?: string
  has_prescription_file: boolean
  administered_by_name: string
  administered_at: string
  witnessed_by_name?: string
  refused: boolean
  adverse_reaction?: string
  parent_informed: boolean
  notes?: string
  allergies?: string
}

const OUTCOMES = [
  { value: 'returned_to_class', label: 'Went back to class' },
  { value: 'rested', label: 'Rested in the sick bay' },
  { value: 'observed', label: 'Kept under observation' },
  { value: 'sent_home', label: 'Sent home' },
  { value: 'referred', label: 'Referred on' },
  { value: 'hospitalised', label: 'Taken to hospital' },
]

const OUTCOME_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = {
  returned_to_class: 'neutral',
  rested: 'neutral',
  observed: 'warning',
  sent_home: 'warning',
  referred: 'danger',
  hospitalised: 'danger',
}

// What a school is answerable for is not "was it given" but "who said it
// could be". The four answers a register has to be able to give.
const AUTHORITIES = [
  { value: 'parent_consent', label: "A parent's written consent" },
  { value: 'doctor_prescription', label: "A doctor's prescription" },
  { value: 'standing_order', label: 'The school medical standing order' },
  { value: 'emergency', label: 'An emergency, nobody asked' },
]

const AUTHORITY_LABEL: Record<string, string> = Object.fromEntries(
  AUTHORITIES.map((a) => [a.value, a.label]),
)

const ROUTES = ['oral', 'topical', 'inhaled', 'drops', 'injection', 'other']

function today() {
  return new Date().toISOString().slice(0, 10)
}

function useStudents() {
  return useQuery({
    queryKey: ['students', 'clinic'],
    queryFn: () => api.get<List<Student>>('/api/v1/students?limit=300'),
  })
}

export default function InfirmaryClinic() {
  const [tab, setTab] = useState<'visits' | 'doses'>('visits')
  const [date, setDate] = useState(today())

  const visits = useQuery({
    queryKey: ['infirmary-visits', date],
    queryFn: () => api.get<List<Visit>>(`/api/v1/ops/infirmary/visits?on_date=${date}`),
  })

  const rows = visits.data?.items ?? []
  const left = rows.filter((v) => v.outcome === 'sent_home' || v.outcome === 'hospitalised')
  const flagged = rows.filter((v) => v.allergies || v.chronic_conditions)
  const doses = rows.reduce((n, v) => n + v.doses_given, 0)

  return (
    <>
      <PageHead
        eyebrow="Infirmary"
        title="The sick room"
        description="Who came in today, what was done, and what was given to them on whose authority."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Seen today" value={rows.length} icon={Stethoscope} period={date} />
          <Stat
            label="Left the premises"
            value={left.length}
            icon={AlertTriangle}
            hint={left.length ? 'Sent home or to hospital' : 'Nobody sent home'}
          />
          <Stat label="Doses given" value={doses} icon={Pill} period={date} />
          <Stat
            label="With a recorded allergy"
            value={flagged.length}
            hint={flagged.length ? 'Check the master file before treating' : undefined}
          />
        </CellGrid>

        <div className="flex items-center gap-1 border-b">
          {(
            [
              ['visits', 'Visit log'],
              ['doses', 'Medication register'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              aria-current={tab === k}
              className={
                tab === k
                  ? '-mb-px border-b-2 border-primary px-3 py-2 text-[14px] font-medium'
                  : '-mb-px border-b-2 border-transparent px-3 py-2 text-[14px] text-muted-foreground hover:text-foreground'
              }
            >
              {label}
            </button>
          ))}
          <span className="ml-auto pb-1">
            <Input type="date" value={date} onChange={setDate} />
          </span>
        </div>

        {tab === 'visits' ? (
          <VisitLog date={date} query={visits} />
        ) : (
          <MedicationRegister date={date} />
        )}
      </PageBody>
    </>
  )
}

function VisitLog({
  date,
  query,
}: {
  date: string
  query: ReturnType<typeof useQuery<List<Visit>>>
}) {
  const qc = useQueryClient()
  const students = useStudents()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    student_id: '',
    complaint: '',
    temperature_c: '',
    pulse_bpm: '',
    bp: '',
    observations: '',
    treatment: '',
    rested_minutes: '',
    outcome: 'returned_to_class',
    referred_to: '',
    parent_informed: false,
  })

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/ops/infirmary/visits', {
        ...form,
        pulse_bpm: form.pulse_bpm ? Number(form.pulse_bpm) : undefined,
        rested_minutes: form.rested_minutes ? Number(form.rested_minutes) : undefined,
      }),
    onSuccess: () => {
      setOpen(false)
      setForm({ ...form, student_id: '', complaint: '', temperature_c: '', pulse_bpm: '',
        bp: '', observations: '', treatment: '', rested_minutes: '',
        outcome: 'returned_to_class', referred_to: '', parent_informed: false })
      qc.invalidateQueries({ queryKey: ['infirmary-visits'] })
    },
  })

  // Both of these mean the child left the school's care, and the server
  // refuses either until the family has been told. Said here as well so the
  // form asks the question rather than reporting a rejection.
  const leaving = form.outcome === 'sent_home' || form.outcome === 'hospitalised'
  const referring = form.outcome === 'referred' || form.outcome === 'hospitalised'

  if (query.isLoading) return <Loading label="Loading the register…" />
  if (query.error) return <ErrorState error={query.error} />
  const rows = query.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="Visit log"
          description="One row per attendance. A child who comes down three times in a week is a pattern, not a single current complaint."
          action={
            <Button size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? 'Close' : 'Record a visit'}
            </Button>
          }
        />
        {open && (
          <div className="space-y-4 px-4 pb-4">
            <FormGrid>
              <Field label="Child" required>
                <Select
                  value={form.student_id}
                  onChange={(v) => setForm({ ...form, student_id: v })}
                  placeholder="Choose a child"
                  options={(students.data?.items ?? []).map((s) => ({
                    value: s.id,
                    label: `${s.full_name} · ${s.admission_no}`,
                  }))}
                />
              </Field>
              <Field label="Came in with" required>
                <Input
                  value={form.complaint}
                  onChange={(v) => setForm({ ...form, complaint: v })}
                  placeholder="Headache after games"
                />
              </Field>
              <Field label="Temperature (°C)" hint="Leave blank rather than guessing">
                <Input
                  value={form.temperature_c}
                  onChange={(v) => setForm({ ...form, temperature_c: v })}
                  placeholder="37.8"
                />
              </Field>
              <Field label="Pulse / blood pressure">
                <div className="flex gap-2">
                  <Input
                    value={form.pulse_bpm}
                    onChange={(v) => setForm({ ...form, pulse_bpm: v })}
                    placeholder="88 bpm"
                  />
                  <Input
                    value={form.bp}
                    onChange={(v) => setForm({ ...form, bp: v })}
                    placeholder="110/70"
                  />
                </div>
              </Field>
              <Field label="What was seen" wide>
                <Textarea
                  rows={2}
                  value={form.observations}
                  onChange={(v) => setForm({ ...form, observations: v })}
                  placeholder="Flushed, no rash, chest clear"
                />
              </Field>
              <Field label="What was done" wide>
                <Textarea
                  rows={2}
                  value={form.treatment}
                  onChange={(v) => setForm({ ...form, treatment: v })}
                  placeholder="Rested, water, cold compress"
                />
              </Field>
              <Field label="Rested for (minutes)">
                <Input
                  value={form.rested_minutes}
                  onChange={(v) => setForm({ ...form, rested_minutes: v })}
                  placeholder="40"
                />
              </Field>
              <Field label="How it ended" required>
                <Select
                  value={form.outcome}
                  onChange={(v) => setForm({ ...form, outcome: v })}
                  options={OUTCOMES}
                />
              </Field>
              {referring && (
                <Field label="Sent on to" required wide>
                  <Input
                    value={form.referred_to}
                    onChange={(v) => setForm({ ...form, referred_to: v })}
                    placeholder="Yashoda Hospital, casualty"
                  />
                </Field>
              )}
            </FormGrid>
            <Checkbox
              checked={form.parent_informed}
              onChange={(v) => setForm({ ...form, parent_informed: v })}
              label="The parent has been told"
              hint={
                leaving
                  ? 'Required: a child cannot be signed off the premises until somebody has rung home.'
                  : 'Ticked here, timed by the server.'
              }
            />
            <div className="flex items-center gap-2">
              <Button
                disabled={
                  save.isPending ||
                  !form.student_id ||
                  form.complaint.trim() === '' ||
                  (leaving && !form.parent_informed) ||
                  (referring && form.referred_to.trim() === '')
                }
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : 'Record visit'}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
            <FormNotice error={save.error} />
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyState title="Nobody has come in" body={`No infirmary visits recorded for ${date}.`} />
        ) : (
          <Table
            head={['Time', 'Child', 'Came in with', 'Vitals', 'What was done', 'How it ended']}
          >
            {rows.map((v) => (
              <tr key={v.id}>
                <Td className="tabular-nums text-muted-foreground">
                  {v.arrived_at.slice(11)}
                </Td>
                <Td className="font-medium">
                  {v.student_name}
                  <div className="text-[12px] font-normal text-muted-foreground">
                    {v.admission_no}
                    {v.class_name && ` · ${v.class_name}`}
                    {v.blood_group && ` · ${v.blood_group}`}
                  </div>
                  {v.allergies && (
                    <div className="text-[12px] font-medium text-destructive">
                      Allergic to {v.allergies}
                    </div>
                  )}
                  {v.chronic_conditions && (
                    <div className="text-[12px] text-[hsl(var(--warning))]">
                      {v.chronic_conditions}
                    </div>
                  )}
                </Td>
                <Td>{v.complaint}</Td>
                <Td className="tabular-nums text-[13px] text-muted-foreground">
                  {v.temperature_c ? `${v.temperature_c}°C` : '—'}
                  {v.pulse_bpm && <div>{v.pulse_bpm} bpm</div>}
                  {v.bp && <div>{v.bp}</div>}
                </Td>
                <Td className="text-[13px]">
                  {v.treatment ?? '—'}
                  {v.rested_minutes ? (
                    <div className="text-muted-foreground">Rested {v.rested_minutes} min</div>
                  ) : null}
                  {v.doses_given > 0 && (
                    <div className="text-muted-foreground">
                      {v.doses_given} dose{v.doses_given > 1 ? 's' : ''} given
                    </div>
                  )}
                </Td>
                <Td>
                  <Badge tone={OUTCOME_TONE[v.outcome] ?? 'neutral'}>
                    {OUTCOMES.find((o) => o.value === v.outcome)?.label ?? v.outcome}
                  </Badge>
                  {v.referred_to && (
                    <div className="text-[12px] text-muted-foreground">{v.referred_to}</div>
                  )}
                  <div className="text-[12px] text-muted-foreground">
                    {v.parent_informed ? 'Parent told' : 'Parent not told'} · {v.seen_by}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

function MedicationRegister({ date }: { date: string }) {
  const qc = useQueryClient()
  const students = useStudents()
  const [incidents, setIncidents] = useState(false)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    student_id: '',
    medicine: '',
    dose: '',
    route: 'oral',
    authority: 'parent_consent',
    authorised_by_name: '',
    authority_ref: '',
    authorised_on: '',
    administered_by_name: '',
    witnessed_by_name: '',
    refused: false,
    adverse_reaction: '',
    parent_informed: false,
    notes: '',
  })

  const list = useQuery({
    queryKey: ['medications', date, incidents],
    queryFn: () =>
      api.get<List<Dose>>(
        `/api/v1/ops/infirmary/medications?on_date=${date}&incidents=${incidents}`,
      ),
  })
  const save = useMutation({
    mutationFn: () => api.post('/api/v1/ops/infirmary/medications', form),
    onSuccess: () => {
      setOpen(false)
      setForm({ ...form, medicine: '', dose: '', authority_ref: '', witnessed_by_name: '',
        refused: false, adverse_reaction: '', parent_informed: false, notes: '' })
      qc.invalidateQueries({ queryKey: ['medications'] })
      qc.invalidateQueries({ queryKey: ['infirmary-visits'] })
    },
  })

  const rows = list.data?.items ?? []
  const needsProof = form.authority === 'doctor_prescription'
  const needsReason = form.authority === 'emergency'
  const incident = form.refused || form.adverse_reaction.trim() !== ''
  const chosen = (students.data?.items ?? []).find((s) => s.id === form.student_id)

  return (
    <Card>
      <CardHeader
        title="Medication register"
        description="Who was given what, when, by whom, and on whose authority. The last of those is why this is not a tick on the visit log."
        action={
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant={incidents ? 'primary' : 'secondary'}
              onClick={() => setIncidents((v) => !v)}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              {incidents ? 'Showing refusals and reactions' : 'Refusals and reactions'}
            </Button>
            <Button size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? 'Close' : 'Record a dose'}
            </Button>
          </span>
        }
      />
      {open && (
        <div className="space-y-4 px-4 pb-4">
          <FormGrid>
            <Field label="Child" required>
              <Select
                value={form.student_id}
                onChange={(v) => setForm({ ...form, student_id: v })}
                placeholder="Choose a child"
                options={(students.data?.items ?? []).map((s) => ({
                  value: s.id,
                  label: `${s.full_name} · ${s.admission_no}`,
                }))}
              />
            </Field>
            <Field label="Medicine and dose" required>
              <div className="flex gap-2">
                <Input
                  value={form.medicine}
                  onChange={(v) => setForm({ ...form, medicine: v })}
                  placeholder="Paracetamol"
                />
                <Input
                  value={form.dose}
                  onChange={(v) => setForm({ ...form, dose: v })}
                  placeholder="250mg syrup"
                />
              </div>
            </Field>
            <Field label="Route">
              <Select
                value={form.route}
                onChange={(v) => setForm({ ...form, route: v })}
                options={ROUTES.map((x) => ({ value: x, label: x }))}
              />
            </Field>
            <Field label="On whose authority" required>
              <Select
                value={form.authority}
                onChange={(v) => setForm({ ...form, authority: v })}
                options={AUTHORITIES}
              />
            </Field>
            <Field
              label="Authorised by"
              required
              hint="The parent or the doctor by name, not the person giving it"
            >
              <Input
                value={form.authorised_by_name}
                onChange={(v) => setForm({ ...form, authorised_by_name: v })}
                placeholder="Dr K Rao / Mrs Lakshmi (mother)"
              />
            </Field>
            <Field
              label="Prescription or consent reference"
              required={needsProof}
              hint={needsProof ? 'A prescription that cannot be produced is not a prescription' : undefined}
            >
              <Input
                value={form.authority_ref}
                onChange={(v) => setForm({ ...form, authority_ref: v })}
                placeholder="RX/2026/8841"
              />
            </Field>
            <Field label="Authorised on">
              <Input
                type="date"
                value={form.authorised_on}
                onChange={(v) => setForm({ ...form, authorised_on: v })}
              />
            </Field>
            <Field label="Given by" hint="Defaults to you">
              <Input
                value={form.administered_by_name}
                onChange={(v) => setForm({ ...form, administered_by_name: v })}
                placeholder="Nurse on duty"
              />
            </Field>
            <Field label="Witnessed by" hint="Standard for controlled and injectable medicines">
              <Input
                value={form.witnessed_by_name}
                onChange={(v) => setForm({ ...form, witnessed_by_name: v })}
                placeholder="Matron Sujatha"
              />
            </Field>
            <Field label="Adverse reaction">
              <Input
                value={form.adverse_reaction}
                onChange={(v) => setForm({ ...form, adverse_reaction: v })}
                placeholder="Nothing observed"
              />
            </Field>
            <Field
              label="Notes"
              required={needsReason}
              hint={needsReason ? 'Say why it could not wait for anyone to be asked' : undefined}
              wide
            >
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(v) => setForm({ ...form, notes: v })}
              />
            </Field>
          </FormGrid>
          {chosen && (
            <p className="text-[13px] text-muted-foreground">
              Check the health master file for {chosen.full_name} before opening the bottle.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <Checkbox
              checked={form.refused}
              onChange={(v) => setForm({ ...form, refused: v })}
              label="The child refused it"
            />
            <Checkbox
              checked={form.parent_informed}
              onChange={(v) => setForm({ ...form, parent_informed: v })}
              label="The parent has been told"
              hint={incident ? 'Required for a refusal or a reaction' : undefined}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              disabled={
                save.isPending ||
                !form.student_id ||
                form.medicine.trim() === '' ||
                form.dose.trim() === '' ||
                form.authorised_by_name.trim() === '' ||
                (needsProof && form.authority_ref.trim() === '') ||
                (needsReason && form.notes.trim() === '') ||
                (incident && !form.parent_informed)
              }
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Record dose'}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      )}
      {list.isLoading ? (
        <SkeletonTable columns={6} label="Loading the register…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={incidents ? 'No refusals or reactions' : 'Nothing given'}
          body={
            incidents
              ? 'Doses a child refused, or reacted badly to, appear here whatever day they were given.'
              : `No medication recorded on ${date}.`
          }
        />
      ) : (
        <Table
          head={['Time', 'Child', 'Medicine', 'On whose authority', 'Given by', '']}
        >
          {rows.map((d) => (
            <tr key={d.id}>
              <Td className="tabular-nums text-muted-foreground">
                {d.administered_at.slice(11)}
              </Td>
              <Td className="font-medium">
                {d.student_name}
                <div className="text-[12px] font-normal text-muted-foreground">
                  {d.admission_no}
                </div>
                {d.allergies && (
                  <div className="text-[12px] font-medium text-destructive">
                    Allergic to {d.allergies}
                  </div>
                )}
              </Td>
              <Td>
                {d.medicine}
                <div className="text-[12px] text-muted-foreground">
                  {d.dose} · {d.route}
                </div>
              </Td>
              <Td className="text-[13px]">
                {d.authorised_by_name}
                <div className="text-[12px] text-muted-foreground">
                  {AUTHORITY_LABEL[d.authority] ?? d.authority}
                </div>
                {(d.authority_ref || d.has_prescription_file) && (
                  <div className="font-mono text-[12px] text-muted-foreground">
                    {d.authority_ref ?? 'scan attached'}
                  </div>
                )}
              </Td>
              <Td className="text-[13px]">
                {d.administered_by_name}
                {d.witnessed_by_name && (
                  <div className="text-[12px] text-muted-foreground">
                    Witnessed by {d.witnessed_by_name}
                  </div>
                )}
              </Td>
              <Td>
                {d.refused && <Badge tone="warning">Refused</Badge>}
                {d.adverse_reaction && <Badge tone="danger">{d.adverse_reaction}</Badge>}
                {(d.refused || d.adverse_reaction) && (
                  <div className="text-[12px] text-muted-foreground">
                    {d.parent_informed ? 'Parent told' : 'Parent not told'}
                  </div>
                )}
                {d.notes && <div className="text-[12px] text-muted-foreground">{d.notes}</div>}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
