import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import AdmissionFee from './AdmissionFee'
import { api, type List } from '@/lib/api'
import {
  Button, Field, FormGrid, FormNotice, Input, Select, Checkbox,
} from '@/components/ui'

/* Admitting one child.
 *
 * POST /api/v1/students has existed since the beginning and no screen ever
 * called it. The wizard's enrol step offered "Admit one student" as a link to
 * the student directory, which is a search box — so the walk-in case, a parent
 * standing at the counter, had no form anywhere in the product. The only way
 * to add a student was to write a spreadsheet and import it, which is not a
 * thing anybody does with a parent waiting.
 *
 * One form, three groups, and only a first name is required. Schools fill
 * records in over weeks: the child is admitted today, the blood group arrives
 * with the medical form in a fortnight, and a form that demands both before it
 * will save anything is a form the office works around by keeping the paper
 * register.
 *
 * The guardian is on the same form rather than a second step, because a child
 * with no contactable adult is the one record the school cannot use. Fee
 * reminders, absence alerts and the parent portal all key off it.
 */

interface Section {
  id: string
  name: string
  class_name: string
  // The fee structure is per class and this form asks for a section, so the
  // class it belongs to has to come back with it.
  class_id: string
  capacity?: number
  filled?: number
}

export default function AdmitStudent({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient()
  const [admitted, setAdmitted] = useState<string | null>(null)
  const [justAdmitted, setJustAdmitted] = useState<
    { id: string; name: string; classID?: string } | null>(null)

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })

  const blank = {
    admission_no: '', first_name: '', middle_name: '', last_name: '',
    date_of_birth: '', gender: '', blood_group: '', medium: '',
    mother_tongue: '', section_id: '', roll_no: '',
    guardian_name: '', guardian_relation: 'father', guardian_phone: '', guardian_email: '',
  }
  const [f, setF] = useState(blank)
  const [rte, setRte] = useState(false)
  const [cwsn, setCwsn] = useState(false)
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v })

  const admit = useMutation({
    mutationFn: () =>
      api.post<{ id: string; admission_no: string }>('/api/v1/students', {
        ...f,
        roll_no: f.roll_no ? Number(f.roll_no) : undefined,
        is_rte: rte,
        is_cwsn: cwsn,
      }),
    onSuccess: (created) => {
      // The handler returns the id and the admission number it issued, not the
      // name — so the confirmation is built from what was typed plus what came
      // back, which is also the pair the office needs to write on the form.
      const named = [f.first_name, f.last_name].filter(Boolean).join(' ').trim()
      // Everything on the page counts students, and none of it knows.
      qc.invalidateQueries()
      setAdmitted(`${named} admitted${created.admission_no ? ` · admission no. ${created.admission_no}` : ''}`)
      /* Held so the concession agreed at the desk can be recorded against the
         child who was just admitted. The form clears for the next in the
         queue; this does not, because the conversation about the fee happens
         after the admission and not before. */
      setJustAdmitted({ id: created.id, name: named, classID: classOf(f.section_id) })
      // Cleared for the next child rather than left filled: the counter case is
      // a queue, and re-typing over somebody else's details is how two
      // siblings end up sharing a date of birth.
      setF(blank)
      setRte(false)
      setCwsn(false)
      onDone?.()
    },
  })

  const items = sections.data?.items ?? []
  // The class the chosen section belongs to: the fee structure is per class,
  // and the form asks for a section.
  const classOf = (sectionID: string) =>
    items.find((x) => x.id === sectionID)?.class_id

  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <p className="text-[14px] font-medium">Admit one student</p>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">
          The walk-in case. Only a first name is required — the rest can be filled in later.
        </p>
      </div>

      <div className="p-4">
        <FormNotice error={admit.error} ok={admitted ?? ''} />

        <FormGrid>
          <Field label="First name" required>
            <Input value={f.first_name} onChange={set('first_name')} placeholder="Aarav" />
          </Field>
          <Field label="Middle name">
            <Input value={f.middle_name} onChange={set('middle_name')} />
          </Field>
          <Field label="Last name">
            <Input value={f.last_name} onChange={set('last_name')} placeholder="Sharma" />
          </Field>
          <Field label="Admission number" hint="Leave blank and one is issued in sequence.">
            <Input value={f.admission_no} onChange={set('admission_no')} />
          </Field>
          <Field label="Date of birth">
            <Input type="date" value={f.date_of_birth} onChange={set('date_of_birth')} />
          </Field>
          <Field label="Gender">
            <Select
              value={f.gender}
              onChange={set('gender')}
              placeholder="Not recorded"
              options={[
                { value: 'male', label: 'Male' },
                { value: 'female', label: 'Female' },
                { value: 'other', label: 'Other' },
              ]}
            />
          </Field>
          <Field label="Medium">
            <Select
              kind="medium"
              addLabel="Add another medium"
              value={f.medium}
              onChange={set('medium')}
              placeholder="Not recorded"
              options={['telugu', 'english', 'urdu', 'hindi', 'other'].map((m) => ({
                value: m, label: m[0].toUpperCase() + m.slice(1),
              }))}
            />
          </Field>
          <Field label="Mother tongue">
            <Select
              kind="mother_tongue"
              addLabel="Add a language"
              value={f.mother_tongue}
              onChange={set('mother_tongue')}
              placeholder="Not recorded"
              options={[]}
            />
          </Field>
          <Field label="Blood group">
            <Select
              kind="blood_group"
              addLabel="Add another group"
              value={f.blood_group}
              onChange={set('blood_group')}
              placeholder="Not recorded"
              options={['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => ({
                value: b, label: b,
              }))}
            />
          </Field>
        </FormGrid>

        <p className="mt-5 text-[13px] font-medium">Which class</p>
        <FormGrid>
          <Field label="Section" hint={items.length ? undefined : 'Add sections first, on the earlier step.'}>
            <Select
              value={f.section_id}
              onChange={set('section_id')}
              placeholder={items.length ? 'Choose a section' : 'No sections yet'}
              options={items.map((s) => ({
                value: s.id,
                label: `${s.class_name}-${s.name}`,
              }))}
            />
          </Field>
          {/* WHAT IT COSTS, WHERE THE FAMILY ASKS.

              A parent at the desk asks the price, and the clerk had to open
              the finance module to answer — so they quoted from memory or from
              a sheet that went stale in April. This reads the same structure
              the demand raise reads, so what the family is told is what the
              invoice will carry. */}
          <div className="sm:col-span-2">
            <AdmissionFee
              classID={justAdmitted?.classID ?? classOf(f.section_id)}
              studentID={justAdmitted?.id}
              studentName={justAdmitted?.name}
            />
          </div>
          <Field label="Roll number" hint="Leave blank to assign later.">
            <Input value={f.roll_no} onChange={set('roll_no')} />
          </Field>
        </FormGrid>

        <p className="mt-5 text-[13px] font-medium">Parent or guardian</p>
        <p className="mb-1 text-[12.5px] text-muted-foreground">
          A child with no contactable adult is the one record the school cannot use —
          fee reminders, absence alerts and the parent app all key off this.
        </p>
        <FormGrid>
          <Field label="Name">
            <Input value={f.guardian_name} onChange={set('guardian_name')} placeholder="Suresh Sharma" />
          </Field>
          <Field label="Relation">
            <Select
              kind="relation"
              addLabel="Add a relation"
              value={f.guardian_relation}
              onChange={set('guardian_relation')}
              options={[
                { value: 'father', label: 'Father' },
                { value: 'mother', label: 'Mother' },
                { value: 'guardian', label: 'Guardian' },
              ]}
            />
          </Field>
          <Field label="Phone">
            <Input value={f.guardian_phone} onChange={set('guardian_phone')} placeholder="98765 43210" />
          </Field>
          <Field label="Email">
            <Input value={f.guardian_email} onChange={set('guardian_email')} />
          </Field>
        </FormGrid>

        <div className="mt-4 flex flex-wrap gap-4">
          <Checkbox label="Admitted under RTE" checked={rte} onChange={setRte} />
          <Checkbox label="Child with special needs (CWSN)" checked={cwsn} onChange={setCwsn} />
        </div>

        <div className="mt-5 flex items-center gap-3">
          <Button disabled={admit.isPending || !f.first_name.trim()} onClick={() => admit.mutate()}>
            {admit.isPending ? 'Admitting…' : 'Admit student'}
          </Button>
          <span className="text-[12.5px] text-muted-foreground">
            No login is created. The child and their guardian get portal access only when you
            issue it.
          </span>
        </div>
      </div>
    </div>
  )
}
