import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Award, FolderOpen, Star } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Checkbox, Field, FormGrid, FormNotice, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { type PortfolioPiece } from './classroom'

/* Curating a child's portfolio, from the teacher's side.

   Two portfolio records already exist and are deliberately different: the
   school's own awards, and the child's own claims. A hackathon a child entered
   at the weekend and a prize the school gave out at assembly are not the same
   kind of statement, and a university reading the portfolio is entitled to see
   which is which — so this screen shows them side by side and labelled, and
   merges neither.

   A teacher here adds the school's view and nothing else. The child's entry is
   theirs: it cannot be edited from this screen, only commented on, endorsed,
   or sent back. Silently rewriting a child's own account of their work would
   be the one thing this feature must never do. */

const STATUSES = [
  { value: 'noted', label: 'Noted — seen and kept' },
  { value: 'endorsed', label: 'Endorsed — the school stands behind it' },
  { value: 'returned', label: 'Returned — sent back with a comment' },
]

interface RosterChild {
  student_id: string
  admission_no: string
  full_name: string
  section: string
}

export default function PortfolioBuilder() {
  const toast = useToast()
  const qc = useQueryClient()
  const [studentID, setStudentID] = useState('')
  const [editing, setEditing] = useState<PortfolioPiece | null>(null)
  const [comment, setComment] = useState('')
  const [status, setStatus] = useState('noted')
  const [inReport, setInReport] = useState(false)
  const [featured, setFeatured] = useState(false)

  const roster = useQuery({
    queryKey: ['classroom-progress-roster'],
    queryFn: () => api.get<List<RosterChild>>('/api/v1/teaching/progress'),
  })

  const pieces = useQuery({
    enabled: !!studentID,
    queryKey: ['classroom-portfolio', studentID],
    queryFn: () =>
      api.get<List<PortfolioPiece>>(`/api/v1/classroom/portfolio/${studentID}`),
  })

  const open = (p: PortfolioPiece) => {
    setEditing(p)
    setComment(p.comment ?? '')
    setStatus(p.status === 'uncurated' ? 'noted' : p.status)
    setInReport(p.include_in_report)
    setFeatured(p.is_featured)
  }

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/classroom/portfolio/curations', {
        student_id: studentID,
        source: editing?.source,
        item_id: editing?.item_id,
        status,
        comment: comment || null,
        include_in_report: inReport,
        is_featured: featured,
      }),
    onSuccess: () => {
      toast.ok('Saved')
      setEditing(null)
      qc.invalidateQueries({ queryKey: ['classroom-portfolio', studentID] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
  })

  if (roster.isLoading) return <Loading />
  if (roster.error) return <ErrorState error={roster.error} />

  const items = pieces.data?.items ?? []
  const uncurated = items.filter((p) => p.status === 'uncurated').length

  return (
    <>
      <PageHead
        eyebrow="My classes"
        title="Student portfolio builder"
        description="Review what a child has submitted, add the school's own pieces, and mark what goes on the report."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Pieces" value={items.length} icon={FolderOpen} />
          <Stat
            label="School awards"
            value={items.filter((p) => p.source === 'award').length}
            icon={Award}
          />
          <Stat
            label="On the report"
            value={items.filter((p) => p.include_in_report).length}
            icon={Star}
          />
          <Stat label="Not yet looked at" value={uncurated} />
        </CellGrid>

        <Card>
          <CardHeader title="Whose portfolio" />
          <div className="p-5">
            <FormGrid>
              <Field label="Child">
                <Select
                  value={studentID}
                  onChange={(v) => {
                    setStudentID(v)
                    setEditing(null)
                  }}
                  placeholder="Choose a child…"
                  options={(roster.data?.items ?? []).map((c) => ({
                    value: c.student_id,
                    label: `${c.admission_no} · ${c.full_name} (${c.section})`,
                  }))}
                />
              </Field>
            </FormGrid>
          </div>
        </Card>

        {studentID && pieces.isLoading && <Loading />}
        {pieces.error && <ErrorState error={pieces.error} />}

        {studentID && !pieces.isLoading && (
          <Card>
            <CardHeader
              title="The portfolio"
              description="A school award and a self-declared claim are shown as what they are — never merged."
            />
            <Table
              head={['Kind', 'Title', 'When', 'Verdict', 'On report', '']}
              empty={items.length === 0}
              emptyLabel="Nothing in this child's portfolio yet."
            >
              {items.map((p) => (
                <tr key={`${p.source}-${p.item_id}`}>
                  <Td>
                    <Badge tone={p.source === 'award' ? 'primary' : 'info'} solid>
                      {p.source === 'award' ? 'School award' : "Child's claim"}
                    </Badge>
                  </Td>
                  <Td>
                    {p.title}
                    {p.description && (
                      <span className="block text-[12px] text-muted-foreground">
                        {p.description}
                      </span>
                    )}
                  </Td>
                  <Td>{p.happened_on ?? '—'}</Td>
                  <Td>
                    {p.status === 'uncurated' ? (
                      <span className="text-muted-foreground">Not looked at</span>
                    ) : (
                      <Badge
                        tone={
                          p.status === 'endorsed'
                            ? 'success'
                            : p.status === 'returned'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {p.status}
                      </Badge>
                    )}
                  </Td>
                  <Td>{p.include_in_report ? 'Yes' : '—'}</Td>
                  <Td>
                    <Button variant="ghost" onClick={() => open(p)}>
                      Curate
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {editing && (
          <Card>
            <CardHeader
              title={`Curating: ${editing.title}`}
              description={
                editing.source === 'award'
                  ? "The school's own record of what this child won."
                  : "The child's own entry. Comment on it; it stays theirs."
              }
            />
            <div className="p-5 space-y-5">
              <FormGrid>
                <Field label="Verdict">
                  <Select value={status} onChange={setStatus} options={STATUSES} />
                </Field>
                <Field
                  label="Comment"
                  hint="The sentence a parent reads next to the child's own description."
                  wide
                >
                  <Textarea value={comment} onChange={setComment} rows={3} />
                </Field>
              </FormGrid>
              <Checkbox
                checked={inReport}
                onChange={setInReport}
                label="Print on the report card"
                hint="A returned piece is never printed, whatever this says."
              />
              <Checkbox
                checked={featured}
                onChange={setFeatured}
                label="Feature on the portfolio wall"
              />
              <FormNotice error={save.error} />
              <div className="flex gap-2">
                <Button onClick={() => save.mutate()} disabled={save.isPending}>
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        )}

        {!studentID && (
          <EmptyState
            title="Choose a child"
            body="Their awards and their own entries appear together."
          />
        )}
      </PageBody>
    </>
  )
}
