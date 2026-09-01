import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  FormGrid, Field as FormField, Select, Input, Textarea, FormNotice, Button,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* Every field a school holds about a child, in one dialog, grouped.

   The record was editable in pieces: names through one form, contact through
   another, the statutory identifiers through a third, and the government codes
   through none at all. So "update this child" — which is one job somebody sits
   down to do — was four screens, and the fields nobody had built a form for
   were simply not editable.

   SIX TABS, NOT ONE LIST. Thirty inputs on one page is a form people abandon
   halfway; six groups of five is six small jobs, and a person doing only the
   address never sees the other twenty-five.

   SAVES ONLY WHAT CHANGED, and does it through PATCH. The alternative is
   sending the whole record back, which is how a field the dialog does not know
   about gets silently cleared by a save that had nothing to do with it. It
   also means two people editing different tabs of the same child do not undo
   each other.
*/

export interface EditableStudent {
  id: string
  full_name: string
  admission_no: string
  class_name?: string
  section_name?: string
  photo_file_id?: string
  first_name?: string
  middle_name?: string
  last_name?: string
  date_of_birth?: string
  gender?: string
  blood_group?: string
  medium?: string
  mother_tongue?: string
  religion?: string
  nationality?: string
  category?: string
  aadhaar_last4?: string
  apaar_id?: string
  child_info_id?: string
  prior_school?: string
  house_id?: string
  address_line1?: string
  address_line2?: string
  city?: string
  state?: string
  pincode?: string
  permanent_address?: string
  emergency_contact_name?: string
  emergency_contact_phone?: string
  emergency_contact_relation?: string
}

type Group = {
  key: string
  label: string
  fields: {
    name: keyof EditableStudent
    label: string
    hint?: string
    required?: boolean
    multiline?: boolean
    placeholder?: string
    options?: { value: string; label: string }[]
    /** Filled from a list the school maintains rather than a fixed set. */
    lookup?: 'house'
  }[]
}

const GROUPS: Group[] = [
  {
    key: 'student', label: 'Student details',
    fields: [
      { name: 'admission_no', label: 'Admission number', required: true },
      { name: 'first_name', label: 'First name', required: true },
      { name: 'middle_name', label: 'Middle name' },
      { name: 'last_name', label: 'Last name' },
      { name: 'date_of_birth', label: 'Date of birth' },
      {
        name: 'gender', label: 'Gender',
        options: [
          { value: 'male', label: 'Male' },
          { value: 'female', label: 'Female' },
          { value: 'other', label: 'Other' },
        ],
      },
    ],
  },
  {
    key: 'personal', label: 'Personal',
    fields: [
      { name: 'blood_group', label: 'Blood group' },
      { name: 'mother_tongue', label: 'Mother tongue' },
      { name: 'religion', label: 'Religion' },
      { name: 'nationality', label: 'Nationality', placeholder: 'Indian' },
      { name: 'medium', label: 'Medium of instruction' },
      { name: 'house_id', label: 'House', lookup: 'house' },
    ],
  },
  {
    key: 'identifiers', label: 'Aadhaar & IDs',
    fields: [
      {
        name: 'aadhaar_last4', label: 'Aadhaar (last 4 digits)',
        /* Four digits, on purpose. It is enough to match a child against a
           government list, and it means the school's database is not worth
           stealing. */
        hint: 'Only the last four are stored, deliberately',
      },
      { name: 'apaar_id', label: 'APAAR ID', hint: 'Twelve digits' },
      { name: 'child_info_id', label: 'Child Info ID' },
      {
        name: 'category', label: 'Category',
        hint: 'For RTE, scholarship and statutory returns',
        options: [
          { value: 'general', label: 'General' }, { value: 'obc', label: 'OBC' },
          { value: 'sc', label: 'SC' }, { value: 'st', label: 'ST' },
          { value: 'ews', label: 'EWS' }, { value: 'other', label: 'Other' },
        ],
      },
      { name: 'prior_school', label: 'Previous school' },
    ],
  },
  {
    key: 'address', label: 'Address',
    fields: [
      { name: 'address_line1', label: 'Address', multiline: true, placeholder: 'House number and street' },
      { name: 'address_line2', label: 'Area or landmark' },
      { name: 'city', label: 'City' },
      { name: 'state', label: 'State' },
      { name: 'pincode', label: 'Pincode', hint: 'Six digits' },
      {
        name: 'permanent_address', label: 'Permanent address', multiline: true,
        hint: 'Only if it differs from the address above',
      },
    ],
  },
  {
    key: 'emergency', label: 'Emergency contact',
    fields: [
      {
        name: 'emergency_contact_name', label: 'Name', placeholder: 'Enter name',
        /* NOT a guardian. A guardian gets a login, fee reminders and absence
           alerts; the neighbour who holds a spare key should get none of
           them. */
        hint: 'Somebody to ring when no parent answers. They get no login and no messages.',
      },
      { name: 'emergency_contact_phone', label: 'Phone number', placeholder: 'Enter phone number' },
      { name: 'emergency_contact_relation', label: 'Relation', placeholder: 'e.g. Uncle' },
    ],
  },
]

export default function StudentEditDialog({ student, onClose, onSaved }: {
  student: EditableStudent
  onClose: () => void
  onSaved: () => void
}) {
  const [tab, setTab] = useState(GROUPS[0].key)
  const [draft, setDraft] = useState<Record<string, string>>({})

  const houses = useQuery({
    queryKey: ['academics', 'houses'],
    queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/academics/houses'),
  }).data?.items ?? []

  const valueOf = (name: keyof EditableStudent) =>
    draft[name] ?? (student[name] as string | undefined) ?? ''

  const save = useMutation({
    mutationFn: () => {
      /* Only the fields actually touched. Sending all thirty would rewrite
         values nobody edited — harmless until two people have the record open,
         when the second save silently restores what the first corrected. */
      const changed: Record<string, string> = {}
      for (const [k, v] of Object.entries(draft)) {
        if (v !== ((student[k as keyof EditableStudent] as string | undefined) ?? '')) {
          changed[k] = v
        }
      }
      if (Object.keys(changed).length === 0) return Promise.resolve({})
      return api.patch(`/api/v1/students/${student.id}/fields`, changed)
    },
    onSuccess: () => { onSaved(); onClose() },
  })

  const group = GROUPS.find((g) => g.key === tab) ?? GROUPS[0]
  const dirty = Object.keys(draft).some(
    (k) => draft[k] !== ((student[k as keyof EditableStudent] as string | undefined) ?? ''))

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4 sm:p-8">
      <div className="mx-auto max-w-4xl rounded-xl border bg-background shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border bg-muted/30">
              {student.photo_file_id && (
                <img
                  src={`/api/v1/files/${student.photo_file_id}`}
                  alt=""
                  className="h-full w-full object-cover"
                />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[16px] font-semibold">
                {student.full_name}{' '}
                <span className="font-normal text-muted-foreground">
                  ({student.admission_no})
                </span>
              </p>
              <p className="text-[13px] text-muted-foreground">
                {[student.class_name, student.section_name].filter(Boolean).join(' / ') || 'Unplaced'}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="rounded p-1 text-muted-foreground hover:bg-accent">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Six groups rather than thirty inputs: a person doing only the
            address never has to look at the other twenty-five. */}
        <div className="flex flex-wrap gap-1 border-b px-4 pt-3">
          {GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => setTab(g.key)}
              className={cn(
                'rounded-t-md px-3 py-2 text-[13.5px]',
                tab === g.key
                  ? 'border-b-2 border-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {g.label}
            </button>
          ))}
        </div>

        <div className="px-6 py-5">
          <FormGrid>
            {group.fields.filter((f) => !f.multiline).map((f) => (
              <FormField key={f.name} label={f.label} hint={f.hint} required={f.required}>
                {f.lookup === 'house' ? (
                  <Select
                    value={valueOf(f.name)}
                    onChange={(v) => setDraft({ ...draft, [f.name]: v })}
                    placeholder={houses.length ? 'Not in a house' : 'No houses set up yet'}
                    options={houses.map((h) => ({ value: h.id, label: h.name }))}
                  />
                ) : f.options ? (
                  <Select
                    value={valueOf(f.name)}
                    onChange={(v) => setDraft({ ...draft, [f.name]: v })}
                    placeholder="Not recorded"
                    options={f.options}
                  />
                ) : (
                  <Input
                    type={f.name === 'date_of_birth' ? 'date' : undefined}
                    value={valueOf(f.name)}
                    onChange={(v) => setDraft({ ...draft, [f.name]: v })}
                    placeholder={f.placeholder}
                  />
                )}
              </FormField>
            ))}
          </FormGrid>
          {group.fields.filter((f) => f.multiline).map((f) => (
            <div key={f.name} className="mt-3">
              <FormField label={f.label} hint={f.hint}>
                <Textarea
                  rows={2}
                  value={valueOf(f.name)}
                  onChange={(v) => setDraft({ ...draft, [f.name]: v })}
                  placeholder={f.placeholder}
                />
              </FormField>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t px-6 py-4">
          <FormNotice error={save.error} />
          {/* Said out loud, because a dialog of six tabs is one somebody edits
              in two of them and then wonders whether the first was kept. */}
          {dirty && (
            <span className="mr-auto text-[13px] text-muted-foreground">
              Unsaved changes. Update saves every tab at once.
            </span>
          )}
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button disabled={save.isPending || !dirty} onClick={() => save.mutate()}>
            {save.isPending ? 'Updating…' : 'Update'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
