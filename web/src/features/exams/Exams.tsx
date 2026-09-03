import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button,
  Input, Field, FormGrid, FormNotice, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* The exam, and the papers everything else hangs off.
 *
 * Exams could only be created in the setup wizard, and their papers with them.
 * Afterwards there was no route at all — so an exam scheduled without papers,
 * or one that gained a class in September, could never be given any. Marks
 * entry says "no exam papers exist yet"; question paper approval has nothing to
 * approve; moderation has nothing to moderate; hall tickets have nothing to
 * print; report cards have nothing to total. One missing route stopped five
 * screens, and the only visible symptom was five empty pages that each looked
 * broken on their own.
 *
 * A paper is one subject of one class in one exam. Adding them is idempotent —
 * run it again after adding a class and only the missing ones appear — because
 * the alternative is asking somebody to work out which subjects they already
 * did.
 */

interface Exam {
  id: string
  name: string
  kind: string
  starts_on?: string
  is_published: boolean
  papers: number
}

export default function Exams() {
  const qc = useQueryClient()
  const [marks, setMarks] = useState('100')
  const [done, setDone] = useState('')

  const exams = useQuery({
    queryKey: ['exams-list'],
    queryFn: () => api.get<List<Exam>>('/api/v1/exams/list'),
  })

  const addPapers = useMutation({
    mutationFn: (examID: string) =>
      api.post<{ papers_added: number }>(`/api/v1/exams/${examID}/papers`, {
        max_marks: Number(marks) || 100,
      }),
    onSuccess: (r) => {
      setDone(
        `${r.papers_added} papers created — one for every subject each class studies. ` +
          'Marks entry, question paper approval and report cards can run now.',
      )
      qc.invalidateQueries({ queryKey: ['exams-list'] })
    },
    onError: () => setDone(''),
  })

  if (exams.isLoading) return <SkeletonTable columns={6} />
  if (exams.error) return <ErrorState error={exams.error} />
  const rows = exams.data?.items ?? []
  const empty = rows.filter((e) => e.papers === 0)

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Exams & papers"
        description="Every exam the school has scheduled, and how many papers it holds. Nothing downstream — marks, moderation, hall tickets, report cards — can run until an exam has papers."
      />
      <PageBody>
        {done && <FormNotice ok={done} />}
        {addPapers.error && <FormNotice error={addPapers.error} />}

        {empty.length > 0 && (
          <Card>
            <CardHeader
              title={`${empty.length} ${empty.length === 1 ? 'exam has' : 'exams have'} no papers`}
              description="An exam with no papers cannot be marked, moderated, or turned into a report card. Creating them makes one paper for every subject each class studies."
            />
            <FormGrid>
              <Field label="Each paper is out of" hint="20 for a formative, 80 for a summative, 100 for a term exam.">
                <Input type="number" value={marks} onChange={setMarks} />
              </Field>
            </FormGrid>
          </Card>
        )}

        <Card>
          <CardHeader title="Exams" description="Most recently starting first." />
          {rows.length === 0 ? (
            <EmptyState
              title="No exams scheduled yet."
              body="Schedule one on School setup → Exams, then create its papers here."
            />
          ) : (
            <Table head={['Exam', 'Kind', 'Starts', 'Papers', 'Published', '']}>
              {rows.map((e) => (
                <tr key={e.id}>
                  <Td className="font-medium">{e.name}</Td>
                  <Td>{e.kind}</Td>
                  <Td className="text-muted-foreground">
                    {e.starts_on ? formatDate(e.starts_on) : '—'}
                  </Td>
                  <Td>
                    {e.papers > 0 ? (
                      e.papers
                    ) : (
                      /* Said as the consequence, not as a zero. A zero in this
                         column is the reason five other screens are empty. */
                      <Badge tone="warning">none — nothing can be marked</Badge>
                    )}
                  </Td>
                  <Td>
                    {e.is_published ? <Badge tone="success">published</Badge> : '—'}
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant={e.papers === 0 ? 'primary' : 'ghost'}
                      disabled={addPapers.isPending}
                      onClick={() => addPapers.mutate(e.id)}
                    >
                      {e.papers === 0 ? 'Create papers' : 'Add missing papers'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
