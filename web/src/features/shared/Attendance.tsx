import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List, type Section, type AttendanceRow, type Page, type Student } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Button, Select, Loading, ErrorState } from '@/components/ui'
import { useCan } from '@/lib/session'
import { useToast } from '@/components/Toast'

const STATUSES = ['present', 'absent', 'late', 'half_day', 'leave', 'holiday'] as const
type Status = (typeof STATUSES)[number]

const TONE: Record<string, 'success' | 'danger' | 'primary' | 'neutral'> = {
  present: 'success', absent: 'danger', late: 'primary',
  half_day: 'primary', leave: 'neutral', holiday: 'neutral',
}

export default function Attendance() {
  const can = useCan()
  const qc = useQueryClient()
  const [sectionId, setSectionId] = useState('')
  const [onDate, setOnDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [draft, setDraft] = useState<Record<string, Status>>({})

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })

  // The register needs every student in the section, not only those already
  // marked, so the roster comes from /students and existing marks are layered
  // on top by student_id.
  const roster = useQuery({
    queryKey: ['roster', sectionId],
    queryFn: () => api.get<Page<Student>>(`/api/v1/students?section_id=${sectionId}&limit=200`),
    enabled: !!sectionId,
  })

  const marks = useQuery({
    queryKey: ['attendance', sectionId, onDate],
    queryFn: () =>
      api.get<List<AttendanceRow>>(`/api/v1/attendance?section_id=${sectionId}&on_date=${onDate}`),
    enabled: !!sectionId,
  })

  const toast = useToast()

  const save = useMutation({
    mutationFn: (entries: { student_id: string; status: Status }[]) =>
      api.post('/api/v1/attendance', { section_id: sectionId, on_date: onDate, entries }),
    onSuccess: (_res, entries) => {
      setDraft({})
      qc.invalidateQueries({ queryKey: ['attendance', sectionId, onDate] })
      // The count matters: a register saved with three of forty marked is the
      // failure a teacher discovers a week later, and silence hides it.
      const absent = entries.filter((e) => e.status === 'absent').length
      toast.ok(
        `Register saved — ${entries.length} marked${absent ? `, ${absent} absent` : ''}`,
      )
    },
  })

  const existing = new Map((marks.data?.items ?? []).map((m) => [m.student_id, m.status]))
  const students = roster.data?.items ?? []
  const dirty = Object.keys(draft).length > 0

  const markAll = (status: Status) =>
    setDraft(Object.fromEntries(students.map((s) => [s.id, status])))

  return (
    <Card>
      <CardHeader
        title="Attendance register"
        description={sectionId ? `${students.length} students` : 'Choose a section to begin'}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={sectionId}
              onChange={(v) => { setSectionId(v); setDraft({}) }}
              placeholder="Select section"
              options={(sections.data?.items ?? []).map((s) => ({
                value: s.id, label: `${s.class_name}-${s.name}`,
              }))}
            />
            <input
              type="date"
              value={onDate}
              onChange={(e) => { setOnDate(e.target.value); setDraft({}) }}
              className="rounded-md border bg-background px-2.5 py-1.5 text-sm"
            />
          </div>
        }
      />

      {!sectionId ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          Select a section and date.
        </p>
      ) : roster.isLoading || marks.isLoading ? (
        <Loading />
      ) : roster.error ? (
        <ErrorState error={roster.error} />
      ) : (
        <>
          {can('academics.attendance.write') && (
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
              <span className="text-xs text-muted-foreground">Mark all:</span>
              <Button variant="ghost" onClick={() => markAll('present')}>Present</Button>
              <Button variant="ghost" onClick={() => markAll('absent')}>Absent</Button>
              <div className="ml-auto flex items-center gap-2">
                {save.isError && <ErrorMessage error={save.error} />}
                {save.isSuccess && !dirty && <span className="text-xs text-success">Saved</span>}
                <Button
                  disabled={!dirty || save.isPending}
                  onClick={() =>
                    save.mutate(Object.entries(draft).map(([student_id, status]) => ({ student_id, status })))
                  }
                >
                  {save.isPending ? 'Saving…' : `Save ${Object.keys(draft).length || ''}`.trim()}
                </Button>
              </div>
            </div>
          )}

          <Table head={['Admission no.', 'Student', 'Recorded', 'Mark']} empty={!students.length}>
            {students.map((s) => {
              const saved = existing.get(s.id)
              const value = draft[s.id] ?? (saved as Status | undefined) ?? ''
              return (
                <tr key={s.id}>
                  <Td className="font-mono text-xs">{s.admission_no}</Td>
                  <Td className="font-medium">{s.full_name}</Td>
                  <Td>{saved ? <Badge tone={TONE[saved]}>{saved}</Badge> : <span className="text-xs text-muted-foreground">Not marked</span>}</Td>
                  <Td>
                    <select
                      value={value}
                      disabled={!can('academics.attendance.write')}
                      onChange={(e) => setDraft({ ...draft, [s.id]: e.target.value as Status })}
                      className="rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-50"
                    >
                      <option value="">—</option>
                      {STATUSES.map((st) => (
                        <option key={st} value={st}>{st.replace('_', ' ')}</option>
                      ))}
                    </select>
                  </Td>
                </tr>
              )
            })}
          </Table>
        </>
      )}
    </Card>
  )
}

function ErrorMessage({ error }: { error: unknown }) {
  return (
    <span className="text-xs text-destructive">
      {error instanceof Error ? error.message : 'Save failed'}
    </span>
  )
}
