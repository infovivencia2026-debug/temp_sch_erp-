import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Card, CardHeader, FormGrid, Field as FormField, FormNotice, Button, Input,
  Textarea, Select,
} from '@/components/ui'
import { Field } from '@/components/RecordShell'

/* A block of the record, and the form that changes it.

   Two versions of the same block, and the difference is what a person is
   doing. On the page it is a summary and shows ONLY WHAT IS FILLED — a row
   reading "Nationality —" tells a reader nothing they did not know and takes
   the same room as one that does, and a dozen of them push the four facts
   actually recorded off the screen.

   Expanded it is a FORM. Every field, filled or not, as a labelled input with
   Cancel and Save — because an empty field you cannot see is a field you
   cannot fill, which is most of how they came to be empty. It expanded to a
   read-only list of dashes first, which was the worst of both: it took the
   whole window to show nothing and gave no way to change it.

   WHY A PATCH AND NOT THE STUDENT FORM. PUT /students/{id} runs the upsert the
   admission form and the CSV importer share: it takes the whole record and
   writes all of it, so a form of four fields would blank the other twenty.
   This sends the fields it owns and touches nothing else.
*/

export interface BlockField {
  /** Label, and the key the summary lists it under. */
  k: string
  v?: string | null
  /** The students column this edits. Absent means read-only — a class or an
      admission number is a fact of the record, not a box to type in. */
  field?: string
  multiline?: boolean
  placeholder?: string
  hint?: string
}

function EditForm({ studentID, fields, onDone, onCancel }: {
  studentID: string
  fields: BlockField[]
  onDone: () => void
  onCancel: () => void
}) {
  const editable = fields.filter((f) => f.field)
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(editable.map((f) => [f.field!, f.v ?? ''])))

  const save = useMutation({
    mutationFn: () => {
      /* Only what changed. Sending every field would rewrite values nobody
         touched — harmless until two people have the record open, when the
         second save silently restores what the first corrected. */
      const changed: Record<string, string> = {}
      for (const f of editable) {
        const now = draft[f.field!] ?? ''
        if (now !== (f.v ?? '')) changed[f.field!] = now
      }
      if (Object.keys(changed).length === 0) return Promise.resolve({})
      return api.patch(`/api/v1/students/${studentID}/fields`, changed)
    },
    onSuccess: onDone,
  })

  return (
    <div className="space-y-4">
      <FormGrid>
        {editable.filter((f) => !f.multiline).map((f) => (
          <FormField key={f.field} label={f.k} hint={f.hint}>
            <Input
              value={draft[f.field!] ?? ''}
              onChange={(v) => setDraft({ ...draft, [f.field!]: v })}
              placeholder={f.placeholder}
            />
          </FormField>
        ))}
      </FormGrid>
      {editable.filter((f) => f.multiline).map((f) => (
        <FormField key={f.field} label={f.k} hint={f.hint}>
          <Textarea
            rows={2}
            value={draft[f.field!] ?? ''}
            onChange={(v) => setDraft({ ...draft, [f.field!]: v })}
            placeholder={f.placeholder}
          />
        </FormField>
      ))}
      {/* Facts of the record rather than boxes: shown so the form is the whole
          block, greyed so nobody tries to type in them. */}
      {fields.filter((f) => !f.field && f.v).map((f) => (
        <div key={f.k} className="flex justify-between border-t pt-2 text-[13px]">
          <span className="text-muted-foreground">{f.k}</span>
          <span>{f.v}</span>
        </div>
      ))}
      <FormNotice error={save.error} />
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  )
}

/* Whatever else this school records, kept with the block it belongs to.

   Stored as "Contact/Bus stop" in the custom_fields column that has been on
   students since the baseline, so a field appears beside the ones it belongs
   with rather than in a flat list at the foot of the page, and no school needs
   a migration to record what it records. */
function CustomFields({ blockKey, studentID, custom, onChanged }: {
  blockKey: string
  studentID: string
  custom?: Record<string, string>
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [editKey, setEditKey] = useState<string | null>(null)
  const [editVal, setEditVal] = useState('')

  const mine = Object.entries(custom ?? {})
    .filter(([k]) => k.startsWith(blockKey + '/'))
    .map(([k, v]) => [k.slice(blockKey.length + 1), v, k] as const)

  const save = useMutation({
    mutationFn: (next: Record<string, string>) =>
      // Only the keys this block touched: the server merges rather than
      // assigns, so a block knowing nothing of the others cannot wipe them.
      api.post(`/api/v1/students/${studentID}/custom-fields`, { custom_fields: next }),
    onSuccess: () => {
      setAdding(false)
      setName('')
      setValue('')
      setEditKey(null)
      onChanged()
    },
  })

  return (
    <div className="mt-5 border-t pt-4">
      <p className="eyebrow mb-2 text-muted-foreground">
        Anything else this school records
      </p>
      {mine.length > 0 && (
        <dl className="mb-3 divide-y rounded-lg border text-[14px]">
          {mine.map(([label, v, full]) => (
            <div key={full} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="flex flex-1 items-center justify-end gap-2">
                {editKey === full ? (
                  <>
                    <Input className="max-w-[18rem]" value={editVal} onChange={setEditVal} />
                    <Button size="sm" disabled={save.isPending}
                      onClick={() => save.mutate({ [full]: editVal })}>Save</Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => setEditKey(null)}>Cancel</Button>
                  </>
                ) : (
                  <>
                    <span className="text-right">{v || '—'}</span>
                    <Button size="sm" variant="ghost"
                      onClick={() => { setEditKey(full); setEditVal(v) }}>Edit</Button>
                    {/* An empty value removes it: the server drops a key whose
                        value is blank, so there is one way to say "this does
                        not belong here after all". */}
                    <Button size="sm" variant="ghost" disabled={save.isPending}
                      onClick={() => save.mutate({ [full]: '' })}>Remove</Button>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {adding ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-52">
            <FormField label="Field name">
              <Input value={name} onChange={setName} placeholder="Bus stop" />
            </FormField>
          </div>
          <div className="min-w-[10rem] flex-1">
            <FormField label="Value">
              <Input value={value} onChange={setValue} placeholder="Sunshine Park" />
            </FormField>
          </div>
          <Button disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate({ [blockKey + '/' + name.trim()]: value })}>
            {save.isPending ? 'Saving…' : 'Add'}
          </Button>
          <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
          <FormNotice error={save.error} />
        </div>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
          Add a field
        </Button>
      )}
    </div>
  )
}

export function RecordBlock({
  title, description, blockKey, studentID, fields, custom, mayEdit, onChanged,
  children,
}: {
  title: string
  description?: string
  blockKey: string
  studentID: string
  fields: BlockField[]
  custom?: Record<string, string>
  mayEdit: boolean
  onChanged: () => void
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)

  const mine = Object.entries(custom ?? {})
    .filter(([k]) => k.startsWith(blockKey + '/'))
  // On the card, only what is filled. Reading a record, an empty row is a
  // line you have to read to discover it says nothing.
  const filled = fields.filter((f) => f.v)

  /* Portalled to the body and covering the window: rendered inside its card, a
     "full page" view would be bounded by a column a third of the screen wide —
     which is the shape the reader pressed the button to escape. */
  const sheet = open ? createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
        <div className="min-w-0">
          <p className="text-[17px] font-semibold">{title}</p>
          {description && (
            <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
          )}
        </div>
        <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-6">
          {mayEdit ? (
            <EditForm
              studentID={studentID}
              fields={fields}
              onDone={() => { setOpen(false); onChanged() }}
              onCancel={() => setOpen(false)}
            />
          ) : (
            <dl className="divide-y rounded-lg border text-[14px]">
              {fields.map((f) => <Field key={f.k} k={f.k} v={f.v ?? undefined} />)}
            </dl>
          )}
          {mayEdit && (
            <CustomFields
              blockKey={blockKey}
              studentID={studentID}
              custom={custom}
              onChanged={onChanged}
            />
          )}
          {children}
        </div>
      </div>
    </div>,
    document.body,
  ) : null

  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        action={
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            {mayEdit ? 'Expand & edit' : 'Expand'}
          </Button>
        }
      />
      {filled.length === 0 && mine.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-muted-foreground">
          Nothing recorded yet.{mayEdit ? ' Expand to fill it in.' : ''}
        </p>
      ) : (
        <dl className="divide-y text-[14px]">
          {filled.map((f) => <Field key={f.k} k={f.k} v={f.v ?? undefined} />)}
          {mine.map(([k, v]) => (
            <Field key={k} k={k.slice(blockKey.length + 1)} v={v} />
          ))}
        </dl>
      )}
      {children}
      {sheet}
    </Card>
  )
}

/* One block's fields as a full-page form, without the six-tab dialog.

   The record has two editors on purpose. This one opens a single block —
   somebody correcting a blood group should not be handed a dialog of thirty
   inputs across six tabs. The dialog is for working through a whole admission.

   Both save through PATCH and both send only what changed, so opening one
   after the other cannot undo the first.
*/
export interface SheetField {
  k: string
  v?: string | null
  field: string
  kind?: 'date'
  hint?: string
  options?: { value: string; label: string }[]
}

export function FieldSheet({ title, studentID, fields, onClose, onSaved }: {
  title: string
  studentID: string
  fields: SheetField[]
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const valueOf = (f: SheetField) => draft[f.field] ?? f.v ?? ''
  const dirty = fields.some((f) => (draft[f.field] ?? f.v ?? '') !== (f.v ?? ''))

  const save = useMutation({
    mutationFn: () => {
      const changed: Record<string, string> = {}
      for (const f of fields) {
        const now = draft[f.field] ?? f.v ?? ''
        if (now !== (f.v ?? '')) changed[f.field] = now
      }
      if (Object.keys(changed).length === 0) return Promise.resolve({})
      return api.patch(`/api/v1/students/${studentID}/fields`, changed)
    },
    onSuccess: () => { onSaved(); onClose() },
  })

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <p className="text-[17px] font-semibold">{title}</p>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-6">
          {/* EVERY FIELD, filled or not. The card behind shows only what is
              filled, because reading a record an empty row says nothing; here
              the opposite holds — a field you cannot see is one you cannot
              fill, which is most of how they came to be empty. */}
          <FormGrid>
            {fields.map((f) => (
              <FormField key={f.field} label={f.k} hint={f.hint}>
                {f.options ? (
                  <Select
                    value={valueOf(f)}
                    onChange={(v) => setDraft({ ...draft, [f.field]: v })}
                    placeholder="Not recorded"
                    options={f.options}
                  />
                ) : (
                  <Input
                    type={f.kind === 'date' ? 'date' : undefined}
                    value={valueOf(f)}
                    onChange={(v) => setDraft({ ...draft, [f.field]: v })}
                  />
                )}
              </FormField>
            ))}
          </FormGrid>
          <FormNotice error={save.error} />
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button disabled={save.isPending || !dirty} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
