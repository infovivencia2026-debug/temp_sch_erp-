import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NotebookPen } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Field, FormGrid, FormNotice, Input, Select, Textarea,
  SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import {
  FA_CYCLES, FA_INDICATORS, useTeachingClasses, useTeachingSubjects,
  numOrNull, label, type FormativeRow,
} from './teaching'

/* Formative assessment: the continuous half of CCE.

   Four activities gathered across a term and a sentence about how the child is
   getting on. The sentence is the point — it is the part a mark cannot carry,
   and the part a parent actually reads.

   The indicator is chosen by the teacher, never computed from the total. A
   child scoring 18 of 20 who has stopped asking questions is exactly what
   continuous assessment exists to catch, and a band derived from the marks
   would hide it.

   The grid saves whole: a component left blank is saved as blank, so a mark
   typed into the wrong column can be cleared rather than only overwritten. */

export default function CCEFormative() {
  const toast = useToast()
  const qc = useQueryClient()
  const subjects = useTeachingSubjects()
  const classes = useTeachingClasses()

  const [classSubjectID, setClassSubjectID] = useState('')
  const [sectionID, setSectionID] = useState('')
  const [cycle, setCycle] = useState('FA1')
  const [componentMax, setComponentMax] = useState('5')
  const [draft, setDraft] = useState<Record<string, Partial<FormativeRow>>>({})

  const query = new URLSearchParams({ cycle })
  if (classSubjectID) query.set('class_subject_id', classSubjectID)
  if (sectionID) query.set('section_id', sectionID)

  const list = useQuery({
    queryKey: ['cce-formative', query.toString()],
    queryFn: () =>
      api.get<List<FormativeRow>>(`/api/v1/teaching/cce/formative?${query.toString()}`),
  })

  // A fresh cycle or class is a fresh sheet; keeping edits across a change
  // would post one class's marks against another's roll.
  useEffect(() => setDraft({}), [classSubjectID, sectionID, cycle])

  const save = useMutation({
    mutationFn: () => {
      const rows = list.data?.items ?? []
      const entries = rows
        .filter((r) => draft[r.student_id])
        .map((r) => {
          const d = draft[r.student_id]
          return {
            student_id: r.student_id,
            written_work: d.written_work ?? null,
            project_work: d.project_work ?? null,
            slip_test: d.slip_test ?? null,
            participation: d.participation ?? null,
            observation: d.observation ?? '',
            indicator: d.indicator ?? '',
          }
        })
      return api.put('/api/v1/teaching/cce/formative', {
        class_subject_id: classSubjectID,
        section_id: sectionID || undefined,
        cycle,
        component_max: Number(componentMax) || 5,
        entries,
      })
    },
    onSuccess: () => {
      toast.ok('Assessment recorded')
      setDraft({})
      qc.invalidateQueries({ queryKey: ['cce-formative'] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  })

  if (list.isLoading) return <SkeletonTiles count={3} />
  if (list.error) return <ErrorState error={list.error} />
  const rows = list.data?.items ?? []
  const max = Number(componentMax) || 5

  /* The draft wins where it exists, so a cleared box stays cleared while the
     teacher is still typing. */
  const valueOf = (r: FormativeRow, k: keyof FormativeRow) => {
    const d = draft[r.student_id]
    if (d && k in d) {
      const v = d[k]
      return v === null || v === undefined ? '' : String(v)
    }
    const v = r[k]
    return v === null || v === undefined ? '' : String(v)
  }

  const set = (id: string, k: keyof FormativeRow, v: unknown) =>
    setDraft((d) => ({ ...d, [id]: { ...d[id], [k]: v } }))

  const recorded = rows.filter((r) => r.entry_id).length
  const needSupport = rows.filter((r) => r.indicator === 'needs_support').length

  return (
    <>
      <PageHead
        eyebrow="Assessment schemes"
        title="CCE formative assessment"
        description="FA1 to FA4: written work, project, slip test and participation, with the observation that explains them."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Children on roll" value={rows.length} icon={NotebookPen} />
          <Stat label="Recorded this cycle" value={`${recorded} of ${rows.length}`} />
          <Stat
            label="Flagged for support"
            value={needSupport}
            delta={{
              value: needSupport > 0 ? 'Follow these up' : 'None flagged',
              positive: needSupport === 0,
            }}
          />
        </CellGrid>

        <Card>
          <CardHeader title="Which class" description="Defaults to the first subject you teach." />
          <div className="px-5 pb-5">
            <FormGrid>
              <Field label="Subject">
                <Select
                  value={classSubjectID}
                  onChange={setClassSubjectID}
                  placeholder="First subject I teach"
                  options={(subjects.data?.items ?? []).map((s) => ({
                    value: s.class_subject_id,
                    label: `${s.class_name} · ${s.subject}`,
                  }))}
                />
              </Field>
              <Field label="Class">
                <Select
                  value={sectionID}
                  onChange={setSectionID}
                  placeholder="First class I teach it to"
                  options={(classes.data?.items ?? []).map((c) => ({
                    value: c.section_id,
                    label: `${c.class_name} ${c.section_name}`,
                  }))}
                />
              </Field>
              <Field label="Cycle">
                <Select
                  value={cycle}
                  onChange={setCycle}
                  options={FA_CYCLES.map((c) => ({ value: c.value, label: c.label }))}
                />
              </Field>
              <Field label="Each component out of" hint="Five each, twenty in total, by default.">
                <Input value={componentMax} onChange={setComponentMax} placeholder="5" />
              </Field>
            </FormGrid>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={`${cycle} — the sheet`}
            description={`Each component out of ${max}; ${max * 4} in total. Leave a box blank where nothing has been assessed yet — blank is not zero.`}
            action={
              <Button
                onClick={() => save.mutate()}
                disabled={Object.keys(draft).length === 0 || !classSubjectID}
                title={!classSubjectID ? 'Choose a subject first' : undefined}
              >
                Save {cycle}
              </Button>
            }
          />
          {rows.length === 0 ? (
            <EmptyState
              title="No children to assess"
              body="Choose a subject and class you teach."
            />
          ) : (
            <Table
              head={['Roll', 'Child', 'Written', 'Project', 'Slip test', 'Participation',
                'Total', 'Indicator', 'Observation']}
            >
              {rows.map((r) => {
                const d = draft[r.student_id] ?? {}
                const parts = [
                  d.written_work ?? r.written_work,
                  d.project_work ?? r.project_work,
                  d.slip_test ?? r.slip_test,
                  d.participation ?? r.participation,
                ].filter((v) => v !== null && v !== undefined) as number[]
                const total = parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null

                return (
                  <tr key={r.student_id}>
                    <Td>{r.roll_no ?? '—'}</Td>
                    <Td>
                      <span className="font-medium">{r.full_name}</span>
                      <span className="block text-[12px] text-muted-foreground">
                        {r.admission_no}
                      </span>
                    </Td>
                    {(['written_work', 'project_work', 'slip_test', 'participation'] as const).map(
                      (k) => (
                        <Td key={k}>
                          <Input
                            value={valueOf(r, k)}
                            onChange={(v) => set(r.student_id, k, numOrNull(v))}
                            placeholder={`/${max}`}
                            className="w-16"
                          />
                        </Td>
                      ),
                    )}
                    <Td>
                      {total === null
                        ? <span className="text-muted-foreground">—</span>
                        : <span className="font-medium">{total} / {max * 4}</span>}
                    </Td>
                    <Td>
                      <Select
                        value={String(d.indicator ?? r.indicator ?? '')}
                        onChange={(v) => set(r.student_id, 'indicator', v)}
                        placeholder="—"
                        options={FA_INDICATORS.map((i) => ({ value: i.value, label: i.label }))}
                      />
                    </Td>
                    <Td>
                      <Textarea
                        value={String(d.observation ?? r.observation ?? '')}
                        onChange={(v) => set(r.student_id, 'observation', v)}
                        rows={2}
                        placeholder="What you noticed this cycle."
                      />
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
          <div className="px-5 pb-5">
            <FormNotice error={save.error} />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Already recorded"
            description="What this cycle currently holds for the class"
          />
          {recorded === 0 ? (
            <EmptyState title="Nothing recorded for this cycle yet" />
          ) : (
            <Table head={['Child', 'Total', 'Indicator', 'Observation', 'Recorded by']}>
              {rows.filter((r) => r.entry_id).map((r) => (
                <tr key={r.student_id}>
                  <Td>{r.full_name}</Td>
                  <Td>{r.total ?? '—'} / {r.max_total}</Td>
                  <Td>
                    {r.indicator
                      ? (
                        <Badge tone={r.indicator === 'needs_support' ? 'warning' : 'success'}>
                          {label(FA_INDICATORS, r.indicator)}
                        </Badge>
                      )
                      : '—'}
                  </Td>
                  <Td>{r.observation ?? '—'}</Td>
                  <Td>{r.recorded_by ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
