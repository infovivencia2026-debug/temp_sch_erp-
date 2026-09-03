/* Badges and demerits, which the menu has promised and no screen has done.
 *
 * "Student Behavior & Demerits" opened the progress screen — attendance,
 * marks, support plans — and there was nothing anywhere to award a badge or
 * log a demerit with. The table has been there since the first migration and
 * the endpoints since the my-classes module; only the door was missing.
 *
 * One list, not two. A child's conduct is one record read in order, and
 * splitting it into a praise wall and a punishment book is how a school ends up
 * with two accounts of the same Tuesday.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, Checkbox, Input, Select, Textarea, SkeletonTiles, ErrorState, EmptyState,
  FormNotice,
} from '@/components/ui'
import { ExportRows, SearchBox, Showing, useSearch } from '@/components/rows'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'

interface Note {
  id: string
  student_id: string
  student_name: string
  occurred_on: string
  category: string
  is_positive: boolean
  description: string
  action_taken?: string
  visible_to_student: boolean
  parent_notified: boolean
  recorded_by?: string
}

interface Pupil { id: string; full_name: string; admission_no: string }

/* The vocabulary a school actually uses, split by which way it points.

   Free text would let one teacher write "Kindness" and another "kind", and the
   count a form tutor reads at the end of term would be wrong in a way nobody
   could see. */
const PRAISE = ['kindness', 'curiosity', 'effort', 'helpfulness', 'leadership', 'improvement']
const CONCERN = ['conduct', 'homework', 'punctuality', 'uniform', 'disruption', 'damage']

export default function Behaviour() {
  const qc = useQueryClient()
  const mayNote = useCan()('welfare.discipline.write')

  const [positive, setPositive] = useState(true)
  const [studentId, setStudentId] = useState('')
  const [category, setCategory] = useState('kindness')
  const [what, setWhat] = useState('')
  const [action, setAction] = useState('')
  const [tellStudent, setTellStudent] = useState(true)
  const [tellParent, setTellParent] = useState(false)
  const [saved, setSaved] = useState('')

  const notes = useQuery({
    queryKey: ['discipline-notes'],
    queryFn: () => api.get<List<Note>>('/api/v1/students/notes'),
  })
  const pupils = useQuery({
    queryKey: ['my-students'],
    queryFn: () => api.get<List<Pupil>>('/api/v1/students?limit=500'),
  })

  const record = useMutation({
    mutationFn: () => api.post('/api/v1/students/notes', {
      student_id: studentId,
      category,
      is_positive: positive,
      description: what.trim(),
      action_taken: action.trim() || undefined,
      visible_to_student: tellStudent,
      parent_notified: tellParent,
    }),
    onSuccess: () => {
      setSaved(positive ? 'Badge awarded.' : 'Demerit recorded.')
      setWhat('')
      setAction('')
      setStudentId('')
      qc.invalidateQueries({ queryKey: ['discipline-notes'] })
    },
  })

  const items = notes.data?.items ?? []
  const { q: term, setQ: setTerm, shown } = useSearch(items,
    (n) => [n.student_name, n.category, n.description, n.action_taken])

  if (notes.isLoading) return <SkeletonTiles count={3} />
  if (notes.error) return <ErrorState error={notes.error} />

  const praise = items.filter((n) => n.is_positive).length
  const concerns = items.length - praise

  return (
    <>
      <PageHead
        eyebrow="My Classes"
        title="Behaviour"
        description="Badges for what a child did well, and notes on what needs correcting. One record, read in order."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Badges awarded" value={praise} />
          <Stat label="Concerns logged" value={concerns} />
          <Stat
            label="Parents told"
            value={items.filter((n) => n.parent_notified).length}
            hint={concerns && !items.some((n) => !n.is_positive && n.parent_notified)
              ? 'No concern has been passed on yet' : undefined}
          />
        </CellGrid>

        {mayNote && (
          <Card>
            <CardHeader title="Record something" />
            <div className="flex flex-wrap gap-2 px-5 pt-5">
              {/* Which way it points, chosen first: it decides the vocabulary
                  below, and a demerit filed under "kindness" is the sort of
                  thing a form that offered one list would produce. */}
              <Button
                variant={positive ? 'primary' : 'secondary'}
                onClick={() => { setPositive(true); setCategory(PRAISE[0]) }}
              >
                <ThumbsUp className="h-3.5 w-3.5" />
                A badge
              </Button>
              <Button
                variant={!positive ? 'primary' : 'secondary'}
                tone={!positive ? 'danger' : undefined}
                onClick={() => { setPositive(false); setCategory(CONCERN[0]) }}
              >
                <ThumbsDown className="h-3.5 w-3.5" />
                A concern
              </Button>
            </div>

            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">Which child *</span>
                <Select
                  value={studentId}
                  onChange={setStudentId}
                  placeholder={pupils.isLoading ? 'Loading…' : 'Pick a student'}
                  options={(pupils.data?.items ?? []).map((p) => ({
                    value: p.id,
                    /* Named with the admission number: a class of sixty has
                       three children called the same thing, and a note against
                       the wrong one is worse than no note. */
                    label: `${p.full_name} · ${p.admission_no}`,
                  }))}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px]">
                <span className="text-muted-foreground">For what</span>
                <Select
                  value={category}
                  onChange={setCategory}
                  options={(positive ? PRAISE : CONCERN).map((c) => ({
                    value: c, label: c[0].toUpperCase() + c.slice(1),
                  }))}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] sm:col-span-2">
                <span className="text-muted-foreground">What happened *</span>
                <Textarea
                  value={what}
                  onChange={setWhat}
                  rows={2}
                  placeholder={positive
                    ? 'Stayed behind to help clear up after the science practical.'
                    : 'Third time this week without the homework diary.'}
                />
              </label>
              {!positive && (
                <label className="flex flex-col gap-1.5 text-[13px] sm:col-span-2">
                  <span className="text-muted-foreground">What was done about it</span>
                  <Input
                    value={action}
                    onChange={setAction}
                    placeholder="Spoke to him after class; diary to be signed nightly."
                  />
                </label>
              )}
              <div className="flex flex-wrap gap-6 sm:col-span-2">
                <Checkbox
                  checked={tellStudent}
                  onChange={setTellStudent}
                  label="The child can see this"
                  hint="A badge nobody is told about is not a badge."
                />
                <Checkbox
                  checked={tellParent}
                  onChange={setTellParent}
                  label="Tell the parents"
                  hint="A concern a family first hears at the parents' evening is one they cannot help with."
                />
              </div>
            </div>

            <FormNotice error={record.error} ok={saved} />

            <div className="border-t px-5 py-4">
              <Button
                disabled={!studentId || !what.trim() || record.isPending}
                onClick={() => record.mutate()}
              >
                {record.isPending ? 'Saving…' : positive ? 'Award the badge' : 'Record the concern'}
              </Button>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="The record"
            action={
              <span className="flex flex-wrap items-center gap-2">
                <Showing shown={shown.length} total={items.length} noun="notes" />
                <SearchBox value={term} onChange={setTerm} placeholder="Child, reason or note" />
                <ExportRows
                  rows={shown}
                  name="behaviour"
                  columns={[
                    { header: 'Date', value: (n) => n.occurred_on },
                    { header: 'Student', value: (n) => n.student_name },
                    { header: 'Kind', value: (n) => (n.is_positive ? 'badge' : 'concern') },
                    { header: 'For', value: (n) => n.category },
                    { header: 'What happened', value: (n) => n.description },
                    { header: 'Action taken', value: (n) => n.action_taken },
                    { header: 'Parents told', value: (n) => (n.parent_notified ? 'yes' : 'no') },
                    { header: 'Recorded by', value: (n) => n.recorded_by },
                  ]}
                />
              </span>
            }
          />
          {shown.length === 0 ? (
            <EmptyState
              title={term ? 'Nothing matches that' : 'Nothing recorded yet'}
              body={term
                ? 'Try the child’s name, or the reason.'
                : 'Badges and concerns you record appear here, newest first.'}
            />
          ) : (
            <Table wide head={['Date', 'Student', 'For', 'What happened', 'Seen by', 'By']}>
              {shown.map((n) => (
                <tr key={n.id}>
                  <Td className="text-muted-foreground">{formatDate(n.occurred_on)}</Td>
                  <Td className="font-medium">{n.student_name}</Td>
                  <Td>
                    <Badge tone={n.is_positive ? 'success' : 'warning'}>
                      {n.category}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="block max-w-md">{n.description}</span>
                    {n.action_taken && (
                      <span className="mt-0.5 block text-[12px] text-muted-foreground">
                        {n.action_taken}
                      </span>
                    )}
                  </Td>
                  <Td className="text-[12.5px] text-muted-foreground">
                    {[n.visible_to_student && 'the child', n.parent_notified && 'parents']
                      .filter(Boolean).join(', ') || 'staff only'}
                  </Td>
                  <Td className="text-muted-foreground">{n.recorded_by ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
