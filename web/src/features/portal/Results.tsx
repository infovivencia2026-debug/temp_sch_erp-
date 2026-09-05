import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Award, GraduationCap } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  Select, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import CardViewer from '@/components/CardViewer'

/* Results, as a family sees them.

   The catalogue's "Exams & grades" and "Results & report cards" both opened
   the staff report-card generator, which 403s a parent on its first call. This
   is the same data from the other side: the cards the school has published,
   and the subject marks behind them.

   Nothing provisional appears. A report card exists from the moment marks are
   entered and stays wrong until the exam controller has checked it; a parent
   who sees a rank that later changes has been told something the school did
   not mean to say. */

interface Card_ {
  id: string
  exam: string
  term?: string
  total_marks?: number
  max_marks?: number
  percentage?: number
  grade?: string
  gpa?: number
  rank_in_section?: number
  attendance_percent?: number
  class_teacher_remarks?: string
  published_at?: string
}
interface SubjectMark {
  exam: string
  subject: string
  marks_obtained?: number
  max_marks?: number
  grade?: string
  is_absent: boolean
}
interface ResultView {
  student_id: string
  cards: Card_[]
  subjects: SubjectMark[]
  published: boolean
}
interface Child {
  student_id: string
  full_name: string
  class_name?: string
  section_name?: string
}

export default function PortalResults() {
  const t = useT()
  const children = useQuery({
    queryKey: ['portal-children'],
    queryFn: () => api.get<List<Child>>('/api/v1/portal/students'),
  })
  const kids = children.data?.items ?? []
  const [picked, setPicked] = useState('')
  /* The card itself, full screen. Read by scaling it to fit rather than by
     dragging a 190mm sheet sideways inside a phone-width panel. */
  const [card, setCard] = useState<{ html: string; css?: string; name?: string } | null>(null)
  const child = picked || kids[0]?.student_id || ''

  const results = useQuery({
    queryKey: ['portal-results', child],
    queryFn: () => api.get<ResultView>(`/api/v1/portal/results?student_id=${child}`),
    enabled: !!child,
  })
  const { data, isLoading, error } = results

  /* A failed children request used to be indistinguishable from a slow one:
     `!child` held the spinner forever because the results query never starts
     without a child, and a query that never starts never stops being pending.
     A parent is owed the reason. */
  if (children.isLoading) return <ScreenSkeleton />
  if (children.error && !children.data) return <ScreenError error={children.error} />
  if (!kids.length)
    return (
      <>
        <PageHead eyebrow={t('portal.results.eyebrow')} title={t('portal.results.title')} />
        <PageBody>
          <EmptyState
            title={t('portal.results.no_child_title')}
            body={t('portal.results.no_child_body')}
          />
        </PageBody>
      </>
    )
  if (isLoading) return <ScreenSkeleton />
  if (error && !data) return <ScreenError error={error} />
  if (!data)
    return (
      <>
        <PageHead eyebrow={t('portal.results.eyebrow')} title={t('portal.results.title')} />
        <PageBody>
          <EmptyState
            title={t('portal.results.none_title')}
            body={t('portal.results.none_body')}
          />
        </PageBody>
      </>
    )
  const d = data
  const latest = d.cards[0]
  const name = kids.find((k) => k.student_id === child)?.full_name ?? ''

  // Grouped by exam so a term reads as one block rather than as a flat list
  // of every subject the child has ever sat.
  const byExam = new Map<string, SubjectMark[]>()
  for (const m of d.subjects) {
    byExam.set(m.exam, [...(byExam.get(m.exam) ?? []), m])
  }

  return (
    <>
      {card && <CardViewer card={card} onClose={() => setCard(null)} />}
      <PageHead
        eyebrow={t('portal.results.eyebrow')}
        title={d.published ? t('portal.results.published_title') : t('portal.results.none_title')}
        description={
          d.published
            ? t('portal.results.published_description', { name })
            : t('portal.results.none_body')
        }
        actions={
          kids.length > 1 && (
            <Select
              value={child}
              onChange={setPicked}
              options={kids.map((k) => ({
                value: k.student_id,
                label: `${k.full_name}${k.class_name ? ` · ${k.class_name}-${k.section_name ?? ''}` : ''}`,
              }))}
            />
          )
        }
      />
      <Freshness query={results} />
      <PageBody>
        {latest && (
          <CellGrid cols={4}>
            <Stat
              label={t('portal.results.stat_latest')}
              value={latest.percentage != null ? `${latest.percentage.toFixed(1)}%` : '—'}
              icon={GraduationCap}
              hint={latest.term ?? latest.exam}
            />
            <Stat label={t('portal.results.stat_grade')} value={latest.grade ?? '—'} icon={Award} />
            <Stat
              label={t('portal.results.stat_rank')}
              value={latest.rank_in_section ?? '—'}
              hint={
                latest.gpa != null
                  ? t('portal.results.gpa', { value: latest.gpa.toFixed(1) })
                  : undefined
              }
            />
            <Stat
              label={t('portal.results.stat_attendance')}
              value={latest.attendance_percent != null ? `${Math.round(latest.attendance_percent)}%` : '—'}
              hint={t('portal.results.stat_attendance_hint')}
            />
          </CellGrid>
        )}

        <Card>
          <CardHeader
            title={t('portal.results.cards_title')}
            description={t('portal.results.cards_description')}
          />
          {d.cards.length === 0 ? (
            <EmptyState
              title={t('portal.results.cards_empty_title')}
              body={t('portal.results.cards_empty_body')}
            />
          ) : (
            <Table
              head={[
                t('portal.results.col_term'),
                t('portal.results.col_total'),
                t('portal.results.col_percentage'),
                t('portal.results.col_grade'),
                t('portal.results.col_rank'),
                t('portal.results.col_published'),
                '',
              ]}
            >
              {d.cards.map((c, i) => (
                <tr key={i}>
                  <Td className="font-medium">{c.term ?? c.exam}</Td>
                  <Td className="tabular-nums">
                    {c.total_marks != null ? `${c.total_marks} / ${c.max_marks ?? '—'}` : '—'}
                  </Td>
                  <Td className="tabular-nums">
                    {c.percentage != null ? `${c.percentage.toFixed(1)}%` : '—'}
                  </Td>
                  <Td>{c.grade ? <Badge tone="primary">{c.grade}</Badge> : '—'}</Td>
                  <Td className="tabular-nums">{c.rank_in_section ?? '—'}</Td>
                  <Td className="text-muted-foreground">{formatDate(c.published_at)}</Td>
                  <Td>
                    {/* The document with the crest on it, not this table.

                        A family asking for "the report card" means the sheet
                        the school issues, on the school's own design — the
                        figures here are the summary, and the card is the
                        thing they keep and print. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const v = await api.get<{ html: string; css?: string }>(
                          `/api/v1/portal/results/card?id=${c.id}`)
                        setCard({ ...v, name: c.term ?? c.exam })
                      }}
                    >
                      Open the card
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          {latest?.class_teacher_remarks && (
            <p className="border-t px-5 py-3 text-[14px]">
              <span className="eyebrow mr-2">{t('portal.results.class_teacher')}</span>
              {latest.class_teacher_remarks}
            </p>
          )}
        </Card>

        {[...byExam.entries()].map(([exam, marks]) => (
          <Card key={exam}>
            <CardHeader
              title={exam}
              description={t('portal.results.subject_count', { count: marks.length })}
            />
            <Table
              head={[
                t('portal.results.col_subject'),
                t('portal.results.col_marks'),
                t('portal.results.col_out_of'),
                t('portal.results.col_subject_grade'),
              ]}
            >
              {marks.map((m, i) => (
                <tr key={i}>
                  <Td className="font-medium">{m.subject}</Td>
                  <Td className="tabular-nums">
                    {m.is_absent ? <Badge tone="danger">{t('portal.results.absent')}</Badge> : (m.marks_obtained ?? '—')}
                  </Td>
                  <Td className="tabular-nums">{m.max_marks ?? '—'}</Td>
                  <Td>{m.grade ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        ))}
      </PageBody>
    </>
  )
}
