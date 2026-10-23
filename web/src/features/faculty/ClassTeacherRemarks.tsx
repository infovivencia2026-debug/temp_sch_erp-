import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { api, type List, type Section } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Field, Select, SkeletonTiles, ErrorState, EmptyState, Textarea
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { type ReportRemark } from './comms'
import WriteWithAI from '@/components/ai/WriteWithAI'

/* The term-end remark, written a class at a time.

   Thirty remarks is one sitting, so the whole section is on screen with what
   has already been written beside each name — a screen that makes you pick a
   child before it will tell you whether you have done them yet turns one
   sitting into thirty.

   The remark is stored on the report card itself rather than in a table of its
   own, which is why the term picker is not optional: a remark with no term
   cannot be printed on the right card. Nothing here reaches the family until
   somebody publishes the card. */

export default function ClassTeacherRemarks() {
  // Only the classes this person is class teacher of: the remark is hers to write.
  const classes = useQuery({
    queryKey: ['sections', 'class_teacher'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections?mine=class_teacher'),
  })
  const exams = useQuery({ queryKey: ['exams-list'], queryFn: () => api.call('GET /exams/list') })
  const [sectionID, setSectionID] = useState('')
  const [examID, setExamID] = useState('')
  const [studentID, setStudentID] = useState('')

  const examItems = exams.data?.items ?? []
  const classItems = classes.data?.items ?? []
  useEffect(() => {
    if (!examID && examItems.length) setExamID(examItems[0].id)
  }, [examID, examItems])
  useEffect(() => {
    if (!sectionID && classItems.length) setSectionID(classItems[0].id)
  }, [sectionID, classItems])

  const list = useQuery({
    queryKey: ['report-remarks', sectionID, examID],
    enabled: !!sectionID && !!examID,
    queryFn: () =>
      api.get<List<ReportRemark>>(
        `/api/v1/teaching/report-remarks?section_id=${sectionID}&exam_id=${examID}`,
      ),
  })

  const all = list.data?.items ?? []
  const rows = studentID ? all.filter((r) => r.student_id === studentID) : all
  const written = all.filter((r) => r.has_term_remarks).length

  return (
    <>
      <PageHead
        eyebrow="Teaching workspace"
        title="Class teacher remarks"
        description="The qualitative line printed on each report card, plus the principal's summary comment. Nothing here is visible to a parent until the card is published."
      />
      <PageBody>
        <Card>
          <CardHeader title="Which card" description="The remark prints on the report card of the exam you pick." />
          <div className="grid gap-5 px-5 py-5 sm:grid-cols-3">
            <Field label="Class" required>
              <Select
                value={sectionID}
                onChange={(v) => { setSectionID(v); setStudentID('') }}
                placeholder={classItems.length ? 'Choose your class' : 'You are not class teacher of a class'}
                options={classItems.map((c) => ({ value: c.id, label: `${c.class_name}-${c.name}` }))}
              />
            </Field>
            <Field label="Report card" required>
              <Select
                value={examID}
                onChange={setExamID}
                placeholder={examItems.length ? 'Choose an exam' : 'No exams set up yet'}
                options={examItems.map((e) => ({ value: e.id, label: e.name }))}
              />
            </Field>
            <Field label="Student">
              <Select
                value={studentID}
                onChange={setStudentID}
                options={[{ value: '', label: 'All students' }, ...all.map((r) => ({ value: r.student_id, label: r.student_name }))]}
              />
            </Field>
          </div>
        </Card>

        {!classItems.length && !classes.isLoading ? (
          <EmptyState title="You are not class teacher of a class" body="Class teacher remarks are written by the class teacher. The office sets class teachers in Classes & sections." />
        ) : !examItems.length && !exams.isLoading ? (
          <EmptyState title="This school has no exams yet" body="The remark prints on an exam's report card. Ask the exam office to set up the exams first." />
        ) : !sectionID || !examID ? (
          <EmptyState title="Choose a class and a report card" />
        ) : list.isLoading ? (
          <SkeletonTiles count={3} />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Children" value={all.length} />
              <Stat label="Remarks written" value={`${written}/${all.length}`} />
              <Stat
                label="Cards published"
                value={all.filter((r) => r.is_published).length}
                hint="A published card is one the parent can already read"
              />
            </CellGrid>

            <Card>
              <CardHeader title="The class" description="In roll order" />
              {rows.length === 0 ? (
                <EmptyState title="Nobody is enrolled in this class" />
              ) : (
                <ul className="divide-y">
                  {rows.map((r) => (
                    <Row key={`${r.student_id}-${examID}`} row={r} examID={examID} />
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}

function Row({ row, examID }: { row: ReportRemark; examID: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [text, setText] = useState(row.class_teacher_remark ?? '')
  const [principal, setPrincipal] = useState(row.principal_remark ?? '')

  // Whether this account may write the principal's line is a server decision;
  // the screen finds out by asking for the permission rather than by guessing
  // from the role name, which is how a deputy head ends up locked out.
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.call('GET /session'),
  })
  const canSummarise = session.data?.permissions.includes('academics.reportcards.generate') ?? false

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put('/api/v1/teaching/report-remarks', { student_id: row.student_id, exam_id: examID, ...body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['report-remarks'] })
      toast.ok(`Saved for ${row.student_name}`)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  })

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-medium">{row.student_name}</span>
        <span className="text-[13px] text-muted-foreground">{row.admission_no}</span>
        {row.roll_no != null && <Badge>roll {row.roll_no}</Badge>}
        {row.is_published ? (
          <Badge tone="success">card published</Badge>
        ) : row.card_exists ? (
          <Badge tone="warning">draft</Badge>
        ) : null}
      </div>

      <Textarea
        value={text}
        onChange={(v) => setText(v)}
        rows={2}
        placeholder="A steady term. Reads widely and now asks for the harder problems."
        className="mt-2 w-full"
      />
      <div className="mt-1">
        <WriteWithAI kind="report_remark" context={{ student_id: row.student_id }} current={text} onInsert={setText} defaultLength="short" />
      </div>
      {row.class_teacher_remark_by && (
        <p className="mt-1 text-[13px] text-muted-foreground">
          Last written by {row.class_teacher_remark_by}
          {row.class_teacher_remark_at && ` on ${row.class_teacher_remark_at}`}
        </p>
      )}

      {canSummarise && (
        <>
          <Textarea
            value={principal}
            onChange={(v) => setPrincipal(v)}
            rows={2}
            placeholder="Principal's summary comment"
            className="mt-2 w-full"
          />
          {row.principal_remark_by && (
            <p className="mt-1 text-[13px] text-muted-foreground">
              Summary by {row.principal_remark_by}
              {row.principal_remark_at && ` on ${row.principal_remark_at}`}
            </p>
          )}
        </>
      )}

      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() =>
            save.mutate(
              canSummarise
                ? { class_teacher_remark: text, principal_remark: principal }
                : { class_teacher_remark: text },
            )
          }
        >
          <Check className="h-3.5 w-3.5" />
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </li>
  )
}
