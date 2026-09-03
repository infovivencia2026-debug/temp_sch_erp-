import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, SkeletonTable, ErrorState, PrintButton,
} from '@/components/ui'
import { CsvButton, pct, goodPct, impossiblePct, RefusedPctNotice } from './shared'

/**
 * Performance analytics — how classes and children move across exams.
 *
 * Complements exam grade analytics rather than repeating it: that screen
 * counts grades inside one exam, this one follows the same classes from exam
 * to exam, which is the only view that shows a class sliding two terms
 * running.
 *
 * Percentages are computed against the paper's own maximum, absentees are
 * excluded rather than scored zero, and the distribution is banded by
 * percentage rather than by letter — a school may run several grading scales
 * and an "A" from one is not an "A" from another.
 */

interface TrendRow {
  exam_id: string; exam_name: string; exam_date?: string; class_name: string
  students: number; avg_pct?: number; pass_pct?: number
}
interface SubjectRow {
  subject: string; code: string; papers: number; students: number
  avg_pct?: number; pass_pct?: number; failing: number; absent_pct?: number
}
interface BandRow { band: string; students: number; mark_entries: number; share_pct?: number }
interface AtRiskRow {
  student_id: string; admission_no: string; full_name: string
  class_name: string; section_name: string
  subjects_assessed: number; subjects_failing: number
  avg_pct?: number; attendance_pct?: number
}

const TREND = '/api/v1/rollups/performance/trend'
const SUBJECTS = '/api/v1/rollups/performance/subjects'
const DISTRIBUTION = '/api/v1/rollups/performance/distribution'
const AT_RISK = '/api/v1/rollups/performance/at-risk'

export default function PerformanceAnalytics() {
  const trend = useQuery({
    queryKey: ['rollup-perf-trend'],
    queryFn: () => api.get<List<TrendRow>>(TREND),
  })
  const subjects = useQuery({
    queryKey: ['rollup-perf-subjects'],
    queryFn: () => api.get<List<SubjectRow>>(SUBJECTS),
  })
  const bands = useQuery({
    queryKey: ['rollup-perf-distribution'],
    queryFn: () => api.get<List<BandRow>>(DISTRIBUTION),
  })
  const atRisk = useQuery({
    queryKey: ['rollup-perf-at-risk'],
    queryFn: () => api.get<List<AtRiskRow>>(AT_RISK),
  })

  const subjectRows = subjects.data?.items ?? []
  const weakest = subjectRows[0]
  const strongest = subjectRows[subjectRows.length - 1]
  const risky = atRisk.data?.items ?? []

  /* Every average on this page that `pct` will refuse, counted so the notice
     below can say how many and why. Averages only: a pass rate and a band
     share are bounded by their own construction, an average taken against a
     paper's maximum is only bounded if the marks respect that maximum. */
  const refused = [
    ...(trend.data?.items ?? []).map((t) => t.avg_pct),
    ...subjectRows.map((s) => s.avg_pct),
    ...risky.map((s) => s.avg_pct),
  ].filter(impossiblePct).length

  return (
    <>
      <PageHead
        eyebrow="Analysis"
        title="Performance analytics"
        description="Trends across exams, subject strengths and weaknesses, the spread of results, and who is falling behind."
        actions={<PrintButton />}
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Exams analysed" value={new Set(trend.data?.items.map((t) => t.exam_id)).size} />
          <Stat
            label="Weakest subject"
            value={weakest?.subject ?? '—'}
            hint={weakest ? pct(weakest.avg_pct) : undefined}
          />
          <Stat
            label="Strongest subject"
            value={strongest?.subject ?? '—'}
            hint={strongest ? pct(strongest.avg_pct) : undefined}
          />
          <Stat label="Students at risk" value={risky.length} hint="Below threshold or failing" />
        </CellGrid>

        <RefusedPctNotice count={refused} />

        <Card>
          <CardHeader
            title="Class performance across exams"
            description="Each class, exam by exam, oldest first."
            action={<CsvButton href={TREND} />}
          />
          {trend.isLoading ? (
            <SkeletonTable columns={6} />
          ) : trend.error ? (
            <ErrorState error={trend.error} />
          ) : (
            <Table
              head={['Exam', 'Date', 'Class', 'Students', 'Average', 'Pass rate']}
              empty={!trend.data?.items.length}
            >
              {(trend.data?.items ?? []).map((t) => (
                <tr key={`${t.exam_id}-${t.class_name}`}>
                  <Td className="font-medium">{t.exam_name}</Td>
                  <Td className="text-muted-foreground">{t.exam_date ?? '—'}</Td>
                  <Td>{t.class_name}</Td>
                  <Td>{t.students}</Td>
                  <Td>{pct(t.avg_pct)}</Td>
                  <Td>
                    <Badge tone={goodPct(t.pass_pct)}>{pct(t.pass_pct)}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Subject strength and weakness"
              description="Weakest first — the order the question is asked in."
              action={<CsvButton href={SUBJECTS} />}
            />
            {subjects.isLoading ? (
              <SkeletonTable columns={5} />
            ) : subjects.error ? (
              <ErrorState error={subjects.error} />
            ) : (
              <Table
                head={['Subject', 'Papers', 'Average', 'Pass rate', 'Failing']}
                empty={!subjectRows.length}
              >
                {subjectRows.map((s) => (
                  <tr key={s.code}>
                    <Td className="font-medium">{s.subject}</Td>
                    <Td>{s.papers}</Td>
                    <Td>{pct(s.avg_pct)}</Td>
                    <Td>
                      <Badge tone={goodPct(s.pass_pct)}>{pct(s.pass_pct)}</Badge>
                    </Td>
                    <Td>{s.failing}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Spread of results"
              description="Banded by percentage, so it compares across grading scales."
              action={<CsvButton href={DISTRIBUTION} />}
            />
            {bands.isLoading ? (
              <SkeletonTable columns={4} />
            ) : bands.error ? (
              <ErrorState error={bands.error} />
            ) : (
              <Table
                head={['Band', 'Students', 'Entries', 'Share']}
                empty={!bands.data?.items.length}
              >
                {(bands.data?.items ?? []).map((b) => (
                  <tr key={b.band}>
                    <Td className="font-medium">{b.band}</Td>
                    <Td>{b.students}</Td>
                    <Td>{b.mark_entries}</Td>
                    <Td>{pct(b.share_pct)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Falling behind"
            description="Below the average threshold, or failing any subject. Attendance sits alongside because it is usually the explanation."
            action={<CsvButton href={AT_RISK} />}
          />
          {atRisk.isLoading ? (
            <SkeletonTable columns={8} />
          ) : atRisk.error ? (
            <ErrorState error={atRisk.error} />
          ) : (
            <Table
              head={[
                'Admission No', 'Student', 'Class', 'Subjects', 'Failing',
                'Average', 'Attendance',
              ]}
              empty={!risky.length}
              emptyLabel="No student is below the threshold or failing a subject."
            >
              {risky.map((s) => (
                <tr key={s.student_id}>
                  <Td className="font-mono text-[12px]">{s.admission_no}</Td>
                  <Td className="font-medium">{s.full_name}</Td>
                  <Td>{`${s.class_name}-${s.section_name}`}</Td>
                  <Td>{s.subjects_assessed}</Td>
                  <Td>
                    {s.subjects_failing > 0 ? (
                      <Badge tone="danger">{s.subjects_failing}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td>{pct(s.avg_pct)}</Td>
                  <Td>
                    <Badge tone={goodPct(s.attendance_pct)}>{pct(s.attendance_pct)}</Badge>
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
