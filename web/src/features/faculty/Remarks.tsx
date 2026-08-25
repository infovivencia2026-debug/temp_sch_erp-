import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeOff, Lock, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Checkbox, Field, FormGrid, FormNotice, Select,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { formatDate } from '@/lib/utils'
import {
  REMARK_KINDS, useMyClasses, useRoster, today,
  type Remark,
} from './comms'

/* What a teacher writes about a child.

   Two screens share this board because they are one record with one flag
   between them. A remark is ordinarily shown to the family; an anecdotal
   record never is, and the server enforces that rather than trusting the
   checkbox — so the difference visible here is a heading and a default, not a
   second set of rules the two screens could drift apart on. */

export default function Remarks() {
  return (
    <RemarkBoard
      anecdotal={false}
      eyebrow="Teaching workspace"
      title="Remarks"
      description="Academic and class observations about the children you teach. Shared with the parent unless you mark a remark staff-only."
    />
  )
}

export function RemarkBoard({
  anecdotal,
  eyebrow,
  title,
  description,
}: {
  /** Anecdotal records are private to staff and cannot be published. */
  anecdotal: boolean
  eyebrow: string
  title: string
  description: string
}) {
  const [composing, setComposing] = useState(false)
  const query = anecdotal ? '?kind=anecdotal' : ''

  const list = useQuery({
    queryKey: ['remarks', anecdotal],
    queryFn: () => api.get<List<Remark>>(`/api/v1/teaching/remarks${query}`),
  })

  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />

  // The general board deliberately shows anecdotal rows too. A teacher reading
  // a child's year wants the whole of it in date order, and a note they have to
  // remember to look for on another screen is a note nobody reads.
  const rows = list.data?.items ?? []
  const shown = anecdotal ? rows.filter((r) => r.kind === 'anecdotal') : rows
  const children = new Set(shown.map((r) => r.student_id)).size

  return (
    <>
      <PageHead
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={
          <Button onClick={() => setComposing((c) => !c)}>
            <Plus className="h-3.5 w-3.5" />
            {composing ? 'Close' : anecdotal ? 'Add a note' : 'Write a remark'}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label={anecdotal ? 'Notes' : 'Remarks'} value={shown.length} />
          <Stat label="Children written about" value={children} />
          <Stat
            label="Staff only"
            value={shown.filter((r) => r.private).length}
            icon={Lock}
            hint="Never shown in the parent portal"
          />
        </CellGrid>

        {composing && (
          <Compose anecdotal={anecdotal} onClose={() => setComposing(false)} />
        )}

        <Card>
          <CardHeader title="Written so far" description="Most recent first" />
          {shown.length === 0 ? (
            <EmptyState
              title={anecdotal ? 'No notes yet' : 'Nothing written yet'}
              body={
                anecdotal
                  ? 'Anecdotal records stay with the staff who teach this child. They are never shown to the parent.'
                  : 'Remarks you write appear here, and in the parent portal unless you mark them staff-only.'
              }
            />
          ) : (
            <ul className="divide-y">
              {shown.map((r) => (
                <li key={r.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium">{r.student_name}</span>
                    <span className="text-[13px] text-muted-foreground">{r.admission_no}</span>
                    {r.class_name && (
                      <Badge>
                        {r.class_name}
                        {r.section_name && `-${r.section_name}`}
                      </Badge>
                    )}
                    <Badge tone={r.kind === 'concern' ? 'warning' : 'neutral'}>{r.kind}</Badge>
                    {r.private && (
                      <Badge tone="danger">
                        <EyeOff className="mr-1 h-3 w-3" />
                        staff only
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1.5 text-[14px]">{r.body}</p>
                  <p className="mt-1.5 text-[13px] text-muted-foreground">
                    {formatDate(r.observed_on)}
                    {r.subject && ` · ${r.subject}`}
                    {r.recorded_by && ` · ${r.mine ? 'you' : r.recorded_by}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function Compose({ anecdotal, onClose }: { anecdotal: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const classes = useMyClasses()
  const [sectionID, setSectionID] = useState('')
  const roster = useRoster(sectionID)

  const [f, setF] = useState({
    student_id: '',
    kind: anecdotal ? 'anecdotal' : 'academic',
    body: '',
    observed_on: today(),
    // Only meaningful on the general board. An anecdotal record is private by
    // definition and the server refuses to store it any other way.
    staffOnly: anecdotal,
  })

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/teaching/remarks', {
        student_id: f.student_id,
        kind: f.kind,
        body: f.body,
        observed_on: f.observed_on,
        private: f.staffOnly,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['remarks'] })
      qc.invalidateQueries({ queryKey: ['comms-summary'] })
      toast.ok(f.staffOnly ? 'Note filed — staff only' : 'Remark saved and shared with the parent')
      onClose()
    },
  })

  return (
    <Card>
      <CardHeader
        title={anecdotal ? 'New anecdotal record' : 'New remark'}
        description={
          anecdotal
            ? 'Kept for the staff who teach this child. Never shown to the parent.'
            : 'Say what you saw. A remark with an example in it is the one a parent can act on.'
        }
      />
      <form
        className="px-5 py-5"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <FormGrid>
          <Field label="Class" required>
            <Select
              value={sectionID}
              onChange={(v) => {
                setSectionID(v)
                setF({ ...f, student_id: '' })
              }}
              placeholder="Choose a class you teach"
              options={(classes.data?.items ?? []).map((c) => ({
                value: c.section_id,
                label: `${c.class_name}-${c.section_name}`,
              }))}
            />
          </Field>
          <Field label="Child" required>
            <Select
              value={f.student_id}
              onChange={(v) => setF({ ...f, student_id: v })}
              placeholder={sectionID ? 'Choose a child' : 'Choose a class first'}
              options={(roster.data?.items ?? []).map((s) => ({
                value: s.id,
                label: `${s.full_name} — ${s.admission_no}`,
              }))}
            />
          </Field>
          {!anecdotal && (
            <Field label="Kind">
              <Select
                value={f.kind}
                onChange={(v) => setF({ ...f, kind: v })}
                options={REMARK_KINDS.map((k) => ({ value: k.value, label: k.label }))}
              />
            </Field>
          )}
          <Field label="Observed on">
            <input
              type="date"
              value={f.observed_on}
              onChange={(e) => setF({ ...f, observed_on: e.target.value })}
              className="field"
            />
          </Field>
          <Field label="What you saw" required wide>
            <textarea
              value={f.body}
              onChange={(e) => setF({ ...f, body: e.target.value })}
              rows={4}
              placeholder={
                anecdotal
                  ? 'Quieter than usual since half term. Sat alone at lunch on Tuesday and Thursday.'
                  : 'Explained her method to the class without being asked. Third time this month.'
              }
              className="field h-auto w-full py-2"
            />
          </Field>
        </FormGrid>

        {!anecdotal && (
          <div className="mt-4">
            <Checkbox
              checked={f.staffOnly}
              onChange={(v) => setF({ ...f, staffOnly: v })}
              label="Staff only"
              hint="Keep this out of the parent portal. Use it for something the parent should hear from you first."
            />
          </div>
        )}

        <FormNotice error={save.error} />
        <div className="mt-4 flex items-center gap-2">
          <Button type="submit" disabled={save.isPending || !f.student_id || !f.body.trim()}>
            {save.isPending ? 'Saving…' : anecdotal ? 'File the note' : 'Save remark'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
