import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api, type List, type Section } from '@/lib/api'
import {
  Card, CardHeader, FormGrid, Field as FormField, Select, Input, FormNotice,
  Table, Td, Badge, Button, Loading, ErrorState,
} from '@/components/ui'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import { formatDate, cn } from '@/lib/utils'
import { useOverlayHistory } from '@/lib/overlay-history'

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
  const [draft, setDraft] = useState<Record<string, string>>({})

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
      `/api/v1/hr/employees/${employeeID}/subjects`,
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
    onSuccess: () => { setEditing(false); setDraft({}); detail.refetch() },
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
      api.del(`/api/v1/hr/employees/${employeeID}/subjects/${allocID}`),
    onSuccess: () => detail.refetch(),
  })

  const d = detail.data

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border bg-muted/30">
            {d?.photo_file_id && (
              <img src={`/api/v1/files/${d.photo_file_id}`} alt=""
                className="h-full w-full object-cover" />
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold">
              {d?.full_name ?? 'Staff record'}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {[d?.designation, d?.department, d?.employee_code].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        <button type="button" onClick={close} aria-label="Close"
          className="rounded p-1 text-muted-foreground hover:bg-accent">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
          {detail.isLoading ? <Loading /> : detail.error ? (
            <ErrorState error={detail.error} />
          ) : d ? (
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
                        ['first_name', 'First name'],
                        ['last_name', 'Last name'],
                        ['phone', 'Phone'],
                        ['email', 'Email'],
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
                      ] as [string, string][]).map(([k, label]) => (
                        <FormField key={k} label={label}>
                          <Input
                            type={k.endsWith('_on') ? 'date'
                              : k === 'experience_years' ? 'number' : undefined}
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
                  {/* CONTACT ON THE LEFT, EMPLOYMENT ON THE RIGHT.

                      Fourteen rows of label-and-value down one column is a
                      thing you read from the top. Somebody opening a staff
                      record wants one of two things — a number to ring, or
                      where this person sits in the school — and those are two
                      groups, not one list. */}
                  <div className="bg-background p-5">
                    <p className="eyebrow mb-3 text-muted-foreground">Contact</p>
                    <div className="space-y-3">
                      {([
                        ['Phone', d.phone],
                        ['Email', d.email],
                        ['Emergency contact', d.emergency_contact_name],
                        ['Their phone', d.emergency_contact_phone],
                      ] as [string, string | undefined][]).map(([k, v]) => (
                        <div key={k}>
                          <p className="eyebrow text-muted-foreground">{k}</p>
                          <p className={cn('text-[14px]', !v && 'text-muted-foreground')}>
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
                        /* Relieved shows only when there is one: an empty
                           "Relieved --" on every serving teacher is a row you
                           read to discover it says nothing. */
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
                  <div className="w-52">
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
                <CardHeader
                  title="Photograph"
                  description="Printed on the staff ID card."
                />
                <div className="flex flex-wrap items-start gap-4 p-5">
                  <div className="h-[34mm] w-[28mm] shrink-0 overflow-hidden rounded border bg-muted/30">
                    {d.photo_file_id && (
                      <img src={`/api/v1/files/${d.photo_file_id}`}
                        alt={`Photograph of ${d.full_name}`}
                        className="h-full w-full object-cover" />
                    )}
                  </div>
                  <div className="min-w-[14rem] flex-1">
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

              {/* WHERE THE SALARY ACTUALLY GOES.

                  Kept apart from the contact block rather than mixed into it:
                  a phone number is looked up daily by anyone, and an account
                  number is looked at rarely and by fewer people. Putting them
                  in one list makes the sensitive half as casual as the rest.

                  The account number is shown by its last four digits. That is
                  what a person checks -- "is this the account ending 4471" --
                  and it is all anyone needs to confirm the right one is on
                  file. The whole number is in the edit form for the person
                  who is entitled to change it. */}
              <Card>
                <CardHeader
                  title="Bank & statutory"
                  description="Used by payroll to pay this person and to file their returns."
                />
                <div className="grid gap-3 p-4 sm:grid-cols-2">
                  {([
                    ['Account', d.bank_account
                      ? `\u2022\u2022\u2022\u2022 ${d.bank_account.slice(-4)}`
                      : undefined],
                    ['IFSC', d.bank_ifsc],
                    ['PAN', d.pan],
                    ['UAN', d.uan],
                    ['ESI number', d.esi_number],
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
                {/* Said once, where somebody is looking at the gap, rather
                    than discovered on payday. */}
                {(!d.bank_account || !d.bank_ifsc) && (
                  <p className="border-t px-4 py-3 text-[13px] text-warning">
                    Payroll cannot pay this person until the account number and
                    IFSC are both here.
                  </p>
                )}
              </Card>

              {/* SERVICE BEFORE THIS SYSTEM.

                  A teacher of eleven years standing was, until now, somebody
                  who started work the morning their record was imported. This
                  is what a school reads when it writes an experience
                  certificate or settles seniority, so it belongs on the record
                  and not only in the spreadsheet the office uploaded. */}
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
                        <Td>{h.designation || 'â'}</Td>
                        <Td className="tabular-nums">
                          {h.days_total
                            ? `${h.days_present ?? 0} of ${h.days_total}`
                            : 'â'}
                        </Td>
                        <Td className="tabular-nums">{h.leaves_taken ?? 'â'}</Td>
                        <Td className="text-muted-foreground">{h.notes || 'â'}</Td>
                      </tr>
                    ))}
                  </Table>
                </Card>
              )}

              {/* THE PAPERS, AND WHAT LAPSES. More of a teacher's file is
                  statutory than a child's and most of it expires, which is why
                  the directory counts what lapses in sixty days -- and why it
                  was counting documents nobody could add. */}
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

              {/* Being a class teacher is a different job from teaching a
                  subject — the register, the report cards and the parents are
                  theirs — so it is listed apart rather than mixed in. */}
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
                         all identify a teacher by their ACCOUNT. Allocating
                         somebody with no login writes a row nothing can read,
                         so it is refused with the reason rather than saved. */
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
                              placeholder={sectionID ? 'Choose a subject' : '—'}
                              options={(subjects.data?.items ?? []).map((x) => ({
                                value: x.id, label: x.subject_name,
                              }))}
                            />
                          </FormField>
                        </FormGrid>
                        <FormNotice error={assign.error} />
                        {assign.isSuccess && assign.data.taken_from && (
                          /* One section's subject has one teacher. Assigning it
                             takes it off whoever had it, which the person doing
                             the assigning should be told rather than discover
                             next term. */
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
                {/* Said plainly: removing an allocation leaves the period on
                    the timetable with nobody against it, which is what the grid
                    already shows as "no teacher". Deleting the period instead
                    would take the lesson off the children's week because a
                    teacher left. */}
                <p className="px-5 pb-4 text-[12px] text-muted-foreground">
                  Removing a subject leaves the period on the timetable with no
                  teacher against it. It does not take the lesson off the class.
                </p>
              </Card>
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}
