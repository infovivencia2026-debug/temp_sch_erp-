import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Loading, ErrorState, PrintButton,
} from '@/components/ui'
import { CsvButton, pct, goodPct, impossiblePct, RefusedPctNotice } from './shared'

/**
 * Department academics — what each department owns and how it is doing.
 *
 * Worth knowing where a "department's subjects" come from, because the schema
 * has no edge for it: subjects carry no department, and the only link that
 * exists is on the teacher's employee record. So a department's subjects are
 * the subjects its teachers are assigned to teach. That is stated on the
 * screen rather than left for somebody to infer from a number that looks
 * lower than they expected.
 *
 * A head of department sees their own row; a principal sees every one. The
 * narrowing happens on the server, not here.
 */

interface DeptRow {
  department_id: string; name: string; head?: string
  teachers: number; subjects: number; sections: number; weekly_periods: number
  syllabus_units_planned: number; syllabus_units_delivered: number
  syllabus_coverage_pct?: number; avg_score_pct?: number; pass_pct?: number
}

const URL = '/api/v1/rollups/departments/academics'

export default function DepartmentAcademics() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['rollup-dept-academics'],
    queryFn: () => api.get<List<DeptRow>>(URL),
  })

  const rows = data?.items ?? []
  const teachers = rows.reduce((a, r) => a + r.teachers, 0)
  const periods = rows.reduce((a, r) => a + r.weekly_periods, 0)
  const planned = rows.reduce((a, r) => a + r.syllabus_units_planned, 0)
  const done = rows.reduce((a, r) => a + r.syllabus_units_delivered, 0)
  const coverage = planned ? Math.round((1000 * done) / planned) / 10 : undefined
  // Department averages `pct` will refuse, so the notice can explain the dash.
  const refused = rows.map((r) => r.avg_score_pct).filter(impossiblePct).length

  return (
    <>
      <PageHead
        eyebrow="Department"
        title="Department academics"
        description="Subjects, teachers, classes taught, syllabus coverage against plan, and result performance."
        actions={
          <div className="flex gap-2">
            <CsvButton href={URL} />
            <PrintButton />
          </div>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Departments" value={rows.length} />
          <Stat label="Teaching staff" value={teachers} />
          <Stat label="Periods a week" value={periods} />
          <Stat
            label="Syllabus covered"
            value={pct(coverage)}
            hint={`${done} of ${planned} units delivered`}
          />
        </CellGrid>

        <RefusedPctNotice count={refused} />

        <Card>
          <CardHeader
            title="By department"
            description="A department's subjects and classes are those its teachers are assigned to — the staff record carries the only department link in the schema."
          />
          {isLoading ? (
            <Loading />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <Table
              head={[
                'Department', 'Head', 'Teachers', 'Subjects', 'Sections',
                'Periods/wk', 'Syllabus', 'Average', 'Pass rate',
              ]}
              empty={!rows.length}
              emptyLabel="No department is assigned to you, or none has teaching staff yet."
            >
              {rows.map((d) => (
                <tr key={d.department_id}>
                  <Td className="font-medium">{d.name}</Td>
                  <Td className="text-muted-foreground">{d.head ?? '—'}</Td>
                  <Td>{d.teachers}</Td>
                  <Td>{d.subjects}</Td>
                  <Td>{d.sections}</Td>
                  <Td>{d.weekly_periods}</Td>
                  <Td>
                    <Badge tone={goodPct(d.syllabus_coverage_pct)}>
                      {pct(d.syllabus_coverage_pct)}
                    </Badge>
                    <span className="ml-2 text-[12px] text-muted-foreground">
                      {d.syllabus_units_delivered}/{d.syllabus_units_planned}
                    </span>
                  </Td>
                  <Td>{pct(d.avg_score_pct)}</Td>
                  <Td>
                    <Badge tone={goodPct(d.pass_pct)}>{pct(d.pass_pct)}</Badge>
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
