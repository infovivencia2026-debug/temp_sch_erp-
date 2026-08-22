import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

/* Your own pay, without asking the office.
 *
 * Payroll had one screen: the payroll office's list of everybody, behind a
 * permission nobody outside HR and accounts holds. So the people the payslips
 * are about could not read their own — "did I get my full salary this month"
 * meant walking to the office and having somebody look it up for you, which is
 * a question a person is entitled to answer themselves.
 *
 * Three questions and no others: what was I paid and what was taken off, how
 * much of that was tax, and how many days was I here. Everyone on the staff
 * roll gets it — the principal, the head of department, the clerk in accounts
 * and the teacher — because everybody is paid.
 */

interface Payslip {
  period_month: number
  period_year: number
  paid_days: string
  lop_days: string
  gross_paise: number
  deduction_paise: number
  net_paise: number
  breakup: Record<string, unknown> | null
  locked: boolean
}

interface Balance {
  leave_type: string
  entitled: string
  used: string
  remaining: string
}

interface MyPay {
  employee_code?: string
  payslips: Payslip[]
  attendance: { present: number; absent: number; late: number; on_leave: number; days_marked: number }
  leave_balances: Balance[]
  note?: string
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/* Which lines of the breakup are money taken off.
 *
 * Payroll stores the breakup as whatever the salary structure named its
 * components, so the names differ from school to school. Matching on the words
 * every Indian payslip uses is a guess, but the alternative is showing tax
 * beside basic pay as though they pulled the same direction. Anything not
 * recognised is still shown — under earnings, where a positive number belongs.
 */
const DEDUCTION_WORDS = /\b(tax|tds|pf|provident|esi|esic|deduct|loan|advance|recovery|lop|professional)\b/i

function lines(breakup: Payslip['breakup']) {
  const earnings: [string, number][] = []
  const deductions: [string, number][] = []
  if (!breakup || typeof breakup !== 'object') return { earnings, deductions }
  for (const [k, v] of Object.entries(breakup)) {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n) || n === 0) continue
    if (DEDUCTION_WORDS.test(k)) deductions.push([k, Math.abs(n)])
    else earnings.push([k, Math.abs(n)])
  }
  return { earnings, deductions }
}

// The keys are column names — basic_paise, hra_paise — and nobody reads a
// payslip in snake case.
const label = (k: string) =>
  k.replace(/_paise$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

const TAX_WORDS = /\b(tax|tds|professional)\b/i

export default function MyPay() {
  const q = useQuery({ queryKey: ['my-pay'], queryFn: () => api.get<MyPay>('/api/v1/me/pay') })

  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data!

  const latest = d.payslips[0]

  // Tax to date, added up across this year's payslips. The figure a person
  // actually wants at the end of the year, and no screen was giving it.
  const taxThisYear = latest
    ? d.payslips
        .filter((p) => p.period_year === latest.period_year)
        .reduce(
          (sum, p) =>
            sum +
            lines(p.breakup)
              .deductions.filter(([k]) => TAX_WORDS.test(k))
              .reduce((a, [, v]) => a + v, 0),
          0,
        )
    : 0

  const breakup = latest ? lines(latest.breakup) : { earnings: [], deductions: [] }

  return (
    <>
      <PageHead
        title="My pay"
        description={
          d.employee_code
            ? `Your payslips, tax and attendance · ${d.employee_code}`
            : 'Your payslips, tax and attendance'
        }
      />
      <PageBody>
        {d.note && <EmptyState title={d.note} />}

        {latest && (
          <Card>
            <CardHeader
              title={`${MONTHS[latest.period_month - 1]} ${latest.period_year}`}
              description={
                latest.locked
                  ? 'Final.'
                  : 'The office has not closed this month yet, so these figures can still change.'
              }
            />
            <CellGrid>
              <Stat label="Take-home" value={formatPaise(latest.net_paise)} />
              <Stat label="Gross" value={formatPaise(latest.gross_paise)} />
              <Stat label="Deductions" value={formatPaise(latest.deduction_paise)} />
              <Stat label="Days paid" value={latest.paid_days} />
              {Number(latest.lop_days) > 0 && (
                <Stat label="Loss of pay" value={`${latest.lop_days} days`} />
              )}
              {taxThisYear > 0 && (
                <Stat
                  label={`Tax deducted in ${latest.period_year}`}
                  value={formatPaise(taxThisYear)}
                />
              )}
            </CellGrid>
          </Card>
        )}

        {(breakup.earnings.length > 0 || breakup.deductions.length > 0) && (
          <Card>
            <CardHeader title="What made up that figure" />
            <Table head={['', 'Amount']}>
              {breakup.earnings.map(([k, v]) => (
                <tr key={k}>
                  <Td>{label(k)}</Td>
                  <Td>{formatPaise(v)}</Td>
                </tr>
              ))}
              {breakup.deductions.map(([k, v]) => (
                <tr key={k}>
                  <Td>{label(k)}</Td>
                  {/* Written as a subtraction, because that is what it is. A
                      column of positive numbers that quietly means the
                      opposite is how somebody reads their payslip wrong. */}
                  <Td>− {formatPaise(v)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {d.payslips.length > 1 && (
          <Card>
            <CardHeader title="Earlier months" />
            <Table head={['Month', 'Days paid', 'Gross', 'Deductions', 'Take-home', '']}>
              {d.payslips.slice(1).map((p) => (
                <tr key={`${p.period_year}-${p.period_month}`}>
                  <Td>
                    {MONTHS[p.period_month - 1]} {p.period_year}
                  </Td>
                  <Td>{p.paid_days}</Td>
                  <Td>{formatPaise(p.gross_paise)}</Td>
                  <Td>{formatPaise(p.deduction_paise)}</Td>
                  <Td>{formatPaise(p.net_paise)}</Td>
                  <Td>{!p.locked && <Badge tone="warning">not final</Badge>}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card>
          <CardHeader
            title="My attendance"
            description={
              d.attendance.days_marked
                ? `${d.attendance.days_marked} days marked this year.`
                : 'Nobody has marked the staff register yet, so there is nothing to count.'
            }
          />
          {d.attendance.days_marked > 0 && (
            <CellGrid>
              <Stat label="Present" value={d.attendance.present} />
              <Stat label="Absent" value={d.attendance.absent} />
              <Stat label="Late" value={d.attendance.late} />
              <Stat label="On leave" value={d.attendance.on_leave} />
            </CellGrid>
          )}
        </Card>

        {d.leave_balances.length > 0 && (
          <Card>
            <CardHeader title="Leave left" description="Apply on Leave & self service." />
            <Table head={['Type', 'Entitled', 'Taken', 'Left']}>
              {d.leave_balances.map((b) => (
                <tr key={b.leave_type}>
                  <Td>{b.leave_type}</Td>
                  <Td>{b.entitled}</Td>
                  <Td>{b.used}</Td>
                  <Td>{b.remaining}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  )
}
