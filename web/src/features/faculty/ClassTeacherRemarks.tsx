import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Field, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { useMyClasses, useTerms, type ReportRemark } from './comms'

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
  const classes = useMyClasses()
  const terms = useTerms()
  const [sectionID, setSectionID] = useState('')
  const [termID, setTermID] = useState('')

  // Default to the term that is running and the first class taught, so the
  // screen opens on work rather than on two empty dropdowns.
  const termItems = terms.data?.items ?? []
  const classItems = classes.data?.items ?? []
  useEffect(() => {
    if (!termID && termItems.length) {
      setTermID((termItems.find((t) => t.is_current) ?? termItems[0]).id)
    }
  }, [termID, termItems])
  useEffect(() => {
    if (!sectionID && classItems.length) setSectionID(classItems[0].section_id)
  }, [sectionID, classItems])

  const list = useQuery({
    queryKey: ['report-remarks', sectionID, termID],
    enabled: !!sectionID && !!termID,
    queryFn: () =>
      api.get<List<ReportRemark>>(
        `/api/v1/teaching/report-remarks?section_id=${sectionID}&term_id=${termID}`,
      ),
  })

  const rows = list.data?.items ?? []
  const written = rows.filter((r) => r.has_term_remarks).length

  return (
    <>
      <PageHead
        eyebrow="Teaching workspace"
        title="Class teacher remarks"
        description="The qualitative line printed on each report card, plus the principal's summary comment. Nothing here is visible to a parent until the card is published."
      />
      <PageBody>
        <Card>
          <CardHeader title="Which card" description="A remark belongs to a term, or it prints on the wrong one." />
          <div className="grid gap-5 px-5 py-5 sm:grid-cols-2">
            <Field label="Class" required>
              <Select
                value={sectionID}
                onChange={setSectionID}
                placeholder="Choose a class you teach"
                options={classItems.map((c) => ({
                  value: c.section_id,
                  label: `${c.class_name}-${c.section_name}`,
                }))}
              />
            </Field>
            <Field label="Term" required>
              <Select
                value={termID}
                onChange={setTermID}
                placeholder={termItems.length ? 'Choose a term' : 'No terms set up yet'}
                options={termItems.map((t) => ({
                  value: t.id,
                  label: `${t.name} — ${t.academic_year}`,
                }))}
              />
            </Field>
          </div>
        </Card>

        {!termItems.length ? (
          <EmptyState
            title="This school has no terms yet"
            body="Report-card remarks are filed against a term. Ask the office to set the terms up for this academic year before writing them."
          />
        ) : !sectionID || !termID ? (
          <EmptyState title="Choose a class and a term" />
        ) : list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorState error={list.error} />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Children" value={rows.length} />
              <Stat label="Remarks written" value={`${written}/${rows.length}`} />
              <Stat
                label="Cards published"
                value={rows.filter((r) => r.is_published).length}
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
                    <Row key={r.student_id} row={r} termID={termID} />
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

function Row({ row, termID }: { row: ReportRemark; termID: string }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [text, setText] = useState(row.class_teacher_remark ?? '')
  const [principal, setPrincipal] = useState(row.principal_remark ?? '')

  // Whether this account may write the principal's line is a server decision;
  // the screen finds out by asking for the permission rather than by guessing
  // from the role name, which is how a deputy head ends up locked out.
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ permissions: string[] }>('/api/v1/session'),
  })
  const canSummarise = session.data?.permissions.includes('academics.reportcards.generate') ?? false

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put('/api/v1/teaching/report-remarks', { student_id: row.student_id, term_id: termID, ...body }),
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

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="A steady term. Reads widely and now asks for the harder problems."
        className="field mt-2 h-auto w-full py-2"
      />
      {row.class_teacher_remark_by && (
        <p className="mt-1 text-[13px] text-muted-foreground">
          Last written by {row.class_teacher_remark_by}
          {row.class_teacher_remark_at && ` on ${row.class_teacher_remark_at}`}
        </p>
      )}

      {canSummarise && (
        <>
          <textarea
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            rows={2}
            placeholder="Principal's summary comment"
            className="field mt-2 h-auto w-full py-2"
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
