import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api, type List, type Section } from '@/lib/api'
import {
  Card, CardHeader, FormGrid, Field as FormField, Select, FormNotice,
  Table, Td, Button, Loading, ErrorState,
} from '@/components/ui'
import { Field } from '@/components/RecordShell'
import { formatDate } from '@/lib/utils'

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
  teaching: {
    id: string; class: string; section: string; subject: string
    section_id: string; class_subject_id: string
  }[]
  class_teacher_of: { section_id: string; class: string; section: string; students: string }[]
}

export default function StaffRecord({ employeeID, onClose }: {
  employeeID: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [sectionID, setSectionID] = useState('')
  const [classSubjectID, setClassSubjectID] = useState('')

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
        <button type="button" onClick={onClose} aria-label="Close"
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
                <CardHeader title="Details" />
                <dl className="divide-y text-[14px]">
                  <Field k="Employee code" v={d.employee_code} mono />
                  <Field k="Status" v={d.status} />
                  <Field k="Designation" v={d.designation} />
                  <Field k="Department" v={d.department} />
                  <Field k="Employment" v={d.employment_type} />
                  <Field k="Joined" v={formatDate(d.joined_on)} />
                  <Field k="Confirmed" v={d.confirmed_on ? formatDate(d.confirmed_on) : undefined} />
                  <Field k="Relieved" v={d.relieved_on ? formatDate(d.relieved_on) : undefined} />
                  <Field k="Phone" v={d.phone} />
                  <Field k="Email" v={d.email} />
                  <Field k="Qualification" v={d.qualification} />
                  <Field k="Experience"
                    v={d.experience_years ? `${d.experience_years} years` : undefined} />
                  <Field k="Emergency contact" v={d.emergency_contact_name} />
                  <Field k="Their phone" v={d.emergency_contact_phone} />
                </dl>
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
