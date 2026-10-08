import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { BentoError, BentoLoading, useFeatureHref, type CellSpan } from './bento-kit'
import { Facts, PersonaCard, PersonaPage, Say, useShape } from './persona-kit'
import { Widget } from './WidgetLayer'

/* THE TRUSTEE'S BOARD.

   Every other role opens Focus onto cells; the board opened onto a row of
   plain tiles, because no bento board was ever registered against
   board_member.home.where_the_money_goes. A trustee is the one person who
   looks at the school for five minutes a month, which is exactly who a board
   of large figures is for.

   Four cells, from the one payload the board screen already reads
   (/board/money): what came in, what is still owed, what went out in
   salaries, and the campuses those three are spread across. Nothing is
   derived from a figure the payload does not carry -- the overdue share is
   the server's own overdue_paise against its own outstanding_paise, not a
   guess from due dates this screen cannot see.

   The money is shown in whole rupees. A trustee asking "what are we owed"
   is not helped by 32 paise, and the exact figure is one press away on the
   screen behind the cell. */

interface CampusMoney {
  campus_id: string | null
  campus: string
  collected_paise: number
  outstanding_paise: number
  overdue_paise: number
  payroll_paise: number
  students: number
  staff: number
}
interface BoardMoney { campuses: CampusMoney[]; total: CampusMoney }

/** Whole rupees, grouped the Indian way: 7,35,835 rather than 735,835. */
const rupees = (paise: number) =>
  '₹' + Math.round((paise ?? 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })

export default function TrusteeBoard() {
  const q = useQuery({
    queryKey: ['board', 'money', 'bento'],
    queryFn: () => api.get<BoardMoney>('/api/v1/board/money'),
  })
  const toMoney = useFeatureHref('board_member.home.where_the_money_goes')
  const toDues = useFeatureHref('board_member.money.collections_dues')
  const toReports = useFeatureHref('board_member.reports.reports')

  if (q.isLoading) return <BentoLoading message="Adding up the campuses…" />
  if (q.error) return <BentoError message={String(q.error)} />

  const total = q.data?.total
  const campuses = q.data?.campuses ?? []
  if (!total) return <BentoError message="The board figures came back empty." />

  return (
    <PersonaPage eyebrow="Home" title="Where the money goes" dashboard="trustee">
      <Widget id="collected" label="Collected" size="small" index={0}>
        {(span) => <CollectedCell span={span} total={total} to={toMoney} />}
      </Widget>
      <Widget id="owed" label="Still owed" size="large" index={1}>
        {(span) => <OwedCell span={span} total={total} to={toDues} />}
      </Widget>
      <Widget id="salaries" label="Salaries" size="small" index={2}>
        {(span) => <SalariesCell span={span} total={total} to={toReports} />}
      </Widget>
      <Widget id="campuses" label="By campus" size="small" index={3}>
        {(span) => <CampusCell span={span} campuses={campuses} to={toMoney} />}
      </Widget>
    </PersonaPage>
  )
}

function CollectedCell({ span, total, to }: { span: CellSpan; total: CampusMoney; to?: string }) {
  return (
    <PersonaCard
      span={span}
      ground="money"
      title="Collected"
      glyph="₹"
      value={rupees(total.collected_paise)}
      change={`${total.students} students · ${total.staff} staff`}
      to={to}
      cueLabel="Open where the money goes"
    >
      <Say>What has actually come in, every campus together.</Say>
    </PersonaCard>
  )
}

function OwedCell({ span, total, to }: { span: CellSpan; total: CampusMoney; to?: string }) {
  const { tall } = useShape()
  const owed = total.outstanding_paise ?? 0
  const overdue = total.overdue_paise ?? 0
  /* The share past its due date, which is the half of "owed" that is a
     problem rather than a timetable. */
  const share = owed > 0 ? Math.round((overdue / owed) * 100) : 0
  return (
    <PersonaCard
      span={span}
      ground="danger"
      title="Still owed"
      glyph="!"
      value={rupees(owed)}
      change={overdue > 0 ? `${rupees(overdue)} of it past due` : 'None of it past due'}
      to={to}
      cueLabel="Open collections and dues"
    >
      {owed === 0 ? (
        <Say>Every bill raised has been paid.</Say>
      ) : (
        <Facts
          srLabel="What is owed, and how much of it is late"
          items={[
            { label: 'Past due', value: `${share}%` },
            { label: 'Collected', value: rupees(total.collected_paise) },
            ...(tall ? [{ label: 'Salaries paid', value: rupees(total.payroll_paise) }] : []),
          ]}
        />
      )}
    </PersonaCard>
  )
}

function SalariesCell({ span, total, to }: { span: CellSpan; total: CampusMoney; to?: string }) {
  return (
    <PersonaCard
      span={span}
      ground="people"
      title="Salaries paid"
      glyph="↑"
      value={rupees(total.payroll_paise)}
      change={`${total.staff} on the payroll`}
      to={to}
      cueLabel="Open reports"
    >
      <Say>What went out in pay over the period.</Say>
    </PersonaCard>
  )
}

function CampusCell({ span, campuses, to }: { span: CellSpan; campuses: CampusMoney[]; to?: string }) {
  const { tall } = useShape()
  const rows = campuses.slice(0, tall ? 6 : 3).map((x) => ({
    label: x.campus,
    value: rupees(x.collected_paise),
  }))
  return (
    <PersonaCard
      span={span}
      ground="academics"
      title="By campus"
      glyph="◈"
      value={campuses.length}
      change={campuses.length === 1 ? 'One campus' : `${campuses.length} campuses`}
      to={to}
      cueLabel="Open where the money goes"
    >
      {rows.length === 0 ? (
        <Say>No campus has taken any money in this period.</Say>
      ) : (
        <Facts items={rows} srLabel="What each campus collected" />
      )}
    </PersonaCard>
  )
}
