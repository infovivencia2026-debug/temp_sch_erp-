import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Card, CardHeader, Field as FormField, FormNotice, Button, Input,
} from '@/components/ui'
import { Field } from '@/components/RecordShell'

/* A block of the record that OPENS OUT, and takes fields the school invented.

   It folded shut first, and that was the wrong verb. Hiding a block helps
   nobody: the reason somebody presses a button on "Contact and address" is
   that they want more of it, not less. Expanding gives the block the whole
   window, every field editable in place and room to add another — which is
   what the person was there to do.

   THE NAME CARRIES THE BLOCK. A field a school invents is stored as
   "Contact/Bus stop" and shown as "Bus stop" under Contact. One column, no
   migration per school, and a new field appears beside the ones it belongs
   with instead of in a flat list at the foot of the page.

   EDITING LIVES IN THE EXPANDED VIEW ONLY. The card is for reading — a row of
   Edit and Remove buttons against every line is noise on a page somebody is
   scanning with a parent on the telephone.
*/

interface BlockField {
  k: string
  v?: string | null
}

function BlockFields({
  blockKey, studentID, fields, custom, mayEdit, onChanged, expanded,
}: {
  blockKey: string
  studentID: string
  fields: BlockField[]
  custom?: Record<string, string>
  mayEdit: boolean
  onChanged: () => void
  expanded: boolean
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
      /* Only the keys this block touched. The server merges rather than
         assigns, so a block that knows nothing of the others cannot wipe
         them — which is the whole reason the endpoint merges. */
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
    <>
      {mayEdit && expanded && (adding ? (
        <div className="flex flex-wrap items-end gap-2 border-b bg-muted/20 p-4">
          <div className="w-56">
            <FormField label="Field name">
              <Input value={name} onChange={setName} placeholder="Bus stop" />
            </FormField>
          </div>
          <div className="min-w-[12rem] flex-1">
            <FormField label="Value">
              <Input value={value} onChange={setValue} placeholder="Sunshine Park" />
            </FormField>
          </div>
          <Button
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate({ [blockKey + '/' + name.trim()]: value })}
          >
            {save.isPending ? 'Saving…' : 'Add'}
          </Button>
          <Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
          <FormNotice error={save.error} />
        </div>
      ) : (
        <div className="border-b px-5 py-2.5">
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Add a field
          </Button>
        </div>
      ))}

      <dl className="divide-y text-[14px]">
        {fields.map((f) => <Field key={f.k} k={f.k} v={f.v ?? undefined} />)}
        {mine.map(([label, v, full]) => (
          <div key={full} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="flex flex-1 items-center justify-end gap-2">
              {editKey === full ? (
                <>
                  <Input className="max-w-[18rem]" value={editVal} onChange={setEditVal} />
                  <Button size="sm" disabled={save.isPending}
                    onClick={() => save.mutate({ [full]: editVal })}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditKey(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-right">{v || '—'}</span>
                  {mayEdit && expanded && (
                    <>
                      <Button size="sm" variant="ghost"
                        onClick={() => { setEditKey(full); setEditVal(v) }}>
                        Edit
                      </Button>
                      {/* An empty value removes it. The server drops a key
                          whose value is blank, so there is one way to say
                          "this does not belong here after all" rather than a
                          second endpoint that can be got wrong separately. */}
                      <Button size="sm" variant="ghost" disabled={save.isPending}
                        onClick={() => save.mutate({ [full]: '' })}>
                        Remove
                      </Button>
                    </>
                  )}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </>
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
  const [full, setFull] = useState(false)

  /* Portalled to the body, covering the window.

     Rendered inside the card it belongs to, a "full page" view would be
     bounded by a column a third of the screen wide — which is the shape the
     reader pressed the button to escape. */
  const sheet = full ? createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
        <div className="min-w-0">
          <p className="text-[17px] font-semibold">{title}</p>
          {description && (
            <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
          )}
        </div>
        <Button variant="secondary" onClick={() => setFull(false)}>Close</Button>
      </div>
      {/* Scrolls, because a school with twenty invented fields is ordinary and
          a sheet that runs off the bottom is worse than the card was. */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl py-4">
          <BlockFields
            blockKey={blockKey}
            studentID={studentID}
            fields={fields}
            custom={custom}
            mayEdit={mayEdit}
            onChanged={onChanged}
            expanded
          />
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
          <Button size="sm" variant="secondary" onClick={() => setFull(true)}>
            Expand
          </Button>
        }
      />
      <BlockFields
        blockKey={blockKey}
        studentID={studentID}
        fields={fields}
        custom={custom}
        mayEdit={mayEdit}
        onChanged={onChanged}
        expanded={false}
      />
      {children}
      {sheet}
    </Card>
  )
}
