import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlarmClock, Check, Plus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Field, FormGrid, FormNotice, Select,
  SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { formatDate } from '@/lib/utils'
import {
  ATTENDANCE_OPTIONS, MODE_OPTIONS, useMyClasses, useRoster, today,
  type PTMNote,
} from './comms'

/* What was said at the meeting, and what was promised.

   The half of a parent-teacher meeting that survives is the half somebody
   wrote down. Two boxes, kept apart on purpose: what the parent raised is
   theirs and should not be summarised away, and what the school undertook to
   do is the part that can be chased in September.

   A meeting nobody attended still gets a note. That is the record a school
   needs when it later has to show it tried. */

export default function PTMNotes() {
  const [composing, setComposing] = useState(false)
  const [pendingOnly, setPendingOnly] = useState(false)

  const list = useQuery({
    queryKey: ['ptm-notes', pendingOnly],
    queryFn: () =>
      api.get<List<PTMNote>>(`/api/v1/teaching/ptm-notes${pendingOnly ? '?pending=1' : ''}`),
  })

  if (list.isLoading) return <SkeletonTiles count={3} />
  if (list.error) return <ErrorState error={list.error} />
  const rows = list.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Teaching workspace"
        title="PTM notes & action items"
        description="Who came, what they raised, and what was agreed. Actions carry a date so nobody has to remember them."
        actions={
          <>
            <Button variant="secondary" onClick={() => setPendingOnly((p) => !p)}>
              {pendingOnly ? 'Show all meetings' : 'Only open actions'}
            </Button>
            <Button onClick={() => setComposing((c) => !c)}>
              <Plus className="h-3.5 w-3.5" />
              {composing ? 'Close' : 'Record a meeting'}
            </Button>
          </>
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Meetings recorded" value={rows.length} />
          <Stat
            label="Actions still open"
            value={rows.filter((r) => !r.follow_up_done && r.follow_up_on).length}
            icon={AlarmClock}
          />
          <Stat
            label="Overdue"
            value={rows.filter((r) => r.overdue).length}
            delta={{
              value: rows.some((r) => r.overdue) ? 'Chase these' : 'Nothing overdue',
              positive: !rows.some((r) => r.overdue),
            }}
          />
        </CellGrid>

        {composing && <Compose onClose={() => setComposing(false)} />}

        <Card>
          <CardHeader title="Meetings" description="Most recent first" />
          {rows.length === 0 ? (
            <EmptyState
              title="No meetings recorded"
              body="Record what a parent raised and what was agreed, and the follow-up will find its way back to you."
            />
          ) : (
            <ul className="divide-y">
              {rows.map((n) => (
                <Row key={n.id} note={n} />
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function Row({ note }: { note: PTMNote }) {
  const qc = useQueryClient()
  const toast = useToast()

  const close = useMutation({
    mutationFn: () =>
      api.post('/api/v1/teaching/ptm-notes', {
        student_id: note.student_id,
        met_on: note.met_on,
        attendance: note.attendance,
        attended_by: note.attended_by ?? '',
        mode: note.mode,
        concerns: note.concerns ?? '',
        agreed_actions: note.agreed_actions ?? '',
        follow_up_on: note.follow_up_on ?? '',
        follow_up_done: true,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ptm-notes'] })
      qc.invalidateQueries({ queryKey: ['comms-summary'] })
      toast.ok(`Action closed for ${note.student_name}`)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not close'),
  })

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium">{note.student_name}</span>
        <span className="text-[13px] text-muted-foreground">{note.admission_no}</span>
        {note.class_name && (
          <Badge>
            {note.class_name}
            {note.section_name && `-${note.section_name}`}
          </Badge>
        )}
        <Badge tone={note.attendance === 'none' ? 'warning' : 'neutral'}>
          {ATTENDANCE_OPTIONS.find((a) => a.value === note.attendance)?.label ?? note.attendance}
        </Badge>
        {note.overdue && <Badge tone="danger">action overdue</Badge>}
      </div>

      {note.concerns && (
        <p className="mt-1.5 text-[14px]">
          <span className="text-muted-foreground">Raised: </span>
          {note.concerns}
        </p>
      )}
      {note.agreed_actions && (
        <p className="mt-0.5 text-[14px]">
          <span className="text-muted-foreground">Agreed: </span>
          {note.agreed_actions}
        </p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
        <span>{formatDate(note.met_on)}</span>
        <span>{MODE_OPTIONS.find((m) => m.value === note.mode)?.label ?? note.mode}</span>
        {note.attended_by && <span>seen by {note.attended_by}</span>}
        {note.follow_up_on && (
          <span className={note.overdue ? 'text-destructive' : undefined}>
            follow up {formatDate(note.follow_up_on)}
          </span>
        )}
        {note.recorded_by && <span>{note.mine ? 'you' : note.recorded_by}</span>}
      </div>

      {note.follow_up_on && !note.follow_up_done && note.mine && (
        <div className="mt-2">
          <Button size="sm" variant="secondary" disabled={close.isPending} onClick={() => close.mutate()}>
            <Check className="h-3.5 w-3.5" />
            {close.isPending ? 'Closing…' : 'Mark done'}
          </Button>
        </div>
      )}
    </li>
  )
}

function Compose({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const classes = useMyClasses()
  const [sectionID, setSectionID] = useState('')
  const roster = useRoster(sectionID)

  const [f, setF] = useState({
    student_id: '',
    met_on: today(),
    attendance: 'guardian',
    attended_by: '',
    mode: 'in_person',
    concerns: '',
    agreed_actions: '',
    follow_up_on: '',
  })

  const save = useMutation({
    mutationFn: () => api.post('/api/v1/teaching/ptm-notes', f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ptm-notes'] })
      qc.invalidateQueries({ queryKey: ['comms-summary'] })
      toast.ok('Meeting recorded')
      onClose()
    },
  })

  const nobodyCame = f.attendance === 'none'

  return (
    <Card>
      <CardHeader
        title="Record a meeting"
        description="Saving again for the same child on the same day corrects the note rather than adding a second one."
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
          <Field label="Met on">
            <input
              type="date"
              value={f.met_on}
              onChange={(e) => setF({ ...f, met_on: e.target.value })}
              className="field"
            />
          </Field>
          <Field label="Who came" required>
            <Select
              value={f.attendance}
              onChange={(v) => setF({ ...f, attendance: v })}
              options={ATTENDANCE_OPTIONS.map((a) => ({ value: a.value, label: a.label }))}
            />
          </Field>
          <Field label="Name given at the desk" hint="Guardian records go out of date; write who actually sat down.">
            <input
              value={f.attended_by}
              onChange={(e) => setF({ ...f, attended_by: e.target.value })}
              placeholder="Mrs Sunitha Rao"
              className="field"
            />
          </Field>
          <Field label="How">
            <Select
              value={f.mode}
              onChange={(v) => setF({ ...f, mode: v })}
              options={MODE_OPTIONS.map((m) => ({ value: m.value, label: m.label }))}
            />
          </Field>
          <Field label="What the parent raised" wide>
            <textarea
              value={f.concerns}
              onChange={(e) => setF({ ...f, concerns: e.target.value })}
              rows={3}
              placeholder="Worried about the drop in maths since the move to the afternoon slot."
              className="field h-auto w-full py-2"
            />
          </Field>
          <Field label="What was agreed" wide>
            <textarea
              value={f.agreed_actions}
              onChange={(e) => setF({ ...f, agreed_actions: e.target.value })}
              rows={3}
              placeholder="Extra practice sheet each Friday; review together at the next meeting."
              className="field h-auto w-full py-2"
            />
          </Field>
          <Field label="Follow up by" hint="Leave blank if nothing was promised.">
            <input
              type="date"
              value={f.follow_up_on}
              onChange={(e) => setF({ ...f, follow_up_on: e.target.value })}
              className="field"
            />
          </Field>
        </FormGrid>

        <FormNotice error={save.error} />
        <div className="mt-4 flex items-center gap-2">
          <Button
            type="submit"
            disabled={
              save.isPending ||
              !f.student_id ||
              (!nobodyCame && !f.concerns.trim() && !f.agreed_actions.trim())
            }
          >
            {save.isPending ? 'Saving…' : 'Save the note'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
