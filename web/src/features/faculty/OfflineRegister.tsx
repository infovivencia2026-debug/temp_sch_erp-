import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CloudOff, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState, Panel,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import {
  ATTENDANCE_STATUSES, DIARY_KINDS, labelOf, todayISO, useClassroomSections,
  type CaptureConflict, type DiaryEntry,
} from './classroom'
import { useOfflineRegisterQueue } from './offline-queue'

/* Taking the register where there is no signal.

   Be clear about what this does, because the feature name promises more than
   any of it can deliver on its own.

   IT DOES: keep a register and a diary taken in this tab when the request
   fails, replay them when the connection returns, and never lose them to a
   reload — the queue is in localStorage. Each flush carries a batch reference,
   so a retry after a dropped response is safe rather than a second register.
   And when the office has already marked a child in the meantime, the sync
   refuses to overwrite them: it reports the disagreement, with both values and
   who entered the other one, and a person decides.

   IT DOES NOT: work from a cold start with no network. There is no service
   worker in this project, so the page itself still has to load from the
   server. A teacher who opens this screen before they leave and keeps the tab
   open is covered; one who closes it in the car park is not. Making that work
   is a service worker and a precached shell, and neither is built.

   The refusal to overwrite is the part that matters most. A device out of
   signal since nine o'clock has less information than the office did at
   eleven, and last-write-wins would let it silently erase a leave the parent
   phoned in. */

export default function OfflineRegister() {
  const toast = useToast()
  const qc = useQueryClient()
  const sections = useClassroomSections()
  const queue = useOfflineRegisterQueue()

  const [sectionID, setSectionID] = useState('')
  const [onDate, setOnDate] = useState(todayISO())
  const [deviceNote, setDeviceNote] = useState('')
  const [marks, setMarks] = useState<Record<string, string>>({})
  const [diaryKind, setDiaryKind] = useState('note')
  const [diaryBody, setDiaryBody] = useState('')

  const roster = useQuery({
    enabled: !!sectionID,
    queryKey: ['classroom-roster', sectionID],
    queryFn: () =>
      api.get<List<{ student_id: string; admission_no: string; full_name: string; section: string }>>(
        '/api/v1/teaching/progress',
      ),
  })

  const conflicts = useQuery({
    queryKey: ['classroom-capture-conflicts'],
    queryFn: () =>
      api.get<List<CaptureConflict>>('/api/v1/classroom/attendance/conflicts'),
  })

  const diary = useQuery({
    queryKey: ['classroom-diary', sectionID],
    queryFn: () =>
      api.get<List<DiaryEntry>>(
        `/api/v1/classroom/diary${sectionID ? `?section_id=${sectionID}` : ''}`,
      ),
  })

  const resolve = useMutation({
    mutationFn: (v: { id: string; resolution: 'kept' | 'applied' }) =>
      api.post(`/api/v1/classroom/attendance/conflicts/${v.id}/resolve`, {
        resolution: v.resolution,
      }),
    onSuccess: () => {
      toast.ok('Resolved')
      qc.invalidateQueries({ queryKey: ['classroom-capture-conflicts'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not resolve'),
  })

  const section = (sections.data?.items ?? []).find((s) => s.section_id === sectionID)
  const children = (roster.data?.items ?? []).filter((c) => !section || c.section === section.section_name)

  const queueIt = () => {
    const rows = Object.entries(marks).map(([student_id, status]) => ({ student_id, status }))
    if (rows.length === 0 && !diaryBody) {
      toast.error('Nothing to save yet')
      return
    }
    queue.enqueue({
      section_id: sectionID,
      section_name: section ? `${section.class_name} · ${section.section_name}` : '',
      on_date: onDate,
      device_note: deviceNote || undefined,
      marks: rows,
      diary: diaryBody ? [{ kind: diaryKind, body: diaryBody }] : [],
    })
    setMarks({})
    setDiaryBody('')
    toast.ok(queue.online ? 'Queued — syncing now' : 'Held on this device until you are back online')
    void queue.flush()
    qc.invalidateQueries({ queryKey: ['classroom-capture-conflicts'] })
    qc.invalidateQueries({ queryKey: ['classroom-diary'] })
  }

  if (sections.isLoading) return <Loading />
  if (sections.error) return <ErrorState error={sections.error} />

  const openConflicts = conflicts.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Attendance"
        title="Offline attendance & diary capture"
        description="Take the register with no signal; it syncs when the connection returns."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Connection"
            value={queue.online ? 'Online' : 'Offline'}
            icon={queue.online ? RefreshCw : WifiOff}
          />
          <Stat label="Waiting to sync" value={queue.pending.length} icon={CloudOff} />
          <Stat label="Unresolved conflicts" value={openConflicts.length} icon={TriangleAlert} />
          <Stat label="Diary lines" value={diary.data?.items.length ?? 0} />
        </CellGrid>

        <Panel className="p-5 text-[13px] text-muted-foreground">
          What this screen guarantees: a register taken in this tab is never lost to a
          failed request, and a sync never overwrites a mark somebody else entered while
          you were out of signal — it reports the disagreement instead. What it does not
          do: load itself with no network. Keep this tab open before you leave.
        </Panel>

        <Card>
          <CardHeader title="Take the register" />
          <div className="p-5 space-y-5">
            <FormGrid>
              <Field label="Section">
                <Select
                  value={sectionID}
                  onChange={setSectionID}
                  placeholder="Choose a section…"
                  options={(sections.data?.items ?? []).map((s) => ({
                    value: s.section_id,
                    label: `${s.class_name} · ${s.section_name}`,
                  }))}
                />
              </Field>
              <Field label="Date">
                <Input value={onDate} onChange={setOnDate} type="date" />
              </Field>
              <Field label="Where" hint="Recorded with the batch: 'Field trip — Golconda'." wide>
                <Input value={deviceNote} onChange={setDeviceNote} />
              </Field>
            </FormGrid>
          </div>
          {/* A roll of sixty with a dropdown on every row runs past the end of
              the screen, and the button that saves the whole thing sits under
              it. The table pages at ten, and this keeps even those ten from
              pushing Save out of reach on a phone. */}
          <div className="max-h-[30rem] overflow-y-auto">
          <Table
            head={['Adm no', 'Child', 'Mark']}
            empty={!sectionID || children.length === 0}
            emptyLabel={sectionID ? 'No children on this roll.' : 'Choose a section.'}
          >
            {children.map((c) => (
              <tr key={c.student_id}>
                <Td>{c.admission_no}</Td>
                <Td>{c.full_name}</Td>
                <Td>
                  <Select
                    value={marks[c.student_id] ?? ''}
                    onChange={(v) => setMarks((m) => ({ ...m, [c.student_id]: v }))}
                    placeholder="—"
                    options={ATTENDANCE_STATUSES.map((s) => ({ ...s }))}
                  />
                </Td>
              </tr>
            ))}
          </Table>
          </div>
          <div className="p-5 space-y-5">
            <FormGrid>
              <Field label="Diary kind">
                <Select
                  value={diaryKind}
                  onChange={setDiaryKind}
                  options={DIARY_KINDS.map((k) => ({ ...k }))}
                />
              </Field>
              <Field label="Diary line" wide>
                <Textarea value={diaryBody} onChange={setDiaryBody} rows={2} />
              </Field>
            </FormGrid>
            <Button onClick={queueIt} disabled={!sectionID}>
              {queue.online ? 'Save and sync' : 'Hold on this device'}
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="The queue"
            description="Batches taken on this device, and what the server did with them."
            action={
              <Button
                variant="ghost"
                onClick={() => void queue.flush()}
                disabled={queue.syncing || queue.pending.length === 0}
              >
                Sync now
              </Button>
            }
          />
          <Table
            head={['Section', 'Date', 'Taken at', 'Marks', 'State']}
            empty={queue.queue.length === 0}
            emptyLabel="Nothing has been queued on this device."
          >
            {queue.queue.map((b) => (
              <tr key={b.client_batch_ref}>
                <Td>{b.section_name || '—'}</Td>
                <Td>{b.on_date}</Td>
                <Td>{new Date(b.captured_at).toLocaleString()}</Td>
                <Td>{b.marks.length}</Td>
                <Td>
                  {b.error ? (
                    <Badge tone="danger">{b.error}</Badge>
                  ) : b.synced_at ? (
                    <Badge tone="success">
                      Synced · {b.accepted ?? 0} accepted
                      {b.conflicted ? `, ${b.conflicted} in conflict` : ''}
                    </Badge>
                  ) : (
                    <Badge tone="warning">Waiting</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          {queue.queue.some((b) => b.synced_at) && (
            <div className="p-5">
              <Button variant="ghost" onClick={queue.clearSynced}>
                Clear synced batches
              </Button>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Conflicts"
          />
          {/* Said where it shows.

              Card descriptions are no longer drawn, and "Conflicts" is not a
              word a teacher can work out from the column headings — it is the
              one card on this screen whose title explains nothing on its own.
              An empty table under a word nobody understands reads as a broken
              screen rather than as good news. */}
          <p className="border-b px-5 py-3 text-[13px] text-muted-foreground">
            When you mark a register with no signal and somebody marks the same child
            on the server before your device syncs, both answers exist and only one
            can stand. The server&rsquo;s is kept and yours is listed here to accept or
            discard &mdash; nothing you took offline is thrown away silently.
          </p>
          <FormNotice error={resolve.error} />
          <Table
            head={['Date', 'Child', 'On the device', 'On the server', 'Entered by', '']}
            empty={openConflicts.length === 0}
            emptyLabel="Nothing in dispute — every mark you took offline was accepted."
          >
            {openConflicts.map((c) => (
              <tr key={c.id}>
                <Td>{c.on_date}</Td>
                <Td>
                  {c.student_name}
                  <span className="block text-[12px] text-muted-foreground">
                    {c.admission_no}
                  </span>
                </Td>
                <Td>{labelOf(ATTENDANCE_STATUSES, c.offline_status)}</Td>
                <Td>{labelOf(ATTENDANCE_STATUSES, c.server_status)}</Td>
                <Td>{c.server_marked_by ?? '—'}</Td>
                <Td>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => resolve.mutate({ id: c.id, resolution: 'kept' })}
                    >
                      Keep theirs
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => resolve.mutate({ id: c.id, resolution: 'applied' })}
                    >
                      Use mine
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader title="The diary" description="Written here or synced from a device." />
          <Table
            head={['Date', 'Section', 'Kind', 'Line', 'Source']}
            empty={(diary.data?.items.length ?? 0) === 0}
            emptyLabel="Nothing written yet."
          >
            {(diary.data?.items ?? []).map((d) => (
              <tr key={d.id}>
                <Td>{d.on_date}</Td>
                <Td>{d.section_name}</Td>
                <Td>{labelOf(DIARY_KINDS, d.kind)}</Td>
                <Td>{d.body}</Td>
                <Td>
                  {d.captured_offline ? (
                    <Badge tone="info">Captured offline</Badge>
                  ) : (
                    'Online'
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {!sectionID && (
          <EmptyState title="Choose a section" body="Then mark the roll before you go." />
        )}
      </PageBody>
    </>
  )
}
