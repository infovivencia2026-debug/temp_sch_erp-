import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Card, CardHeader, Badge, Button, Select, Input, FormNotice, Table, Td, EmptyState,
} from '@/components/ui'

/* ASKED FOR, BY A TIME, OR IT SHOWS ON THEIR RECORD (owner, 2026-10-19:
 * "the examination branch will set a deadline... all the subject teachers
 * where the subject is scheduled for the exam will get a deadline in
 * dashboard and in notification... if it is sent within the time it is
 * okay, or else this will be a remark in their performance, shown
 * everywhere in their performance... let the examination branch schedule a
 * date and time, and let them click 'the paper is given' for anyone it
 * came from another way").
 *
 * Submitting itself is unchanged -- this only adds who was asked and by
 * when. A missed deadline is read, once, by services/background/housekeeping.ts
 * (exams:paper_deadline_sweep), which writes the one remark (staff_remarks)
 * and tells the teacher; nothing here decides lateness itself.
 */

interface Exam { id: string; name: string }
interface Assigned {
  id: string; teacher_id: string; teacher_name: string; deadline: string
  status: 'pending' | 'late' | 'received'; received_manually: boolean
}
interface SubjectRow {
  exam_subject_id: string; class_name: string; subject_name: string; exam_date: string | null
  candidate_teachers: { teacher_id: string; full_name: string }[]
  paper: { status: string; submitted_at: string; file_id: string | null } | null
  assigned: Assigned[]
}

const STATUS: Record<Assigned['status'], { label: string; tone: 'warning' | 'danger' | 'success' }> = {
  pending: { label: 'Waiting', tone: 'warning' },
  late: { label: 'Missed the deadline', tone: 'danger' },
  received: { label: 'Received', tone: 'success' },
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

/** One subject's row: which teachers were asked, and the form to ask more. */
function SubjectDeadline({ row, onDone }: { row: SubjectRow; onDone: () => void }) {
  const [picking, setPicking] = useState(false)
  const [teacherId, setTeacherId] = useState('')
  const [deadline, setDeadline] = useState('')

  const ask = useMutation({
    mutationFn: () =>
      api.post('/api/v1/exams/question-paper-deadlines', {
        exam_subject_id: row.exam_subject_id,
        teacher_user_ids: [teacherId],
        deadline: new Date(deadline).toISOString(),
      }),
    onSuccess: () => { setPicking(false); setTeacherId(''); setDeadline(''); onDone() },
  })
  const markReceived = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/exams/question-paper-deadlines/${id}/mark-received`, {}),
    onSuccess: onDone,
  })

  const askable = row.candidate_teachers.filter((t) => !row.assigned.some((a) => a.teacher_id === t.teacher_id))

  return (
    <tr>
      <Td className="font-medium">
        {row.subject_name}
        <div className="text-[12px] text-muted-foreground">{row.class_name}{row.exam_date ? ` · ${row.exam_date}` : ''}</div>
      </Td>
      <Td>
        {row.assigned.length === 0 ? (
          <span className="text-[13px] text-muted-foreground">Nobody asked yet</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {row.assigned.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-medium">{a.teacher_name}</span>
                <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
                <span className="text-muted-foreground">by {timeLabel(a.deadline)}</span>
                {a.status !== 'received' && (
                  <Button size="sm" variant="ghost" disabled={markReceived.isPending} onClick={() => markReceived.mutate(a.id)}>
                    Mark the paper given
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Td>
      <Td>
        {!picking ? (
          <Button size="sm" variant="secondary" disabled={askable.length === 0} onClick={() => setPicking(true)}>
            {askable.length === 0 ? 'Everyone asked' : 'Ask a teacher'}
          </Button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-40">
              <Select value={teacherId} onChange={setTeacherId} placeholder="Which teacher"
                options={askable.map((t) => ({ value: t.teacher_id, label: t.full_name }))} />
            </div>
            <Input type="datetime-local" value={deadline} onChange={setDeadline} className="w-48" />
            <Button size="sm" disabled={!teacherId || !deadline || ask.isPending} onClick={() => ask.mutate()}>
              Set deadline
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>Cancel</Button>
          </div>
        )}
      </Td>
    </tr>
  )
}

export default function PaperDeadlines() {
  const qc = useQueryClient()
  const [examId, setExamId] = useState('')
  const exams = useQuery({ queryKey: ['exams-list'], queryFn: () => api.call('GET /exams/list') })
  const rows = useQuery({
    queryKey: ['question-paper-deadlines', examId],
    queryFn: () => api.get<{ items: SubjectRow[] }>(`/api/v1/exams/question-paper-deadlines?exam_id=${examId}`),
    enabled: !!examId,
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['question-paper-deadlines'] })

  return (
    <Card>
      <CardHeader
        title="Set a deadline for question papers"
        description="Pick the exam, then ask a subject's teacher for their paper by a date and time. A paper that does not arrive in time shows as a remark on that teacher's record."
      />
      <div className="px-[var(--card-pad)] py-4">
        <div className="w-full sm:w-56">
          <Select value={examId} onChange={setExamId} placeholder="Which exam"
            options={(exams.data?.items ?? []).map((e: Exam) => ({ value: e.id, label: e.name }))} />
        </div>
      </div>
      {!examId ? null : rows.isLoading ? (
        <p className="px-[var(--card-pad)] pb-4 text-[13px] text-muted-foreground">Reading the subjects…</p>
      ) : rows.error ? (
        <FormNotice error={rows.error} />
      ) : (rows.data?.items.length ?? 0) === 0 ? (
        <EmptyState title="Nothing set up yet" body="This exam has no subject with a date. Set dates in Exams &amp; papers → Date sheet first." />
      ) : (
        <Table head={['Subject', 'Asked', '']}>
          {(rows.data?.items ?? []).map((r) => (
            <SubjectDeadline key={r.exam_subject_id} row={r} onDone={refresh} />
          ))}
        </Table>
      )}
    </Card>
  )
}
