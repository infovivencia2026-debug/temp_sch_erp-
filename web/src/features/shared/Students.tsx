import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { api, type Page, type Student, type List, type Section } from '@/lib/api'
import {
  Card, CardHeader, Table, Td, Badge, Button, Input, Select, Skeleton, ErrorState,
} from '@/components/ui'
import { ExportRows } from '@/components/rows'
import { cn, formatDate } from '@/lib/utils'
import StudentProfile from './StudentProfile'

const PAGE = 25

export default function Students() {
  const [search, setSearch] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [offset, setOffset] = useState(0)
  const [params_, setParams_] = useSearchParams()

  /* Typing a name should not fire a request per keystroke.

     Unthrottled, "Aarav" was five searches, and the table flickered through
     four wrong answers on the way to the right one. A third of a second is
     below the threshold where a pause feels like waiting and above the rate at
     which anyone types. */
  const [typed, setTyped] = useState('')
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(typed)
      setOffset(0)
    }, 300)
    return () => clearTimeout(id)
  }, [typed])

  const openStudent = params_.get('student')

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
  if (search.trim()) params.set('q', search.trim())
  if (sectionId) params.set('section_id', sectionId)

  const { data, isLoading, error, isPlaceholderData } = useQuery({
    queryKey: ['students', params.toString()],
    queryFn: () => api.get<Page<Student>>(`/api/v1/students?${params}`),
    // Keeps the previous page on screen while the next one loads, so paging
    // does not flash an empty table.
    placeholderData: keepPreviousData,
  })

  // A child chosen from the directory opens in place. The directory was a wall
  // of unclickable text: the one thing a school does with it — find a student,
  // open their record — had no path at all.
  //
  // Below the queries, not above them: every hook has to run on every render,
  // and an early return before one is the bug React cannot recover from.
  if (openStudent) return <StudentProfile />
  if (error) return <ErrorState error={error} />

  const rows = data?.items ?? []

  return (
    <Card>
      <CardHeader
        title="Students"
        description={data ? `${data.total} record${data.total === 1 ? '' : 's'}` : undefined}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={typed}
              onChange={setTyped}
              placeholder="Name or admission no."
            />
            <Select
              value={sectionId}
              onChange={(v) => { setSectionId(v); setOffset(0) }}
              placeholder="All sections"
              options={(sections.data?.items ?? []).map((s) => ({
                value: s.id, label: `${s.class_name}-${s.name}`,
              }))}
            />
            {/* What is on screen, which for a paged list is this page. Said on
                the button rather than left for somebody to discover when a
                class of sixty comes out as fifty. */}
            <ExportRows
              rows={rows}
              name="students"
              label={data && data.total > rows.length ? 'Export this page' : 'Export'}
              columns={[
                { header: 'Admission no', value: (s) => s.admission_no },
                { header: 'Name', value: (s) => s.full_name },
                { header: 'Class', value: (s) => s.class_name },
                { header: 'Section', value: (s) => s.section_name },
                { header: 'Roll', value: (s) => s.roll_no },
                { header: 'Gender', value: (s) => s.gender },
                { header: 'Date of birth', value: (s) => s.date_of_birth },
                { header: 'Admitted', value: (s) => s.admission_date },
                { header: 'Status', value: (s) => s.status },
              ]}
            />
          </div>
        }
      />

      {isLoading ? <Skeleton /> : (
        <Table
          head={['Admission no.', 'Name', 'Class', 'Roll', 'Admitted', 'Status', '']}
          empty={rows.length === 0}
          emptyLabel={
            search.trim() || sectionId
              ? 'No student matches that search. Try an admission number, or clear the filters.'
              : 'No students yet. Admit one, or import a spreadsheet from Setup.'
          }
        >
          {rows.map((s) => (
            <tr
              key={s.id}
              onClick={() => setParams_({ student: s.id })}
              className={cn(
                'cursor-pointer transition-colors duration-150 hover:bg-accent',
                isPlaceholderData && 'opacity-60',
              )}
            >
              <Td className="font-mono text-xs">{s.admission_no}</Td>
              <Td className="font-medium">{s.full_name}</Td>
              <Td>{s.class_name ? `${s.class_name}-${s.section_name ?? '?'}` : '—'}</Td>
              <Td className="tabular-nums">{s.roll_no ?? '—'}</Td>
              <Td>{formatDate(s.admission_date)}</Td>
              <Td>
                <Badge tone={s.status === 'active' ? 'success' : 'neutral'}>{s.status}</Badge>
              </Td>
              <Td className="text-right">
                <ChevronRight className="inline h-4 w-4 text-muted-foreground" />
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {data && data.total > PAGE && (
        <div className="flex items-center justify-between border-t px-4 py-2.5 text-sm">
          <span className="text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Previous
            </Button>
            <Button variant="ghost" disabled={!data.has_more} onClick={() => setOffset(offset + PAGE)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
