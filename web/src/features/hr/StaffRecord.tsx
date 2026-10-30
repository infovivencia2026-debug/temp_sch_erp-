import { Suspense, lazy, useState } from 'react'

/* The charts, and recharts with them, load only when a record has marks to draw. */
const Bars = lazy(() => import('./StaffRecordCharts').then((m) => ({ default: m.Bars })))
const ExamTrend = lazy(() => import('./StaffRecordCharts').then((m) => ({ default: m.ExamTrend })))
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Layers, GraduationCap, CalendarClock, CalendarCheck, CalendarOff, ListChecks, Clock } from 'lucide-react'
import { api, type List, type Section } from '@/lib/api'
import {
  Card, CardHeader, CellGrid, Stat, FormGrid, Field as FormField, Select, Input, FormNotice,
  Table, Td, Badge, Button, Loading, ErrorState,
} from '@/components/ui'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import CardViewer from '@/components/CardViewer'
import { formatDate, formatPaise, formatTime, cn } from '@/lib/utils'
import { RecordShell, type RecordTab, type RecordAction } from '@/components/RecordShell'
import { PhotoViewer } from '@/components/PhotoViewer'
import WeekGrid from '@/components/WeekGrid'
import Timeline from '@/components/Timeline'
import { useOverlayHistory } from '@/lib/overlay-history'

/** A register day in full, "Thu, 23 Oct 2026": the day of the week is half of what a reader checks. */
const dayLong = (ymd: string) =>
  new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${ymd}T00:00:00`))

/* What a member of staff carries, at a glance.

   The record below is the paper file — contact, employment, documents. This
   is the working answer to "how loaded are they, and how are their classes
   doing", drawn from the same allocation the timetable reads and the marks
   the report cards publish. It is read far more often than it is edited, so
   it sits at the top and it reads like a dashboard: tiles, then charts.

   Charts model the principal dashboard's styling — theme tokens, muted
   gridlines, an SVG that prints — so it matches the app and works in either
   theme and on the schools' old tablets. */
interface Overview {
  staff: { id: string; name: string; designation?: string }
  load: {
    subjects_count: number
    sections_count: number
    students_count: number
    periods_per_week: number
    class_teacher_of: { class: string; section: string }[]
    subjects: { class: string; section: string; subject: string; students: number }[]
  }
  marks: {
    has_marks: boolean
    overall_avg_pct: number
    pass_rate_pct: number
    distinction_rate_pct: number
    by_subject: { subject: string; avg_pct: number; students: number; exams: number }[]
    trend: { exam: string; date: string; avg_pct: number }[]
    by_section: { class: string; section: string; avg_pct: number }[]
  }
}

/* The tooltip and axes the principal dashboard uses, so both charts read the
   same way and neither hard-codes a colour that breaks in dark mode. */

function StaffOverview({ employeeID }: { employeeID: string }) {
  const overview = useQuery({
    queryKey: ['staff-overview', employeeID],
    queryFn: () => api.get<Overview>(`/api/v1/hr/employees/${employeeID}/overview`),
  })

  return (
    <Card>
      <CardHeader title="Overview" description="Teaching load and how their classes are doing." />
      {overview.isLoading ? (
        <div className="p-5"><Loading shape="inline" /></div>
      ) : overview.error ? (
        /* Degrades rather than crashes: a 404 or a slow endpoint shows here,
           and the paper record below still opens. */
        <div className="p-4"><ErrorState error={overview.error} /></div>
      ) : overview.data ? (
        <OverviewBody o={overview.data} />
      ) : null}
    </Card>
  )
}

function OverviewBody({ o }: { o: Overview }) {
  const { load, marks } = o
  return (
    <div className="space-y-6 p-4">
      <CellGrid cols={4}>
        <Stat label="Subjects taught" value={load.subjects_count} icon={BookOpen} />
        <Stat label="Sections" value={load.sections_count} icon={Layers} />
        <Stat label="Students taught" value={load.students_count} icon={GraduationCap} />
        <Stat label="Periods / week" value={load.periods_per_week} icon={CalendarClock} />
      </CellGrid>

      {load.class_teacher_of.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow text-muted-foreground">Class teacher of</span>
          {load.class_teacher_of.map((c) => (
            <Badge key={`${c.class}-${c.section}`} tone="primary">
              {c.class}-{c.section}
            </Badge>
          ))}
        </div>
      )}

      {/* Subjects they teach: the average per subject as bars, and the
          allocation rows beside it — the coverage stands whether or not marks
          exist. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border p-4">
          <p className="eyebrow mb-3 text-muted-foreground">Average % by subject</p>
          {marks.has_marks && marks.by_subject.length > 0 ? (
            <div className="h-56">
              <Suspense fallback={<div className="skeleton h-full w-full rounded-lg" aria-hidden />}>
                <Bars xKey="subject" data={marks.by_subject} />
              </Suspense>
            </div>
          ) : (
            <p className="grid h-56 place-items-center text-center text-[13px] text-muted-foreground">
              No published marks yet for the classes they teach.
            </p>
          )}
        </div>

        <div className="rounded-lg border">
          <p className="eyebrow px-4 pb-2 pt-4 text-muted-foreground">Allocation</p>
          <Table head={['Class', 'Subject', 'Students']} empty={!load.subjects.length}
            emptyLabel="No subjects allocated.">
            {load.subjects.map((s, i) => (
              <tr key={`${s.class}-${s.section}-${s.subject}-${i}`}>
                <Td className="font-medium">{s.class}-{s.section}</Td>
                <Td>{s.subject}</Td>
                <Td className="tabular-nums">{s.students}</Td>
              </tr>
            ))}
          </Table>
        </div>
      </div>

      {/* Performance across exams, and the three headline rates beside it. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,200px)]">
        <div className="rounded-lg border p-4">
          <p className="eyebrow mb-3 text-muted-foreground">Performance across exams</p>
          {marks.has_marks && marks.trend.length > 0 ? (
            <div className="h-56">
              <Suspense fallback={<div className="skeleton h-full w-full rounded-lg" aria-hidden />}>
                <ExamTrend data={marks.trend} />
              </Suspense>
            </div>
          ) : (
            <p className="grid h-56 place-items-center text-center text-[13px] text-muted-foreground">
              No published marks yet for the classes they teach.
            </p>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-1">
          <Stat label="Overall average" value={marks.has_marks ? `${marks.overall_avg_pct}%` : '-'} />
          <Stat label="Pass rate" value={marks.has_marks ? `${marks.pass_rate_pct}%` : '-'} />
          <Stat label="Distinctions" value={marks.has_marks ? `${marks.distinction_rate_pct}%` : '-'} />
        </div>
      </div>

      {/* Section-wise comparison — only where there is something to compare. */}
      {marks.has_marks && marks.by_section.length > 0 && (
        <div className="rounded-lg border p-4">
          <p className="eyebrow mb-3 text-muted-foreground">Average % by section</p>
          <div className="h-56">
            <Suspense fallback={<div className="skeleton h-full w-full rounded-lg" aria-hidden />}>
              <Bars xKey="label" data={marks.by_section.map((s) => ({ ...s, label: `${s.class}-${s.section}` }))} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  )
}

/* One member of staff, and what they actually do here.

   The directory was a list. Everything past a name and a department lived
   somewhere else — what they teach in the allocation grid, which section they
   are class teacher of in the section record, their qualifications in the
   service book. So the question a head of department asks daily, "what does
   she teach and can she take another class", meant opening three screens and
   holding the answer in your head.

   WHAT THEY TEACH IS THE POINT, and it reads and writes the same
   section_subject_teachers row the timetable uses. The allocation grid asks
   "who teaches 7-A Maths", which is right for building a timetable from
   nothing and useless for the other half of the job: a teacher arrives in
   March and picks up four classes, somebody goes on leave and their subjects
   are shared out, a head is balancing a workload.

   A staff record with its own idea of who teaches what would disagree with
   the timetable, and the day they disagree is the day somebody is sent to the
   wrong room.
*/

interface Detail {
  id: string
  employee_code: string
  full_name: string
  phone?: string
  email?: string
  school_email?: string
  qualification?: string
  department?: string
  designation?: string
  department_id?: string
  designation_id?: string
  employment_type?: string
  status: string
  joined_on: string
  confirmed_on?: string
  relieved_on?: string
  address?: string
  photo_file_id?: string
  experience_years?: number
  user_id?: string
  emergency_contact_name?: string
  emergency_contact_phone?: string
  /* What payroll needs to actually pay somebody. The columns have existed
     since the beginning and nothing wrote them, so salary was calculated here
     and paid from a list kept somewhere else. */
  bank_account?: string
  bank_ifsc?: string
  pan?: string
  uan?: string
  esi_number?: string
  /** The id this person is enrolled under on the biometric reader, e.g. YPS0006. */
  device_user_id?: string
  teaching: {
    id: string; class: string; section: string; subject: string
    section_id: string; class_subject_id: string
  }[]
  class_teacher_of: { section_id: string; class: string; section: string; students: string }[]
  /* Years served before the school used this system, imported from whatever
     it kept. Not folded into anything live: an attendance total is not a
     register, and it must never be counted as this year's. */
  prior_years?: {
    year: string; designation: string
    days_present?: number | null; days_total?: number | null
    leaves_taken?: number | null; notes: string
  }[]
  documents: {
    id: string; doc_type: string; file_id: string; uploaded_on: string
    expires_on: string; filename: string
  }[]
  custom_fields?: Record<string, string>
}

/* The papers a school holds on a teacher, as suggestions rather than a fixed
   list. More of these are statutory than for a child, and most of them lapse:
   a police verification, a medical fitness, a contract. */
/* The tabs the detail call does not carry (hr/staff_record.ts). pay is null
   for a reader without payroll. */
interface Summary {
  attendance: {
    marked: number; present: number; absent: number; late: number; on_leave: number
    recent: { on_date: string; status: string; check_in: string | null; check_out: string | null; source: string; remarks: string }[]
  }
  leave: {
    balances: { type: string; entitled: number; taken: number }[]
    requests: { id: string; type: string; from_date: string; to_date: string; days: string; status: string; reason: string; decision_note: string }[]
  }
  pay: { year: number; month: number; paid_days: string; lop_days: string; gross_paise: number; deduction_paise: number; net_paise: number; published: number }[] | null
  timetable: {
    periods: { id: string; name: string; starts_at: string; ends_at: string; is_break: number }[]
    entries: { weekday: number; period_id: string; class: string; subject: string; room: string | null }[]
  }
  tasks: { id: string; title: string; due_on: string | null; priority: string; status: string; assigned_by: string }[]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const STAFF_DOCS = [
  'Aadhaar card', 'PAN card', 'Degree certificate', 'Teaching qualification',
  'Police verification', 'Medical fitness', 'Appointment letter',
  'Previous employer relieving letter', 'Passport photograph',
]

export default function StaffRecord({ employeeID, onClose }: {
  employeeID: string
  onClose: () => void
}) {
  // Back closes the record and returns to the directory, rather than leaving
  // the screen that opened it.
  const close = useOverlayHistory(true, onClose)
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [sectionID, setSectionID] = useState('')
  const [classSubjectID, setClassSubjectID] = useState('')
  const [photo, setPhoto] = useState<UploadedFile | null>(null)
  const [addingDoc, setAddingDoc] = useState(false)
  const [docType, setDocType] = useState('')
  const [docFile, setDocFile] = useState<UploadedFile | null>(null)
  const [docExpiry, setDocExpiry] = useState('')
  const [fieldName, setFieldName] = useState('')
  const [fieldValue, setFieldValue] = useState('')
  /* The details were readable and not writable.

     A PATCH for the whole staff record has existed since employees became
     editable at all; nothing on this screen called it, so a phone number
     changed at the desk still needed the older bulk form somewhere else. */
  const [editing, setEditing] = useState(false)
  const [viewingPhoto, setViewingPhoto] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  /* The printable overview, opened in the same viewer the report cards print
     through. The server hands back {html, css}; CardViewer sanitises it,
     scales it to the page and prints it — the one print path in the product. */
  const [report, setReport] = useState<{ html: string; css?: string; name?: string } | null>(null)
  const exportReport = useMutation({
    mutationFn: () => api.get<{ html: string; css?: string }>(
      `/api/v1/hr/employees/${employeeID}/overview/report`),
    onSuccess: (v) => setReport({ ...v, name: `${d?.full_name ?? 'Staff'}, overview` }),
  })

  const detail = useQuery({
    queryKey: ['staff-detail', employeeID],
    queryFn: () => api.get<Detail>(`/api/v1/hr/employees/${employeeID}/detail`),
  })

  const sections = useQuery({
    queryKey: ['sections'],
    enabled: adding,
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })

  /* The subjects the chosen section's CLASS takes.

     Offering every subject in the school would offer Sanskrit to a section
     that does not take it, and the server would refuse on submit — after the
     person had chosen. Filtered by class rather than by section because a
     class subject is a property of the class: 7-A and 7-B take the same
     subjects and differ only in who teaches them. */
  const chosenClass = (sections.data?.items ?? [])
    .find((x) => x.id === sectionID)?.class_id
  const subjects = useQuery({
    queryKey: ['class-subjects', chosenClass],
    enabled: !!chosenClass,
    queryFn: () => api.get<List<{ id: string; subject_name: string }>>(
      `/api/v1/setup/class-subjects?class_id=${chosenClass}`),
  })

  const assign = useMutation({
    mutationFn: () => api.post<{ taken_from: string }>(
      `/api/v1/setup/employees/${employeeID}/subjects`,
      { section_id: sectionID, class_subject_id: classSubjectID }),
    onSuccess: () => {
      setAdding(false)
      setSectionID('')
      setClassSubjectID('')
      detail.refetch()
      qc.invalidateQueries({ queryKey: ['staff'] })
    },
  })

  const designations = useQuery({
    queryKey: ['designations'],
    enabled: editing,
    queryFn: () => api.get<List<{ id: string; name: string }>>(
      '/api/v1/hr-growth/designations'),
  }).data?.items ?? []

  const saveDetails = useMutation({
    mutationFn: () => {
      /* Only what changed. PATCH here means "these fields"; sending every
         one would rewrite values nobody touched, and two people with the
         record open would undo each other. */
      const changed: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(draft)) {
        if (v !== ((d?.[k as keyof Detail] as string | undefined) ?? '')) {
          changed[k] = k === 'experience_years' ? Number(v) || 0 : v
        }
      }
      return api.patch(`/api/v1/setup/employees/${employeeID}`, changed)
    },
    onSuccess: () => {
      setEditing(false)
      setDraft({})
      detail.refetch()
      // The directory list is a separate query; without this a status change
      // (or any edit) shows on the record but the list keeps the old value
      // until a manual page reload.
      qc.invalidateQueries({ queryKey: ['employees'] })
    },
  })

  const savePhoto = useMutation({
    mutationFn: (fileID: string) =>
      api.put(`/api/v1/setup/employees/${employeeID}/photo`, { file_id: fileID }),
    onSuccess: () => { setPhoto(null); detail.refetch() },
  })

  const addDoc = useMutation({
    mutationFn: () => api.post(`/api/v1/setup/employees/${employeeID}/documents`, {
      doc_type: docType, file_id: docFile?.file_id, expires_on: docExpiry,
    }),
    onSuccess: () => {
      setAddingDoc(false); setDocType(''); setDocFile(null); setDocExpiry('')
      detail.refetch()
    },
  })

  const removeDoc = useMutation({
    mutationFn: (docID: string) =>
      api.del(`/api/v1/setup/employees/${employeeID}/documents/${docID}`),
    onSuccess: () => detail.refetch(),
  })

  const saveField = useMutation({
    mutationFn: (next: Record<string, string>) =>
      api.post(`/api/v1/setup/employees/${employeeID}/custom-fields`,
        { custom_fields: next }),
    onSuccess: () => { setFieldName(''); setFieldValue(''); detail.refetch() },
  })

  const unassign = useMutation({
    mutationFn: (allocID: string) =>
      api.del(`/api/v1/setup/employees/${employeeID}/subjects/${allocID}`),
    onSuccess: () => detail.refetch(),
  })

  const d = detail.data
  const summary = useQuery({
    queryKey: ['staff-summary', employeeID],
    queryFn: () => api.get<Summary>(`/api/v1/hr/employees/${employeeID}/summary`),
  })
  const s = summary.data

  /* The record is the same shell Student 360 wears: photo, name and status
     on top, then tabs across the facts, so learning one 360 teaches the other.
     It opens over the directory, so the shell sits in a full-screen layer. */
  const shell = (body: React.ReactNode) => createPortal(
    /* z-[90], above the maximised-table view (z-80) as well as the ordinary
       page, and below the printable card viewer (z-100) that prints from here. */
    <div className="vv-screen-phone fixed inset-0 z-[90] overflow-y-auto bg-background">
      {body}
      {report && <CardViewer card={report} onClose={() => setReport(null)} />}
      {viewingPhoto && d?.photo_file_id && (
        <PhotoViewer src={`/api/v1/files/${d.photo_file_id}?inline=1`} name={`${d.full_name}'s photo`}
          onClose={() => setViewingPhoto(false)} />
      )}
    </div>,
    document.body,
  )

  if (detail.isLoading || detail.error || !d) {
    return shell(
      <div className="px-[var(--page-gutter)] py-6">
        <Button variant="secondary" size="sm" onClick={close}>Back to staff</Button>
        <div className="mt-4">{detail.error ? <ErrorState error={detail.error} /> : <Loading />}</div>
      </div>,
    )
  }

  const working = s ? s.attendance.marked - s.attendance.on_leave : 0
  const leaveLeft = s?.leave.balances.reduce((n, b) => n + (b.entitled - b.taken), 0)
  const notRecorded = (v?: string | null) => v || '-'

  const tabs: RecordTab[] = [
    {
      key: 'overview', label: 'Overview',
      render: () => (
        <>
          <CellGrid cols={4}>
            <Stat label="Attendance this year" icon={CalendarCheck}
              value={s && working > 0 ? `${Math.round((s.attendance.present / working) * 100)}%` : '-'} />
            <Stat label="Leave left" icon={CalendarOff}
              value={s && s.leave.balances.length ? String(+(leaveLeft ?? 0).toFixed(1)) : '-'} />
            <Stat label="Late this year" value={s ? s.attendance.late : '-'} icon={Clock} />
            <Stat label="Open tasks" value={s ? s.tasks.length : '-'} icon={ListChecks} />
          </CellGrid>
          <StaffOverview employeeID={employeeID} />
        </>
      ),
    },
    {
      key: 'profile', label: 'Profile',
      render: () => (
        <>
          <Card>
            <CardHeader
              title="Details"
              action={
                <Button size="sm" variant={editing ? 'secondary' : 'primary'}
                  onClick={() => { setEditing(!editing); setDraft({}) }}>
                  {editing ? 'Cancel' : 'Edit'}
                </Button>
              }
            />
            {editing ? (
              <div className="space-y-4 p-4">
                <FormGrid>
                  {([
                    // Editable since 2026-10-14; a change is confirmed first (lib/confirm-overwrite.tsx).
                    ['employee_code', 'Staff code'],
                    ['first_name', 'First name'],
                    ['last_name', 'Last name'],
                    ['phone', 'Phone'],
                    ['email', 'Personal email'],
                    ['school_email', 'School email'],
                    ['qualification', 'Qualification'],
                    ['experience_years', 'Years of experience'],
                    ['emergency_contact_name', 'Emergency contact'],
                    ['emergency_contact_phone', 'Their phone'],
                    ['joined_on', 'Joined'],
                    ['confirmed_on', 'Confirmed'],
                    ['bank_account', 'Bank account number'],
                    ['bank_ifsc', 'IFSC'],
                    ['pan', 'PAN'],
                    ['uan', 'UAN'],
                    ['esi_number', 'ESI number'],
                    ['device_user_id', 'Biometric reader id'],
                  ] as [string, string][]).map(([k, label]) => (
                    <FormField key={k} label={label}>
                      <Input
                        type={k.endsWith('_on') ? 'date'
                          : k === 'experience_years' ? 'number'
                          : k.endsWith('email') ? 'email' : undefined}
                        value={draft[k] ?? ((d[k as keyof Detail] as string | undefined) ?? '')}
                        onChange={(v) => setDraft({ ...draft, [k]: v })}
                      />
                    </FormField>
                  ))}
                  <FormField label="Designation">
                    <Select
                      value={draft.designation_id ?? d.designation_id ?? ''}
                      onChange={(v) => setDraft({ ...draft, designation_id: v })}
                      placeholder="Not recorded"
                      options={designations.map((x) => ({ value: x.id, label: x.name }))}
                    />
                  </FormField>
                  <FormField label="Employment">
                    <Select
                      value={draft.employment_type ?? d.employment_type ?? ''}
                      onChange={(v) => setDraft({ ...draft, employment_type: v })}
                      placeholder="Not recorded"
                      options={[
                        { value: 'permanent', label: 'Permanent' },
                        { value: 'probation', label: 'On probation' },
                        { value: 'contract', label: 'Contract' },
                        { value: 'part_time', label: 'Part time' },
                        { value: 'visiting', label: 'Visiting' },
                      ]}
                    />
                  </FormField>
                  {/* STATUS IS HERE AND IS NOT A TEXT BOX. Marking somebody
                      resigned archives their login and revokes every live
                      session — it is the one field on this form that locks
                      a person out of the building. */}
                  <FormField label="Status"
                    hint="Resigned, terminated or retired ends their login at once">
                    <Select
                      value={draft.status ?? d.status}
                      onChange={(v) => setDraft({ ...draft, status: v })}
                      options={[
                        { value: 'active', label: 'Active' },
                        { value: 'on_leave', label: 'On leave' },
                        { value: 'suspended', label: 'Suspended' },
                        { value: 'resigned', label: 'Resigned' },
                        { value: 'terminated', label: 'Terminated' },
                        { value: 'retired', label: 'Retired' },
                      ]}
                    />
                  </FormField>
                </FormGrid>
                <FormNotice error={saveDetails.error} />
                <div className="flex items-center gap-2">
                  <Button disabled={saveDetails.isPending}
                    onClick={() => saveDetails.mutate()}>
                    {saveDetails.isPending ? 'Saving...' : 'Save changes'}
                  </Button>
                  <Button variant="secondary" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
            <div className="grid gap-px bg-border lg:grid-cols-[minmax(0,34%)_minmax(0,1fr)]">
              {/* CONTACT ON THE LEFT, EMPLOYMENT ON THE RIGHT: a number to
                  ring, or where this person sits in the school, are two
                  groups, not one list. */}
              <div className="bg-background p-5">
                <p className="eyebrow mb-3 text-muted-foreground">Contact</p>
                <div className="space-y-3">
                  {([
                    ['Phone', d.phone],
                    ['Personal email', d.email],
                    ['School email', d.school_email],
                    ['Emergency contact', d.emergency_contact_name],
                    ['Their phone', d.emergency_contact_phone],
                  ] as [string, string | undefined][]).map(([k, v]) => (
                    <div key={k}>
                      <p className="eyebrow text-muted-foreground">{k}</p>
                      <p className={cn('break-words text-[14px]', !v && 'text-muted-foreground')}>
                        {v || 'Not recorded'}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-background p-5">
                <p className="eyebrow mb-3 text-muted-foreground">Employment</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {([
                    ['Designation', d.designation],
                    ['Department', d.department],
                    ['Employment', d.employment_type],
                    ['Joined', d.joined_on ? formatDate(d.joined_on) : undefined],
                    ['Confirmed', d.confirmed_on ? formatDate(d.confirmed_on) : undefined],
                    ['Relieved', d.relieved_on ? formatDate(d.relieved_on) : undefined],
                    ['Qualification', d.qualification],
                    ['Experience', d.experience_years ? `${d.experience_years} years` : undefined],
                    ...Object.entries(d.custom_fields ?? {}),
                  ] as [string, string | undefined][])
                    /* Relieved and Confirmed show only when there is one. */
                    .filter(([k, v]) => v || !['Relieved', 'Confirmed'].includes(k))
                    .map(([k, v]) => (
                      <div key={k} className="rounded-lg border px-3 py-2">
                        <p className="eyebrow text-muted-foreground">{k}</p>
                        <p className={cn('mt-0.5 text-[14px]', !v && 'text-muted-foreground')}>
                          {v || 'Not recorded'}
                        </p>
                      </div>
                    ))}
                </div>
              </div>
            </div>
            )}
            <div className="flex flex-wrap items-end gap-2 border-t p-4">
              <div className="w-52 max-w-full">
                <FormField label="Add a field">
                  <Input value={fieldName} onChange={setFieldName}
                    placeholder="PF number" />
                </FormField>
              </div>
              <div className="min-w-[10rem] flex-1">
                <FormField label="Value">
                  <Input value={fieldValue} onChange={setFieldValue} />
                </FormField>
              </div>
              <Button
                disabled={!fieldName.trim() || saveField.isPending}
                onClick={() => saveField.mutate({ [fieldName.trim()]: fieldValue })}
              >
                {saveField.isPending ? 'Saving...' : 'Add'}
              </Button>
              <FormNotice error={saveField.error} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Photograph" description="Printed on the staff ID card." />
            <div className="flex flex-wrap items-start gap-4 p-5">
              <div className="h-[34mm] w-[28mm] shrink-0 overflow-hidden rounded border bg-muted/30">
                {d.photo_file_id && (
                  <img loading="lazy" decoding="async" src={`/api/v1/files/${d.photo_file_id}?inline=1`}
                    alt=""
                    onError={(e) => { e.currentTarget.style.display = 'none' }}
                    className="h-full w-full object-cover" />
                )}
              </div>
              <div className="min-w-0 flex-1 sm:min-w-[14rem]">
                <FilePicker
                  value={photo}
                  onChange={(f) => {
                    setPhoto(f)
                    // Saved on upload: a photograph chosen and then left
                    // unsaved is the commonest way this stays empty.
                    if (f) savePhoto.mutate(f.file_id)
                  }}
                  purpose="staff_photo"
                  label={d.photo_file_id ? 'Change photo' : 'Add a photo'}
                  hint="A portrait. Passport size prints best."
                />
                {savePhoto.error && <FormNotice error={savePhoto.error} />}
                {d.photo_file_id && (
                  <Button variant="ghost" disabled={savePhoto.isPending}
                    onClick={() => savePhoto.mutate('')}>
                    Remove it
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {/* WHERE THE SALARY GOES, apart from the contact block: an account
              number is looked at rarely and by fewer people, and is shown by
              its last four digits, which is what a person checks. */}
          <Card>
            <CardHeader
              title="Bank & statutory"
              description="Used by payroll to pay this person and to file their returns."
            />
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              {([
                ['Account', d.bank_account
                  ? `•••• ${d.bank_account.slice(-4)}`
                  : undefined],
                ['IFSC', d.bank_ifsc],
                ['PAN', d.pan],
                ['UAN', d.uan],
                ['ESI number', d.esi_number],
                ['Biometric reader id', d.device_user_id],
              ] as [string, string | undefined][]).map(([k, v]) => (
                <div key={k} className="rounded-lg border px-3 py-2">
                  <p className="eyebrow text-muted-foreground">{k}</p>
                  <p className={cn('mt-0.5 text-[14px]',
                    k === 'Account' || k === 'IFSC' ? 'font-mono' : '',
                    !v && 'font-sans text-muted-foreground')}>
                    {v || 'Not recorded'}
                  </p>
                </div>
              ))}
            </div>
            {(!d.bank_account || !d.bank_ifsc) && (
              <p className="border-t px-4 py-3 text-[13px] text-warning">
                Payroll cannot pay this person until the account number and
                IFSC are both here.
              </p>
            )}
          </Card>

          {/* SERVICE BEFORE THIS SYSTEM: what a school reads when it writes an
              experience certificate or settles seniority. */}
          {!!(d.prior_years ?? []).length && (
            <Card>
              <CardHeader
                title="Service before this system"
                description="Years the school carried across, as it recorded them."
              />
              <Table head={['Year', 'Designation', 'Attendance', 'Leave', 'Note']}>
                {(d.prior_years ?? []).map((h) => (
                  <tr key={h.year}>
                    <Td className="font-medium">{h.year}</Td>
                    <Td>{notRecorded(h.designation)}</Td>
                    <Td className="tabular-nums">
                      {h.days_total ? `${h.days_present ?? 0} of ${h.days_total}` : '-'}
                    </Td>
                    <Td className="tabular-nums">{h.leaves_taken ?? '-'}</Td>
                    <Td className="text-muted-foreground">{notRecorded(h.notes)}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
        </>
      ),
    },
    {
      key: 'teaching', label: 'Classes & subjects',
      render: () => (
        <>
          {/* Being a class teacher is a different job from teaching a
              subject, so it is listed apart rather than mixed in. */}
          {d.class_teacher_of.length > 0 && (
            <Card>
              <CardHeader title="Class teacher of" />
              <Table head={['Class', 'Students']} empty={false}>
                {d.class_teacher_of.map((c) => (
                  <tr key={c.section_id}>
                    <Td className="font-medium">{c.class}-{c.section}</Td>
                    <Td className="tabular-nums">{c.students}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Subjects they teach"
              description="The same allocation the timetable reads. Changing it here changes it there."
              action={
                <Button size="sm" variant={adding ? 'secondary' : 'primary'}
                  onClick={() => setAdding(!adding)}>
                  {adding ? 'Close' : 'Add a subject'}
                </Button>
              }
            />
            {adding && (
              <div className="space-y-3 border-b bg-muted/20 p-4">
                {!d.user_id ? (
                  /* The timetable, the register and the substitution board
                     identify a teacher by their ACCOUNT, so a class cannot be
                     allocated to somebody with no login. */
                  <p className="text-[13px] text-warning">
                    This member of staff has no login yet. The timetable and
                    the register identify a teacher by their account, so a
                    class cannot be allocated until one is issued.
                  </p>
                ) : (
                  <>
                    <FormGrid>
                      <FormField label="Section" required>
                        <Select
                          value={sectionID}
                          onChange={(v) => { setSectionID(v); setClassSubjectID('') }}
                          placeholder="Choose a section"
                          options={(sections.data?.items ?? []).map((x) => ({
                            value: x.id, label: `${x.class_name}-${x.name}`,
                          }))}
                        />
                      </FormField>
                      <FormField label="Subject" required
                        hint={sectionID ? undefined : 'Choose a section first'}>
                        <Select
                          value={classSubjectID}
                          onChange={setClassSubjectID}
                          placeholder={sectionID ? 'Choose a subject' : '-'}
                          options={(subjects.data?.items ?? []).map((x) => ({
                            value: x.id, label: x.subject_name,
                          }))}
                        />
                      </FormField>
                    </FormGrid>
                    <FormNotice error={assign.error} />
                    {assign.isSuccess && assign.data.taken_from && (
                      /* One section's subject has one teacher; assigning it
                         takes it off whoever had it. */
                      <p className="text-[13px] text-warning">
                        Taken from {assign.data.taken_from}.
                      </p>
                    )}
                    <Button
                      disabled={!sectionID || !classSubjectID || assign.isPending}
                      onClick={() => assign.mutate()}
                    >
                      {assign.isPending ? 'Assigning…' : 'Assign'}
                    </Button>
                  </>
                )}
              </div>
            )}
            <Table
              head={['Class', 'Subject', '']}
              empty={!d.teaching.length}
              emptyLabel="No subjects allocated to this member of staff."
            >
              {d.teaching.map((t) => (
                <tr key={t.id}>
                  <Td className="font-medium">{t.class}-{t.section}</Td>
                  <Td>{t.subject}</Td>
                  <Td>
                    <Button size="sm" variant="ghost" disabled={unassign.isPending}
                      onClick={() => unassign.mutate(t.id)}>
                      Remove
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
            {/* Removing an allocation leaves the period on the timetable with
                nobody against it, rather than taking the lesson off the week. */}
            <p className="px-5 pb-4 text-[12px] text-muted-foreground">
              Removing a subject leaves the period on the timetable with no
              teacher against it. It does not take the lesson off the class.
            </p>
          </Card>
        </>
      ),
    },
    {
      key: 'timetable', label: 'Timetable',
      render: () => (
        <Card>
          <CardHeader title="Timetable" description="Their week, from this year's timetable." />
          <div className="p-4">
            {summary.error ? <ErrorState error={summary.error} /> : !s ? <Loading shape="inline" /> : (
              <WeekGrid
                periods={s.timetable.periods.map((p) => ({ ...p, is_break: !!p.is_break }))}
                entries={s.timetable.entries.map((e) => ({
                  weekday: e.weekday, period_id: e.period_id, title: e.class, detail: e.subject, room: e.room,
                }))}
                empty="No periods are timetabled for this member of staff yet."
              />
            )}
          </div>
        </Card>
      ),
    },
    {
      key: 'attendance', label: 'Attendance',
      render: () => summary.error ? <ErrorState error={summary.error} /> : !s ? <Loading shape="inline" /> : (
        <>
          <CellGrid cols={4}>
            <Stat label="Days marked" value={s.attendance.marked} />
            <Stat label="Present" value={s.attendance.present} />
            <Stat label="Absent" value={s.attendance.absent} />
            <Stat label="Late" value={s.attendance.late} />
          </CellGrid>
          <Card>
            <CardHeader title="Last 30 days marked" description="The register, with the reader's punches where there are any." />
            <Table head={['Date', 'Status', 'In', 'Out', 'Source']} empty={!s.attendance.recent.length}
              emptyLabel="Nothing marked yet.">
              {s.attendance.recent.map((a) => (
                <tr key={a.on_date}>
                  <Td className="whitespace-nowrap">{dayLong(a.on_date)}</Td>
                  <Td>
                    <Badge tone={a.status === 'absent' ? 'danger' : a.status === 'late' ? 'warning' : a.status === 'present' ? 'success' : 'neutral'}>
                      {a.status.replace(/_/g, ' ')}
                    </Badge>
                  </Td>
                  <Td className="tabular-nums whitespace-nowrap">{formatTime(a.check_in)}</Td>
                  <Td className="tabular-nums whitespace-nowrap">{formatTime(a.check_out)}</Td>
                  <Td className="text-muted-foreground">{a.source}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      ),
    },
    {
      key: 'leave', label: 'Leave',
      render: () => summary.error ? <ErrorState error={summary.error} /> : !s ? <Loading shape="inline" /> : (
        <>
          <Card>
            <CardHeader title="Balances" description="This year, by leave type." />
            <Table head={['Type', 'Entitled', 'Taken', 'Left']} empty={!s.leave.balances.length}
              emptyLabel="No leave balances set for this year.">
              {s.leave.balances.map((b) => (
                <tr key={b.type}>
                  <Td className="font-medium">{b.type}</Td>
                  <Td className="tabular-nums">{+b.entitled.toFixed(1)}</Td>
                  <Td className="tabular-nums">{+b.taken.toFixed(1)}</Td>
                  <Td className="tabular-nums">{+(b.entitled - b.taken).toFixed(1)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card>
            <CardHeader title="Requests" description="The latest twenty, newest first." />
            <Table head={['From', 'To', 'Type', 'Days', 'Status', 'Reason']} empty={!s.leave.requests.length}
              emptyLabel="No leave asked for.">
              {s.leave.requests.map((l) => (
                <tr key={l.id}>
                  <Td>{formatDate(l.from_date)}</Td>
                  <Td>{formatDate(l.to_date)}</Td>
                  <Td>{l.type}</Td>
                  <Td className="tabular-nums">{l.days}</Td>
                  <Td>
                    <Badge tone={l.status === 'approved' ? 'success' : l.status === 'rejected' ? 'danger' : l.status === 'pending' ? 'warning' : 'neutral'}>
                      {l.status}
                    </Badge>
                  </Td>
                  <Td className="text-muted-foreground">{l.decision_note || l.reason}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      ),
    },
    /* Pay only for someone who holds payroll: the server leaves it out
       otherwise, and so does the tab. */
    ...(s?.pay ? [{
      key: 'pay', label: 'Pay',
      render: () => (
        <Card>
          <CardHeader title="Payslips" description="The last six months run." />
          <Table head={['Month', 'Paid days', 'Without pay', 'Gross', 'Deductions', 'Net', '']} empty={!s.pay!.length}
            emptyLabel="No payslips yet.">
            {s.pay!.map((p) => (
              <tr key={`${p.year}-${p.month}`}>
                <Td className="font-medium">{MONTHS[p.month - 1]} {p.year}</Td>
                <Td className="tabular-nums">{p.paid_days}</Td>
                <Td className="tabular-nums">{p.lop_days}</Td>
                <Td className="tabular-nums">{formatPaise(p.gross_paise)}</Td>
                <Td className="tabular-nums">{formatPaise(p.deduction_paise)}</Td>
                <Td className="tabular-nums font-medium">{formatPaise(p.net_paise)}</Td>
                <Td>{p.published ? <Badge tone="success">Published</Badge> : <Badge>Draft</Badge>}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      ),
    } satisfies RecordTab] : []),
    {
      key: 'documents', label: 'Documents',
      render: () => (
        /* THE PAPERS, AND WHAT LAPSES. More of a teacher's file is statutory
           than a child's and most of it expires. */
        <Card>
          <CardHeader
            title="Documents"
            description="What the school holds, and when it expires."
            action={
              <Button size="sm" variant={addingDoc ? 'secondary' : 'primary'}
                onClick={() => setAddingDoc(!addingDoc)}>
                {addingDoc ? 'Close' : 'Add a document'}
              </Button>
            }
          />
          {addingDoc && (
            <div className="space-y-3 border-b bg-muted/20 p-4">
              <FormGrid>
                <FormField label="What is it" required>
                  <Select
                    value={STAFF_DOCS.includes(docType) ? docType : ''}
                    onChange={setDocType}
                    placeholder="Choose one, or type your own beside it"
                    options={STAFF_DOCS.map((x) => ({ value: x, label: x }))}
                  />
                </FormField>
                <FormField label="Or something else">
                  <Input value={docType} onChange={setDocType} />
                </FormField>
                <FormField label="Expires on"
                  hint="Leave blank for a document that does not lapse">
                  <Input type="date" value={docExpiry} onChange={setDocExpiry} />
                </FormField>
              </FormGrid>
              <FilePicker
                value={docFile}
                onChange={setDocFile}
                purpose="staff_document"
                label={docFile ? 'Choose a different file' : 'Choose the scan'}
              />
              <FormNotice error={addDoc.error} />
              <Button
                disabled={!docType.trim() || !docFile || addDoc.isPending}
                onClick={() => addDoc.mutate()}
              >
                {addDoc.isPending ? 'Saving...' : 'Add it'}
              </Button>
            </div>
          )}
          <Table
            head={['Document', 'Added', 'Expires', '']}
            empty={!d.documents.length}
            emptyLabel="Nothing on file for this member of staff."
          >
            {d.documents.map((x) => (
              <tr key={x.id}>
                <Td className="font-medium">
                  {x.doc_type}
                  {x.filename && (
                    <span className="block text-[12px] font-normal text-muted-foreground">
                      {x.filename}
                    </span>
                  )}
                </Td>
                <Td className="text-muted-foreground">{formatDate(x.uploaded_on)}</Td>
                <Td>
                  {x.expires_on ? (
                    <Badge tone={new Date(x.expires_on) < new Date() ? 'danger' : 'neutral'}>
                      {formatDate(x.expires_on)}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">does not expire</span>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={`/api/v1/files/${x.file_id}`} target="_blank"
                      rel="noreferrer" className="text-[13px] text-primary">
                      View
                    </a>
                    <Button size="sm" variant="ghost" disabled={removeDoc.isPending}
                      onClick={() => removeDoc.mutate(x.id)}>
                      Remove
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      ),
    },
    {
      key: 'tasks', label: 'Tasks', badge: s?.tasks.length || undefined,
      render: () => summary.error ? <ErrorState error={summary.error} /> : !s ? <Loading shape="inline" /> : (
        <Card>
          <CardHeader title="Open tasks" description="Given to them and not yet done. Done tasks are on the timeline." />
          <Table head={['Task', 'Due', 'Priority', 'Given by']} empty={!s.tasks.length} emptyLabel="No open tasks.">
            {s.tasks.map((k) => (
              <tr key={k.id}>
                <Td className="font-medium">{k.title}</Td>
                <Td>{k.due_on ? formatDate(k.due_on) : '-'}</Td>
                <Td><Badge tone={k.priority === 'high' ? 'warning' : 'neutral'}>{k.priority}</Badge></Td>
                <Td className="text-muted-foreground">{k.assigned_by || '-'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      ),
    },
    {
      key: 'timeline', label: 'Timeline',
      render: () => <Timeline url={`/api/v1/hr/employees/${employeeID}/timeline`} />,
    },
  ]

  const actions: RecordAction[] = [
    /* It opens the print sheet, where Save as PDF is the browser's own
       choice; calling it Export PDF promised a file. */
    { label: exportReport.isPending ? 'Preparing…' : 'Print overview', onClick: () => exportReport.mutate(), disabled: exportReport.isPending },
  ]

  return shell(
    <>
      {exportReport.error && (
        <div className="border-b bg-destructive/10 px-[var(--page-gutter)] py-2 text-[13px] text-destructive">
          The overview could not be prepared for printing. Please try again.
        </div>
      )}
      <RecordShell
        title={d.full_name}
        media={
          /* A tap opens the photo, as on Student 360; only when there is one. */
          <button
            type="button"
            onClick={() => d.photo_file_id && setViewingPhoto(true)}
            disabled={!d.photo_file_id}
            aria-label={d.photo_file_id ? `View ${d.full_name}'s photo` : undefined}
            className="relative m-0 grid h-[76px] w-[76px] shrink-0 place-items-center overflow-hidden rounded-full border-2 border-card bg-primary/10 text-[22px] font-bold text-primary shadow-md disabled:cursor-default"
          >
            {d.full_name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
            {d.photo_file_id && (
              <img src={`/api/v1/files/${d.photo_file_id}?inline=1`} alt=""
                onError={(e) => { e.currentTarget.style.display = 'none' }}
                className="absolute inset-0 h-full w-full object-cover" />
            )}
          </button>
        }
        subtitle={[d.relieved_on && `Left on ${formatDate(d.relieved_on)}`, d.designation, d.department, d.employee_code].filter(Boolean).join(' · ')}
        status={d.status}
        tabs={tabs}
        actions={actions}
        onBack={close}
        backLabel="Back to staff"
        /* Its own key, so the directory's own query string is left alone. */
        tabParam="staff_tab"
      />
    </>,
  )
}
