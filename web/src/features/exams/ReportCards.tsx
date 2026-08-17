import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List, type Section } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Select, Loading, ErrorState,
} from '@/components/ui'

interface Exam { id: string; name: string; kind: string; papers: number }

interface Card2 {
  student_id: string; admission_no: string; full_name: string
  total_marks?: number; max_marks?: number; percentage?: number
  grade?: string; rank_in_section?: number; attendance_percent?: number
  is_published: boolean
}

/** Report cards. Totals, percentage, grade and rank are computed for the whole
    section in one pass so ties are consistent. */
export default function ReportCards() {
  const qc = useQueryClient()
  const [sectionId, setSectionId] = useState('')
  const [examId, setExamId] = useState('')

  const exams = useQuery({
    queryKey: ['exam-list'],
    queryFn: () => api.get<List<Exam>>('/api/v1/exams/list'),
  })
  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
  })
  const cards = useQuery({
    queryKey: ['report-cards', sectionId],
    queryFn: () => api.get<List<Card2>>(`/api/v1/exams/report-cards?section_id=${sectionId}`),
    enabled: !!sectionId,
  })
  const generate = useMutation({
    mutationFn: (publish: boolean) =>
      api.post('/api/v1/exams/report-cards/generate', {
        exam_id: examId, section_id: sectionId, publish,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report-cards', sectionId] }),
  })

  const rows = cards.data?.items ?? []
  const published = rows.filter((r) => r.is_published).length
  const avg = rows.length
    ? (rows.reduce((a, r) => a + (r.percentage ?? 0), 0) / rows.length).toFixed(1)
    : '—'

  return (
    <>
      <PageHead
        eyebrow="Examinations"
        title="Report cards"
        description="Generate totals, percentage, grade, rank and attendance for a section."
        actions={
          <>
            <Select value={sectionId} onChange={setSectionId} placeholder="Section"
              options={(sections.data?.items ?? []).map((s) => ({
                value: s.id, label: `${s.class_name}-${s.name}`,
              }))} />
            <Select
              value={examId}
              onChange={setExamId}
              placeholder="Choose an exam"
              options={(exams.data?.items ?? []).map((e) => ({
                value: e.id, label: `${e.name} (${e.papers} papers)`,
              }))}
            />
            <Button disabled={!sectionId || !examId || generate.isPending}
              onClick={() => generate.mutate(false)}>
              {generate.isPending ? 'Generating…' : 'Generate'}
            </Button>
            <Button variant="secondary" disabled={!sectionId || !examId || generate.isPending}
              onClick={() => generate.mutate(true)}>
              Generate & publish
            </Button>
          </>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Report cards" value={rows.length} />
          <Stat label="Published" value={published} hint={`${rows.length - published} draft`} />
          <Stat label="Section average" value={avg !== '—' ? `${avg}%` : '—'} />
          <Stat label="Topper" value={rows.find((r) => r.rank_in_section === 1)?.full_name ?? '—'} />
        </CellGrid>

        <Card>
          <CardHeader title="Results" description="Ranked within the section" />
          {cards.isLoading ? <Loading /> : cards.error ? <ErrorState error={cards.error} /> : (
            <Table head={['Rank', 'Admission no.', 'Student', 'Total', 'Percentage', 'Grade', 'Attendance', 'State']}
              empty={!rows.length} emptyLabel="No report cards generated for this section yet.">
              {rows.map((r) => (
                <tr key={r.student_id}>
                  <Td className="font-medium">{r.rank_in_section ?? '—'}</Td>
                  <Td className="font-mono text-[12px]">{r.admission_no}</Td>
                  <Td className="font-medium">{r.full_name}</Td>
                  <Td>{r.total_marks ?? '—'}{r.max_marks ? ` / ${r.max_marks}` : ''}</Td>
                  <Td>{r.percentage != null ? `${r.percentage}%` : '—'}</Td>
                  <Td>{r.grade ? <Badge tone="primary">{r.grade}</Badge> : '—'}</Td>
                  <Td>
                    {r.attendance_percent != null && (
                      <Badge tone={r.attendance_percent < 75 ? 'danger' : 'success'}>
                        {r.attendance_percent}%
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={r.is_published ? 'success' : 'neutral'}>
                      {r.is_published ? 'published' : 'draft'}
                    </Badge>
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
