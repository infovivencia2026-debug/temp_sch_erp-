import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HeartPulse, Ruler, Stethoscope } from 'lucide-react'
import { api, type List, type Student } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Field, FormGrid, FormNotice, Input, Select, Textarea, Checkbox,
  Loading, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* Screening: the annual card, and the camps that fill it in.

   One card per child per year, whoever writes on it. The eye test happens in
   July and the dental van comes in November, and both belong to the same
   card — so saving twice corrects the card rather than starting a second one.

   The camp is its own record because the school is answerable for the camp
   and not only for the measurements: which agency came, on whose programme,
   and what happened to the children it referred onward. A screening that
   refers nine children and chases none of them was not worth running. */

interface Checkup {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  class_name?: string
  academic_year: string
  on_date: string
  camp?: string
  height_cm?: string
  weight_kg?: string
  bmi?: string
  vision_left?: string
  vision_right?: string
  wears_spectacles: boolean
  hearing?: string
  dental?: string
  dental_notes?: string
  haemoglobin_gdl?: string
  immunisation_upto_date?: boolean
  referred_to?: string
  remarks?: string
  examined_by?: string
}

interface Camp {
  id: string
  name: string
  programme: string
  agency?: string
  doctor_lead?: string
  on_date: string
  ends_on?: string
  venue?: string
  notes?: string
  seen: number
  referred: number
  follow_ups_outstanding: number
  checkups_filed: number
}

interface Seen {
  id: string
  student_id: string
  student_name: string
  admission_no: string
  class_name?: string
  findings?: string
  treatment_given?: string
  referred: boolean
  referred_to?: string
  follow_up_on?: string
  followed_up: boolean
  follow_up_note?: string
  follow_up_overdue: boolean
}

const PROGRAMMES = [
  { value: 'rbsk', label: 'RBSK (Rashtriya Bal Swasthya Karyakram)' },
  { value: 'state_school_health', label: 'State school health programme' },
  { value: 'immunisation', label: 'Immunisation round' },
  { value: 'dental', label: 'Dental camp' },
  { value: 'eye', label: 'Eye camp' },
  { value: 'ngo', label: 'NGO or charity' },
  { value: 'school_own', label: "The school's own doctor" },
]

const DENTAL = [
  { value: '', label: 'Not examined' },
  { value: 'normal', label: 'Normal' },
  { value: 'caries', label: 'Caries' },
  { value: 'gum_disease', label: 'Gum disease' },
  { value: 'malocclusion', label: 'Malocclusion' },
  { value: 'referred', label: 'Referred to a dentist' },
]

// The chart as it is actually read in an Indian school hall.
const SNELLEN = ['6/6', '6/9', '6/12', '6/18', '6/24', '6/36', '6/60', 'counts fingers']

/* WHO's school-age cut-offs, used only to colour a row.

   Deliberately coarse, and deliberately not stored: BMI is generated in the
   database from the height and weight, and a threshold that drifts with a
   child's exact age has no business being frozen into a column. This is a
   prompt to look, not a diagnosis. */
function bmiTone(bmi?: string): 'neutral' | 'warning' | 'danger' | undefined {
  if (!bmi) return undefined
  const v = Number(bmi)
  if (Number.isNaN(v)) return undefined
  if (v < 14) return 'danger'
  if (v < 16 || v > 25) return 'warning'
  return 'neutral'
}

function useStudents() {
  return useQuery({
    queryKey: ['students', 'screening'],
    queryFn: () => api.get<List<Student>>('/api/v1/students?limit=300'),
  })
}

export default function InfirmaryScreening() {
  const [tab, setTab] = useState<'checkups' | 'camps'>('checkups')

  const checkups = useQuery({
    queryKey: ['health-checkups'],
    queryFn: () => api.get<List<Checkup>>('/api/v1/ops/infirmary/checkups'),
  })
  const camps = useQuery({
    queryKey: ['health-camps'],
    queryFn: () => api.get<List<Camp>>('/api/v1/ops/infirmary/camps'),
  })

  const cards = checkups.data?.items ?? []
  const campRows = camps.data?.items ?? []
  const thin = cards.filter((c) => bmiTone(c.bmi) === 'danger').length
  const anaemic = cards.filter((c) => c.haemoglobin_gdl && Number(c.haemoglobin_gdl) < 11).length
  const outstanding = campRows.reduce((n, c) => n + c.follow_ups_outstanding, 0)

  return (
    <>
      <PageHead
        eyebrow="Infirmary"
        title="Health screening"
        description="One card per child per year, and the camps that fill it in."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Cards this year" value={cards.length} icon={Ruler} />
          <Stat
            label="Severely underweight"
            value={thin}
            icon={HeartPulse}
            hint={thin ? 'Worth a second look' : 'None flagged'}
          />
          <Stat label="Haemoglobin under 11" value={anaemic} hint="Commonest finding in a screening" />
          <Stat
            label="Referrals not closed"
            value={outstanding}
            icon={Stethoscope}
            delta={
              outstanding
                ? { value: 'Somebody has to chase these', positive: false }
                : { value: 'Every referral followed up', positive: true }
            }
          />
        </CellGrid>

        <div className="flex gap-1 border-b">
          {(
            [
              ['checkups', 'Annual checkups'],
              ['camps', 'Programme camps'],
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
        </div>

        {tab === 'checkups' ? (
          <Checkups query={checkups} camps={campRows} />
        ) : (
          <Camps query={camps} />
        )}
      </PageBody>
    </>
  )
}

function Checkups({
  query,
  camps,
}: {
  query: ReturnType<typeof useQuery<List<Checkup>>>
  camps: Camp[]
}) {
  const qc = useQueryClient()
  const students = useStudents()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    student_id: '',
    camp_id: '',
    on_date: '',
    height_cm: '',
    weight_kg: '',
    vision_left: '',
    vision_right: '',
    wears_spectacles: false,
    hearing: '',
    dental: '',
    dental_notes: '',
    haemoglobin_gdl: '',
    referred_to: '',
    remarks: '',
    examined_by: '',
  })

  const save = useMutation({
    mutationFn: () => api.post('/api/v1/ops/infirmary/checkups', form),
    onSuccess: () => {
      setOpen(false)
      qc.invalidateQueries({ queryKey: ['health-checkups'] })
      qc.invalidateQueries({ queryKey: ['health-camps'] })
    },
  })

  if (query.isLoading) return <Loading label="Loading the cards…" />
  if (query.error) return <ErrorState error={query.error} />
  const rows = query.data?.items ?? []

  return (
    <Card>
      <CardHeader
        title="Annual health checkup"
        description="Height, weight, vision, dental. Saving the same child twice in a year adds to their card rather than starting another one, so the dental van and the eye camp end up on one sheet."
        action={
          <Button size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Close' : 'Record measurements'}
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
            <Field label="Examined at" hint="Leave blank for the school's own checkup">
              <Select
                value={form.camp_id}
                onChange={(v) => setForm({ ...form, camp_id: v })}
                placeholder="No camp"
                options={camps.map((c) => ({
                  value: c.id,
                  label: `${c.name} · ${formatDate(c.on_date)}`,
                }))}
              />
            </Field>
            <Field label="Height (cm)">
              <Input
                value={form.height_cm}
                onChange={(v) => setForm({ ...form, height_cm: v })}
                placeholder="142.5"
              />
            </Field>
            <Field label="Weight (kg)" hint="BMI is worked out in the database from these two">
              <Input
                value={form.weight_kg}
                onChange={(v) => setForm({ ...form, weight_kg: v })}
                placeholder="36.2"
              />
            </Field>
            <Field label="Vision, left eye">
              <Select
                value={form.vision_left}
                onChange={(v) => setForm({ ...form, vision_left: v })}
                placeholder="Not tested"
                options={SNELLEN.map((x) => ({ value: x, label: x }))}
              />
            </Field>
            <Field label="Vision, right eye">
              <Select
                value={form.vision_right}
                onChange={(v) => setForm({ ...form, vision_right: v })}
                placeholder="Not tested"
                options={SNELLEN.map((x) => ({ value: x, label: x }))}
              />
            </Field>
            <Field label="Dental">
              <Select
                value={form.dental}
                onChange={(v) => setForm({ ...form, dental: v })}
                options={DENTAL}
              />
            </Field>
            <Field label="Haemoglobin (g/dL)" hint="Under 11 is the commonest finding">
              <Input
                value={form.haemoglobin_gdl}
                onChange={(v) => setForm({ ...form, haemoglobin_gdl: v })}
                placeholder="10.8"
              />
            </Field>
            <Field label="Hearing">
              <Input
                value={form.hearing}
                onChange={(v) => setForm({ ...form, hearing: v })}
                placeholder="Normal both ears"
              />
            </Field>
            <Field label="Examined by">
              <Input
                value={form.examined_by}
                onChange={(v) => setForm({ ...form, examined_by: v })}
                placeholder="Dr S Prasad"
              />
            </Field>
            <Field label="Referred to">
              <Input
                value={form.referred_to}
                onChange={(v) => setForm({ ...form, referred_to: v })}
                placeholder="Area hospital, paediatrics"
              />
            </Field>
            <Field label="Remarks" wide>
              <Textarea
                rows={2}
                value={form.remarks}
                onChange={(v) => setForm({ ...form, remarks: v })}
              />
            </Field>
          </FormGrid>
          <Checkbox
            checked={form.wears_spectacles}
            onChange={(v) => setForm({ ...form, wears_spectacles: v })}
            label="Wears spectacles"
          />
          <div className="flex items-center gap-2">
            <Button
              disabled={save.isPending || !form.student_id}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save to the card'}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          <FormNotice error={save.error} />
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState
          title="No cards yet"
          body="A child gets one card a year. Every camp and every checkup writes onto the same one."
        />
      ) : (
        <Table
          head={['Child', 'Year', 'Height / weight', 'BMI', 'Vision', 'Dental', 'Hb', 'Seen by']}
        >
          {rows.map((c) => (
            <tr key={c.id}>
              <Td className="font-medium">
                {c.student_name}
                <div className="text-[12px] font-normal text-muted-foreground">
                  {c.admission_no}
                  {c.class_name && ` · ${c.class_name}`}
                </div>
              </Td>
              <Td className="text-muted-foreground">
                {c.academic_year}
                <div className="text-[12px]">{formatDate(c.on_date)}</div>
              </Td>
              <Td className="tabular-nums">
                {c.height_cm ? `${c.height_cm} cm` : '—'}
                <div className="text-[12px] text-muted-foreground">
                  {c.weight_kg ? `${c.weight_kg} kg` : ''}
                </div>
              </Td>
              <Td className="tabular-nums">
                {c.bmi ? <Badge tone={bmiTone(c.bmi)}>{c.bmi}</Badge> : '—'}
              </Td>
              <Td className="tabular-nums text-[13px]">
                {c.vision_left || c.vision_right
                  ? `L ${c.vision_left ?? '—'} · R ${c.vision_right ?? '—'}`
                  : '—'}
                {c.wears_spectacles && (
                  <div className="text-[12px] text-muted-foreground">Wears spectacles</div>
                )}
              </Td>
              <Td className="text-[13px]">
                {DENTAL.find((d) => d.value === (c.dental ?? ''))?.label ?? c.dental}
                {c.dental_notes && (
                  <div className="text-[12px] text-muted-foreground">{c.dental_notes}</div>
                )}
              </Td>
              <Td className="tabular-nums">
                {c.haemoglobin_gdl ? (
                  <Badge tone={Number(c.haemoglobin_gdl) < 11 ? 'warning' : 'neutral'}>
                    {c.haemoglobin_gdl}
                  </Badge>
                ) : (
                  '—'
                )}
              </Td>
              <Td className="text-[13px] text-muted-foreground">
                {c.examined_by ?? '—'}
                {c.camp && <div className="text-[12px]">{c.camp}</div>}
                {c.referred_to && (
                  <div className="text-[12px] text-destructive">Referred: {c.referred_to}</div>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}

function Camps({ query }: { query: ReturnType<typeof useQuery<List<Camp>>> }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    programme: 'state_school_health',
    agency: '',
    doctor_lead: '',
    on_date: '',
    ends_on: '',
    venue: '',
    notes: '',
  })

  const save = useMutation({
    mutationFn: () => api.post('/api/v1/ops/infirmary/camps', form),
    onSuccess: () => {
      setOpen(false)
      setForm({ ...form, name: '', agency: '', doctor_lead: '', venue: '', notes: '' })
      qc.invalidateQueries({ queryKey: ['health-camps'] })
    },
  })

  if (query.isLoading) return <Loading label="Loading camps…" />
  if (query.error) return <ErrorState error={query.error} />
  const rows = query.data?.items ?? []

  return (
    <>
      <Card>
        <CardHeader
          title="School health programme camps"
          description="A visiting team, and what became of the children it referred. The last column is the one that matters."
          action={
            <Button size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? 'Close' : 'Record a camp'}
            </Button>
          }
        />
        {open && (
          <div className="space-y-4 px-4 pb-4">
            <FormGrid>
              <Field label="Name" required>
                <Input
                  value={form.name}
                  onChange={(v) => setForm({ ...form, name: v })}
                  placeholder="RBSK screening, round 2"
                />
              </Field>
              <Field label="Programme">
                <Select
                  value={form.programme}
                  onChange={(v) => setForm({ ...form, programme: v })}
                  options={PROGRAMMES}
                />
              </Field>
              <Field label="Visiting team" hint="The PHC, hospital or charity that came">
                <Input
                  value={form.agency}
                  onChange={(v) => setForm({ ...form, agency: v })}
                  placeholder="PHC Kukatpally"
                />
              </Field>
              <Field label="Doctor leading it">
                <Input
                  value={form.doctor_lead}
                  onChange={(v) => setForm({ ...form, doctor_lead: v })}
                  placeholder="Dr S Prasad"
                />
              </Field>
              <Field label="From">
                <Input
                  type="date"
                  value={form.on_date}
                  onChange={(v) => setForm({ ...form, on_date: v })}
                />
              </Field>
              <Field label="To" hint="Blank for a single day">
                <Input
                  type="date"
                  value={form.ends_on}
                  onChange={(v) => setForm({ ...form, ends_on: v })}
                />
              </Field>
              <Field label="Where" wide>
                <Input
                  value={form.venue}
                  onChange={(v) => setForm({ ...form, venue: v })}
                  placeholder="School hall"
                />
              </Field>
            </FormGrid>
            <div className="flex items-center gap-2">
              <Button
                disabled={save.isPending || form.name.trim() === ''}
                onClick={() => save.mutate()}
              >
                {save.isPending ? 'Saving…' : 'Record camp'}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
            <FormNotice error={save.error} />
          </div>
        )}
        {rows.length === 0 ? (
          <EmptyState
            title="No camps recorded"
            body="State screening rounds, dental vans and eye camps go here, with who was seen at each."
          />
        ) : (
          <Table head={['Camp', 'Programme', 'When', 'Seen', 'Referred', 'Not chased', '']}>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium">
                  {c.name}
                  {c.agency && (
                    <div className="text-[12px] font-normal text-muted-foreground">
                      {c.agency}
                      {c.doctor_lead && ` · ${c.doctor_lead}`}
                    </div>
                  )}
                </Td>
                <Td className="text-[13px] text-muted-foreground">
                  {PROGRAMMES.find((p) => p.value === c.programme)?.label ?? c.programme}
                </Td>
                <Td className="text-muted-foreground">
                  {formatDate(c.on_date)}
                  {c.ends_on && <div className="text-[12px]">to {formatDate(c.ends_on)}</div>}
                </Td>
                <Td className="tabular-nums">
                  {c.seen}
                  {c.checkups_filed > 0 && (
                    <div className="text-[12px] text-muted-foreground">
                      {c.checkups_filed} card{c.checkups_filed > 1 ? 's' : ''} filed
                    </div>
                  )}
                </Td>
                <Td className="tabular-nums">{c.referred}</Td>
                <Td>
                  {c.follow_ups_outstanding > 0 ? (
                    <Badge tone="danger">{c.follow_ups_outstanding} open</Badge>
                  ) : (
                    <span className="text-[13px] text-muted-foreground">—</span>
                  )}
                </Td>
                <Td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setChosen(chosen === c.id ? null : c.id)}
                  >
                    {chosen === c.id ? 'Hide' : 'Who was seen'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {chosen && <CampAttendance campId={chosen} />}
    </>
  )
}

function CampAttendance({ campId }: { campId: string }) {
  const qc = useQueryClient()
  const students = useStudents()
  const [form, setForm] = useState({
    student_id: '',
    findings: '',
    treatment_given: '',
    referred: false,
    referred_to: '',
    follow_up_on: '',
  })

  const list = useQuery({
    queryKey: ['camp-seen', campId],
    queryFn: () => api.get<List<Seen>>(`/api/v1/ops/infirmary/camps/${campId}/seen`),
  })
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post(`/api/v1/ops/infirmary/camps/${campId}/seen`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['camp-seen', campId] })
      qc.invalidateQueries({ queryKey: ['health-camps'] })
    },
  })

  const rows = list.data?.items ?? []

  return (
    <Card>
      <CardHeader
        title="Children seen at this camp"
        description="Open referrals first. A screening that finds nine problems and chases none of them has recorded nine problems."
      />
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
          <Field label="What was found">
            <Input
              value={form.findings}
              onChange={(v) => setForm({ ...form, findings: v })}
              placeholder="Mild anaemia"
            />
          </Field>
          <Field label="Treated with">
            <Input
              value={form.treatment_given}
              onChange={(v) => setForm({ ...form, treatment_given: v })}
              placeholder="Fluoride varnish"
            />
          </Field>
          <Field label="Follow up on">
            <Input
              type="date"
              value={form.follow_up_on}
              onChange={(v) => setForm({ ...form, follow_up_on: v })}
            />
          </Field>
          {form.referred && (
            <Field label="Referred to" required wide>
              <Input
                value={form.referred_to}
                onChange={(v) => setForm({ ...form, referred_to: v })}
                placeholder="Area hospital, paediatrics"
              />
            </Field>
          )}
        </FormGrid>
        <Checkbox
          checked={form.referred}
          onChange={(v) => setForm({ ...form, referred: v })}
          label="Referred onward"
          hint="A referral needs somewhere to go before it can be saved."
        />
        <Button
          disabled={
            save.isPending ||
            !form.student_id ||
            (form.referred && form.referred_to.trim() === '')
          }
          onClick={() => save.mutate({ ...form })}
        >
          {save.isPending ? 'Saving…' : 'Add to the camp'}
        </Button>
        <FormNotice error={save.error} />
      </div>
      {list.isLoading ? (
        <SkeletonTable columns={6} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nobody recorded yet" body="Add the children the team saw." />
      ) : (
        <Table head={['Child', 'Found', 'Treated', 'Referred to', 'Follow-up', '']}>
          {rows.map((s) => (
            <tr key={s.id}>
              <Td className="font-medium">
                {s.student_name}
                <div className="text-[12px] font-normal text-muted-foreground">
                  {s.admission_no}
                  {s.class_name && ` · ${s.class_name}`}
                </div>
              </Td>
              <Td>{s.findings ?? '—'}</Td>
              <Td className="text-[13px] text-muted-foreground">{s.treatment_given ?? '—'}</Td>
              <Td className="text-[13px]">{s.referred_to ?? '—'}</Td>
              <Td>
                {s.followed_up ? (
                  <>
                    <Badge tone="success">Done</Badge>
                    {s.follow_up_note && (
                      <div className="text-[12px] text-muted-foreground">{s.follow_up_note}</div>
                    )}
                  </>
                ) : s.follow_up_overdue ? (
                  <Badge tone="danger">Overdue {formatDate(s.follow_up_on)}</Badge>
                ) : s.follow_up_on ? (
                  <Badge tone="warning">Due {formatDate(s.follow_up_on)}</Badge>
                ) : (
                  <span className="text-[13px] text-muted-foreground">—</span>
                )}
              </Td>
              <Td>
                {s.referred && !s.followed_up && (
                  <Button
                    size="sm"
                    disabled={save.isPending}
                    onClick={() =>
                      save.mutate({
                        student_id: s.student_id,
                        followed_up: true,
                        follow_up_note: 'Seen and closed by the school',
                      })
                    }
                  >
                    Mark chased
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
