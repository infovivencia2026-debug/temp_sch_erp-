import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChannelEstimate, ChannelPicker, TickChip, TestSendTick, sendTo, DEFAULT_CHANNELS, NOTHING_TICKED, useChannelEstimate, type Channel } from '../communication/ChannelPicker'
import { api } from '@/lib/api'
import { useVisibleInterval } from '@/lib/visible'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Select, Input,
  Field, SkeletonTable, ErrorState, EmptyState, segClass, SEG_BAR, ConfirmButton, FormNotice } from '@/components/ui'

/* Student absentees — the monitoring view.
 *
 * Absentee follow-up (AbsenceFollowup.tsx) is where the office does the work:
 * it rings each absent child's home and writes down the outcome. This screen is
 * the other side of that glass — a read-only, day-wise list of every child
 * marked away across the school (or across the sections the caller may see),
 * showing at a glance whether each has been called, WHO made the call, and what
 * the parent said. There are no controls that change anything; acting on a row
 * stays on Absentee follow-up.
 *
 * It reads the same endpoint the action screen does
 * (/api/v1/attendance/absentees), which is scoped server-side, so a class
 * teacher sees their own sections and a read.all holder sees the whole school —
 * the same rows, laid out as one flat table rather than per-section action
 * cards.
 *
 * LIVE. As a colleague records a call on the follow-up screen, this table
 * refreshes on its own: the query polls while the tab is visible
 * (useVisibleInterval, the same low-end-safe polling every live screen in the
 * product uses — no SSE, no WebSocket) and refetches on window focus. The
 * shared revision poll in lib/live.ts also invalidates it, so a change lands
 * within a tick either way. */

interface Absentee {
  student_id: string
  name: string
  admission_no: string
  call_status: 'not_called' | 'called' | 'no_answer' | 'reached'
  parent_response?: string
  /** The staff member who last recorded this child's follow-up; '' if none. */
  called_by?: string
  /** When that follow-up was recorded; null until somebody acts. */
  called_at?: string | null
}

interface AbsenteeSection {
  section_id: string
  section_name: string
  class_name: string
  students: Absentee[]
}

/** One child marked present that day — the Present tab's row. */
interface Present {
  student_id: string
  name: string
  admission_no: string
  section_id: string
  section_name: string
  class_name: string
}

interface AbsenteesResponse {
  date: string
  sections: AbsenteeSection[]
  present: Present[]
}

/** One absentee, flattened out of its section for the single table. */
interface Row extends Absentee {
  section_id: string
  section_name: string
  class_name: string
}

type Tab = 'present' | 'absent'

/** Today, as YYYY-MM-DD in the browser's own timezone. */
function today(): string {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10)
}

/* Two states on this screen: pending or called. Older rows may carry the
   'no_answer'/'reached' the dropdown used to offer; they count and read as
   "called" here, since the point of this view is "has the family been reached
   yet", not the fine grain of the outcome. */
function isCalled(status: Absentee['call_status']): boolean {
  return status !== 'not_called'
}

/* TELL THE PARENTS FROM HERE (owner, 2026-11-20).

   Once the register is taken, tick children on the Absent or Present tab, choose
   how (In app, Yajur Connect, SMS) and send. Each child's family is told once a
   day: a child already told shows "Told" and is not sent again, whoever pressed
   Send and on whichever channel. Shown only to staff who may mark or notify. */
const NOTIFY_PERMS = ['comms.messages.send', 'academics.attendance.write', 'academics.attendance.write.any']

function useCanNotify(): boolean {
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.call('GET /session') })
  const perms: string[] = (session.data as { permissions?: string[] } | undefined)?.permissions ?? []
  return NOTIFY_PERMS.some((p) => perms.includes(p))
}

function SendToParents({ kind, onDate, picked, total, allIds, onPick, told }: {
  kind: 'absent' | 'present'
  onDate: string
  picked: string[]
  total: number
  allIds: string[]
  onPick: (ids: string[]) => void
  told: Set<string>
}) {
  const qc = useQueryClient()
  const [channels, setChannels] = useState<Channel[]>(DEFAULT_CHANNELS)
  const [test, setTest] = useState(false)
  const [done, setDone] = useState('')
  const sendable = picked.filter((id) => !told.has(id))
  const estimate = useChannelEstimate(['attendance', kind, onDate, sendable.slice().sort().join(',')],
    { message_type: 'absence', kind, student_ids: sendable, channels, test }, sendable.length > 0)
  const send = useMutation({
    mutationFn: () => api.post<{ children: number; already_told: number; messages_queued: number }>(
      '/api/v1/attendance-workflow/parent-messages', { on_date: onDate, kind, student_ids: sendable, channels, test }),
    onSuccess: (r) => {
      setDone(`Told the parents of ${r.children} ${r.children === 1 ? 'child' : 'children'}` + (r.already_told ? ` · ${r.already_told} already told` : '') + '.')
      onPick([])
      qc.invalidateQueries({ queryKey: ['parent-messages', onDate] })
    },
  })
  const fresh = allIds.filter((id) => !told.has(id))
  const parents = estimate.data?.recipients ?? (test ? 0 : sendable.length)
  return (
    <Card className="mb-3">
      <CardHeader
        title={kind === 'absent' ? 'Tell parents their child is absent' : 'Tell parents their child is present'}
        description={`${picked.length} of ${total} ticked`}
        action={
          <TickChip
            on={fresh.length > 0 && fresh.every((id) => picked.includes(id))}
            onChange={(on) => onPick(on ? fresh : [])}
            label={`${kind === 'absent' ? 'Select all absent' : 'Select all present'} (${fresh.length})`}
            disabled={fresh.length === 0}
          />
        }
      />
      <div className="space-y-3 p-4">
        <ChannelPicker value={channels} onChange={setChannels} estimate={(sendable.length || test) && channels.length ? estimate.data : undefined} />
        {channels.length === 0
          ? <p className="text-[13px] text-warning">{NOTHING_TICKED}</p>
          : (sendable.length > 0 || test) && estimate.data && <ChannelEstimate e={estimate.data} />}
        <TestSendTick on={test} onChange={setTest} />
        <FormNotice error={send.error} />
        {done && <p className="text-[13px] text-success">{done}</p>}
        <div className="flex justify-end">
          <ConfirmButton
            variant="primary"
            size="md"
            disabled={(sendable.length === 0 && !test) || channels.length === 0 || send.isPending}
            confirmLabel="Send"
            question={test ? `${sendTo(parents, true)}? Only the test parents on the allowlist get it.` : `${sendTo(parents, false)} of ${sendable.length} ${sendable.length === 1 ? 'child' : 'children'}? Each parent is told once a day.`}
            onConfirm={() => send.mutate()}
          >
            {send.isPending ? 'Sending…' : sendTo(parents, test)}
          </ConfirmButton>
        </div>
      </div>
    </Card>
  )
}

export default function StudentAbsentees({ embedded = false }: { embedded?: boolean } = {}) {
  const [onDate, setOnDate] = useState(today)
  const [sectionId, setSectionId] = useState('')
  // Find one child across the day's list by name or admission number.
  const [nameQ, setNameQ] = useState('')
  // Default to Absent — that is the actionable side of the day.
  const [tab, setTab] = useState<Tab>('absent')
  const canNotify = useCanNotify()
  const [picked, setPicked] = useState<string[]>([])
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p.filter((x) => x !== id), id] : p.filter((x) => x !== id)))
  const toldQ = useQuery({
    queryKey: ['parent-messages', onDate],
    queryFn: () => api.get<{ told_absent: string[]; told_present: string[] }>(`/api/v1/attendance-workflow/parent-messages?on_date=${onDate}`),
    enabled: canNotify,
  })
  const toldAbsent = new Set(toldQ.data?.told_absent ?? [])
  const toldPresent = new Set(toldQ.data?.told_present ?? [])

  const params = new URLSearchParams({ on_date: onDate })
  if (sectionId) params.set('section_id', sectionId)

  const { data, isLoading, error } = useQuery({
    queryKey: ['absentees', onDate, sectionId],
    queryFn: () => api.get<AbsenteesResponse>(`/api/v1/attendance/absentees?${params}`),
    // Poll while the tab is looked at, so a colleague's call appears without a
    // reload; false while hidden so a background tab costs nothing.
    refetchInterval: useVisibleInterval(15_000),
    refetchOnWindowFocus: true,
  })

  /* The section picker is built from the full day. A filtered fetch returns
     only the one section, which would collapse the dropdown to that single
     choice — so the full list is remembered from the last unfiltered load,
     exactly as the action screen does. */
  const [allSections, setAllSections] = useState<{ value: string; label: string }[]>([])
  useEffect(() => {
    if (!sectionId && data) {
      // Draw the section list from BOTH tabs' rows, so a section that had
      // everyone present (no absentees) is still selectable.
      const seen = new Map<string, string>()
      for (const s of data.sections ?? []) seen.set(s.section_id, `${s.class_name} ${s.section_name}`)
      for (const p of data.present ?? []) seen.set(p.section_id, `${p.class_name} ${p.section_name}`)
      setAllSections(
        [...seen.entries()]
          .map(([value, label]) => ({ value, label }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      )
    }
  }, [data, sectionId])

  const sections = data?.sections ?? []
  const allRows: Row[] = sections.flatMap((s) =>
    s.students.map((st) => ({
      ...st,
      section_id: s.section_id,
      section_name: s.section_name,
      class_name: s.class_name,
    })),
  )

  const allPresent = data?.present ?? []

  const nq = nameQ.trim().toLowerCase()
  const matchName = (name: string, adm: string) =>
    !nq || name.toLowerCase().includes(nq) || adm.toLowerCase().includes(nq)

  const rows = allRows.filter((r) => matchName(r.name, r.admission_no))
  const presentRows = allPresent.filter((p) => matchName(p.name, p.admission_no))

  const total = allRows.length
  const pending = allRows.filter((r) => !isCalled(r.call_status)).length
  const called = total - pending
  const presentTotal = allPresent.length

  const empty = tab === 'present' ? presentTotal === 0 : total === 0

  /* The date / section / search controls, kept together so the hub can show
     them at the top of the tab body while the standalone screen keeps them in
     the PageHead. Either way they are the same controls. */
  const controls = (
    <>
      <Field label="Date">
        <Input type="date" value={onDate} onChange={setOnDate} />
      </Field>
      <Field label="Section">
        <Select
          value={sectionId}
          onChange={setSectionId}
          placeholder={isLoading ? "Loading…" : "All sections"}
          options={allSections}
        />
      </Field>
      <Field label="Search">
        <Input value={nameQ} onChange={setNameQ} placeholder="Name or admission no." />
      </Field>
    </>
  )

  const content = (
    <>
        {/* Two views of the same day, sharing the date / section / search above.
            Plain buttons styled as a segmented control — no new dependency, and
            it renders on the oldest browser we support. */}
        <div
          role="tablist"
          aria-label="Present or absent"
          className={cn(SEG_BAR, 'mx-auto mb-3')}
        >
          {(['absent', 'present'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => { setTab(t); setPicked([]) }}
              className={
                tab === t
                  ? segClass(true)
                  : segClass(false)
              }
            >
              {t === 'absent' ? `Absent (${total})` : `Present (${presentTotal})`}
            </button>
          ))}
        </div>

        {isLoading ? (
          <SkeletonTable columns={tab === 'present' ? 4 : 7} />
        ) : error ? (
          <ErrorState error={error} />
        ) : empty ? (
          tab === 'present' ? (
            <EmptyState
              title="Nobody marked present for this day."
              body="Once the register is taken, every child marked present appears here."
            />
          ) : (
            <EmptyState
              title="Nobody is marked absent for this day."
              body="Once attendance is taken and a child is marked away, they appear here so the follow-up can be watched."
            />
          )
        ) : tab === 'present' ? (
          <>
          {canNotify && (
            <SendToParents kind="present" onDate={onDate} picked={picked} total={presentRows.length}
              allIds={presentRows.map((p) => p.student_id)} onPick={setPicked} told={toldPresent} />
          )}
          <Card>
            <CardHeader title="Present" description={`${presentTotal} present`} />
            <Table
              head={[...(canNotify ? ['Send'] : []), 'Student', 'Admission No', 'Class', 'Section']}
              empty={presentRows.length === 0}
              emptyLabel={nq ? `No present child matches “${nameQ}” on this day.` : 'Nobody marked present for this day.'}
            >
              {presentRows.map((p) => (
                <tr key={p.student_id}>
                  {canNotify && (
                    <Td>
                      {toldPresent.has(p.student_id)
                        ? <Badge tone="success">Told</Badge>
                        : <TickChip on={picked.includes(p.student_id)} onChange={(on) => toggle(p.student_id, on)} srLabel={`Tell the parents of ${p.name}`} />}
                    </Td>
                  )}
                  <Td className="font-medium">{p.name}</Td>
                  <Td className="font-mono text-[12px] text-muted-foreground">{p.admission_no}</Td>
                  <Td>{p.class_name}</Td>
                  <Td>{p.section_name}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          </>
        ) : (
          <>
          {canNotify && (
            <SendToParents kind="absent" onDate={onDate} picked={picked} total={rows.length}
              allIds={rows.map((r) => r.student_id)} onPick={setPicked} told={toldAbsent} />
          )}
          <Card>
            <CardHeader
              title="Absentees"
              description={`${total} absent · ${pending} pending · ${called} called`}
            />
            <Table
              head={[...(canNotify ? ['Send'] : []), 'Student', 'Admission No', 'Class', 'Section', 'Status', 'Called by', 'Parent response']}
              empty={rows.length === 0}
              emptyLabel={nq ? `No absentee matches “${nameQ}” on this day.` : 'Nobody is marked absent for this day.'}
            >
              {rows.map((r) => {
                const done = isCalled(r.call_status)
                return (
                  <tr key={r.student_id}>
                    {canNotify && (
                      <Td>
                        {toldAbsent.has(r.student_id)
                          ? <Badge tone="success">Told</Badge>
                          : <TickChip on={picked.includes(r.student_id)} onChange={(on) => toggle(r.student_id, on)} srLabel={`Tell the parents of ${r.name}`} />}
                      </Td>
                    )}
                    <Td className="font-medium">{r.name}</Td>
                    <Td className="font-mono text-[12px] text-muted-foreground">{r.admission_no}</Td>
                    <Td>{r.class_name}</Td>
                    <Td>{r.section_name}</Td>
                    <Td>
                      <Badge tone={done ? 'success' : 'danger'}>
                        {done ? 'Called' : 'Pending'}
                      </Badge>
                    </Td>
                    <Td className="text-muted-foreground">{r.called_by || ''}</Td>
                    <Td className="text-muted-foreground">{r.parent_response || ''}</Td>
                  </tr>
                )
              })}
            </Table>
          </Card>
          </>
        )}
    </>
  )

  return (
    <>
      {/* Embedded in the Attendance hub, this screen drops its own PageHead —
          the hub carries the one title (and its own PageBody) — but keeps its
          controls, shown as a row above the body instead. */}
      {embedded ? (
        <>
          {/* Full-width stacked on a phone so Date / Section / Search each get a
              whole line and a comfortable field; the desktop row (sm+) is the
              flex-wrap it always was. */}
          <div className="mb-3 grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end">{controls}</div>
          {content}
        </>
      ) : (
        <>
          <PageHead
            eyebrow="Attendance"
            title="Present & absent"
            description="Who came in and who is away today, and where the call home stands, updates live as the office records each call."
            actions={controls}
          />
          <PageBody>{content}</PageBody>
        </>
      )}
    </>
  )
}
