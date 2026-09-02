import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Button, Field, FormGrid, FormNotice, Input,
} from '@/components/ui'
import BulkImport from '@/components/BulkImport'
import RoleSelect from '@/components/RoleSelect'
import { Select } from '@/components/ui'
import { useCan } from '@/lib/session'
import { type List } from '@/lib/api'

/* Appointing somebody, from the HR account.
 *
 * The HR role has held hr.employees.write since the role set was written, and
 * every screen it could reach was read-only. The only form that appoints
 * anybody lives in the setup wizard, and the wizard is registered to the
 * principal and the platform operator — so an HR manager could be given the
 * permission, sign in, and find no way to use it. The permission and the
 * ability had come apart, which is the kind of gap nobody reports as a bug
 * because it looks like the product simply does not do that.
 *
 * WHO GETS THE ALLOCATION CONTROLS
 *
 * Appointing somebody needs hr.employees.write; putting them in front of a
 * class needs academics.write, and HR does not hold it. So the subject and
 * section pickers appear only for somebody who can actually use them — the
 * principal and the head of department, who reach this same form. Showing them
 * to HR would produce a form half of which 403s on submit, which is worse than
 * not showing them: it implies HR can do something they cannot, and they find
 * out after typing everything in. HR still gets the note saying who to ask.
 *
 * Optional even for those who can. A teacher appointed in June whose timetable
 * is settled in July is ordinary, and a required subject would mean inventing
 * one to get the form to submit.
 */

export default function AddStaff({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [added, setAdded] = useState('')


  /* What this person will teach, where.

     Two questions, because they are two different facts: a subject teacher
     takes one subject across several sections, and a class teacher answers for
     one section across every subject. Both are set here so a new appointment
     does not need a second screen the same afternoon. */
  const [sectionID, setSectionID] = useState('')
  const [classSubjectID, setClassSubjectID] = useState('')
  const [classTeacher, setClassTeacher] = useState(false)

  const mayAllocate = useCan()('academics.write')

  const sections = useQuery({
    queryKey: ['sections'],
    enabled: mayAllocate,
    queryFn: () => api.get<List<{
      id: string; name: string; class_id: string; class_name: string
    }>>('/api/v1/academics/sections'),
  })
  const section = (sections.data?.items ?? []).find((x) => x.id === sectionID)

  /* The subjects that section actually takes, not every subject in the school.

     A dropdown listing Sanskrit for a section that does not take it is a
     dropdown that produces an allocation nobody can teach against. */
  const subjects = useQuery({
    queryKey: ['class-subjects', sectionID],
    enabled: mayAllocate && !!section,
    queryFn: async () => {
      const r = await api.get<{ items: { section_id: string; class_subject_id: string; subject: string }[] }>(
        `/api/v1/academics/admin/faculty-allocation?class_id=${section!.class_id}`)
      // One row per section-subject; this section's, deduplicated by subject.
      return Array.from(
        new Map(r.items.filter((x) => x.section_id === sectionID)
          .map((x) => [x.class_subject_id, x])).values())
    },
  })

  const blank = {
    employee_code: '', first_name: '', last_name: '',
    email: '', phone: '', role_key: 'faculty', role_keys: [] as string[], create_login: true,
  }
  const [f, setF] = useState(blank)
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v })

  /* The roles that stand in front of a class.

     Deliberately short. A head of department and a vice principal teach in
     most Indian schools and a class teacher obviously does; a librarian, a
     nurse, a driver and an accountant do not, and an examination controller
     runs the exam rather than the lesson. */
  const TEACHING_ROLES = new Set(['faculty', 'class_teacher', 'hod', 'vice_principal'])
  const teaches =
    TEACHING_ROLES.has(f.role_key) || f.role_keys.some((k) => TEACHING_ROLES.has(k))

  const save = useMutation({
    mutationFn: async () => {
      const made = await api.post<{ user_id?: string; employee?: { user_id?: string } }>(
        '/api/v1/setup/employees', { ...f, create_login: !!f.email })
      const userID = made.user_id ?? made.employee?.user_id
      /* The allocation is a second call, after the person exists.

         It cannot be part of the first: there is no user id to allocate until
         the appointment has been written. A failure here leaves the person
         appointed and unallocated, which is the state they were in before this
         form offered the pickers at all — recoverable on the allocation
         screen, rather than losing the appointment too. */
      if (mayAllocate && userID && sectionID) {
        if (classSubjectID) {
          await api.post('/api/v1/academics/admin/faculty-allocation', {
            allocations: [{
              section_id: sectionID,
              class_subject_id: classSubjectID,
              teacher_user_id: userID,
            }],
          })
        }
        if (classTeacher) {
          await api.post('/api/v1/setup/class-teacher', {
            section_id: sectionID, teacher_user_id: userID,
          })
        }
      }
      return made
    },
    onSuccess: () => {
      qc.invalidateQueries()
      const where = sectionID && section
        ? ` — ${section.class_name}-${section.name}${classTeacher ? ', as its class teacher' : ''}`
        : ''
      setAdded(`${[f.first_name, f.last_name].filter(Boolean).join(' ')} added${where}`)
      setF(blank)
      setSectionID('')
      setClassSubjectID('')
      setClassTeacher(false)
      onDone?.()
    },
  })

  if (!open) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => setOpen(true)}>Add a staff member</Button>
        <span className="text-[12.5px] text-muted-foreground">
          Appoint one person, or import your whole staff list from a spreadsheet.
        </span>
      </div>
    )
  }

  return (
    <div className="mb-5 rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-[14px] font-medium">Add a staff member</p>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Employee code and first name are required.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setOpen(false); setAdded('') }}>
          Close
        </Button>
      </div>

      <div className="p-4">
        <FormNotice error={save.error} ok={added} />

        <FormGrid>
          <Field label="Employee code" required hint="Whatever your registers already use.">
            <Input value={f.employee_code} onChange={set('employee_code')} placeholder="T-014" />
          </Field>
          <Field label="Role" hint="Every role your school has, including any you have created.">
            {/* Same control as the setup wizard: one main role, plus any
                other hats. A school of forty has one person doing two jobs
                more often than not. */}
            <RoleSelect
              value={f.role_key}
              onChange={(x) => setF((p) => ({ ...p, role_key: x, role_keys: p.role_keys.filter((k) => k !== x) }))}
              extra={f.role_keys}
              onExtra={(v) => setF((p) => ({ ...p, role_keys: v }))}
            />
          </Field>
          <Field label="First name" required>
            <Input value={f.first_name} onChange={set('first_name')} />
          </Field>
          <Field label="Last name">
            <Input value={f.last_name} onChange={set('last_name')} />
          </Field>
          <Field label="Email" hint="Used to sign in. Leave blank for staff who will not.">
            <Input type="email" value={f.email} onChange={set('email')} />
          </Field>
          <Field label="Phone">
            <Input value={f.phone} onChange={set('phone')} />
          </Field>
        </FormGrid>

        {/* Only for somebody who can allocate, AND only for somebody who
            teaches.

            A bus attendant was being asked which subject they take in which
            section. The block was gated on the permission of the person
            filling the form and not on the job of the person being added, so
            every driver, cleaner, nurse and accountant got a section picker
            and a "make them class teacher" tick. It is not merely noise: a
            form that asks a nonsense question about somebody teaches whoever
            is filling it in that the product does not know what a school is.

            An unknown role — one this school invented — is treated as not
            teaching. Wrong occasionally, and wrong in the direction where the
            answer is "set it on Teacher Assignment", which is where every
            timetable actually gets decided anyway. */}
        {mayAllocate && teaches && (
          <div className="mt-5 border-t pt-5">
            <div className="eyebrow mb-3">What they will teach</div>
            <FormGrid>
              <Field label="Section">
                <Select
                  value={sectionID}
                  onChange={(v) => { setSectionID(v); setClassSubjectID('') }}
                  placeholder="Not yet decided"
                  options={[
                    { value: '', label: 'Not yet decided' },
                    ...(sections.data?.items ?? []).map((x) => ({
                      value: x.id, label: `${x.class_name}-${x.name}`,
                    })),
                  ]}
                />
              </Field>
              <Field label="Subject">
                <Select
                  value={classSubjectID}
                  onChange={setClassSubjectID}
                  placeholder={sectionID ? 'Choose a subject' : 'Choose a section first'}
                  options={[
                    { value: '', label: 'None yet' },
                    ...(subjects.data ?? []).map((x) => ({
                      value: x.class_subject_id, label: x.subject,
                    })),
                  ]}
                />
              </Field>
            </FormGrid>
            <label className="mt-3 flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={classTeacher}
                disabled={!sectionID}
                onChange={(e) => setClassTeacher(e.target.checked)}
              />
              {/* Different from teaching it: the class teacher answers for the
                  whole child — attendance, the report card, the parents. */}
              Also make them class teacher of this section
            </label>
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              Both optional. A teacher appointed in June whose timetable is
              settled in July is ordinary — leave these and set them on
              Teacher Assignment later.
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={save.isPending || !f.employee_code.trim() || !f.first_name.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Adding…' : 'Add staff member'}
          </Button>
          {/* The same note, and only for somebody who will actually stand in
              front of a class: telling the office that a driver "sees nothing
              until somebody puts them in front of a class" is the same
              nonsense as offering them a subject picker. */}
          {!mayAllocate && teaches && (
            <span className="text-[12.5px] text-muted-foreground">
              A teacher added here sees nothing until somebody puts them in front of a class.
              Ask your principal or the head of department to assign them a section and a subject —
              that is what grants access, not the role.
            </span>
          )}
        </div>

        <div className="mt-5 border-t pt-5">
          <BulkImport
            entity="staff"
            title="Or add your whole staff list from a sheet"
            hint="Employee code and first name are required. Give an email and a role and they get a login too."
            onDone={onDone}
          />
        </div>
      </div>
    </div>
  )
}
