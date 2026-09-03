import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  SkeletonTable, ErrorState,
} from '@/components/ui'
import { usePlatform, type AdoptionResponse } from '../super_admin/platform-lib'

/**
 * Who is actually using the software, school by school and week by week.
 *
 * Counts, never names. The vendor needs to know that a school has stopped
 * using the product, not who in it stopped — and a renewal conversation turns
 * on the share of accounts that are live, not on the headline number. Ninety
 * accounts with six people signing in is a school that has already churned and
 * has not told anybody yet.
 *
 * A school nobody has signed into for a fortnight is counted as at risk,
 * including one where nobody ever has: a rollout that never started is the
 * most expensive kind.
 */
export default function Adoption() {
  const { data, isLoading, error } = usePlatform<AdoptionResponse>('adoption', '/adoption')

  if (isLoading) return <SkeletonTable columns={8} />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const totals = data.items.reduce(
    (a, r) => ({
      accounts: a.accounts + r.accounts,
      active: a.active + r.active_users_28_days,
      changes: a.changes + r.changes_28_days,
    }),
    { accounts: 0, active: 0, changes: 0 },
  )

  return (
    <>
      <PageHead
        eyebrow="Usage & Health"
        title="Adoption metrics"
        description="Sign-ins, active users and recorded work per school per week — the leading indicator of renewal."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Schools" value={data.items.length} />
          <Stat
            label="At risk"
            value={data.at_risk}
            hint="Nobody has signed in for a fortnight"
          />
          <Stat
            label="Active accounts"
            value={`${totals.active} of ${totals.accounts}`}
            period="last 28 days"
          />
          <Stat label="Changes recorded" value={totals.changes} period="last 28 days" />
        </CellGrid>

        <Card>
          <CardHeader
            title="By school"
            description="Quietest first — the order an account manager works the list in"
          />
          <Table
            head={['School', 'Plan', 'Students', 'Accounts', 'Active (28d)', 'Sign-ins', 'Changes', 'Last sign-in']}
            empty={!data.items.length}
            emptyLabel="No active schools on this installation."
          >
            {[...data.items]
              .sort((a, b) => (b.quiet_days ?? 9999) - (a.quiet_days ?? 9999))
              .map((r) => (
                <tr key={r.institution_id}>
                  <Td className="font-medium">{r.school}</Td>
                  <Td>{r.plan ?? <span className="text-muted-foreground">No plan</span>}</Td>
                  <Td>{r.students}</Td>
                  <Td>{r.accounts}</Td>
                  <Td>
                    {r.active_users_28_days}
                    <span className="ml-2 text-[12px] text-muted-foreground">{r.active_percent}%</span>
                  </Td>
                  <Td>{r.sign_ins_28_days}</Td>
                  <Td>{r.changes_28_days}</Td>
                  <Td>
                    {r.last_sign_in == null ? (
                      <Badge tone="danger">Never</Badge>
                    ) : (r.quiet_days ?? 0) >= 14 ? (
                      <Badge tone="warning">{r.quiet_days} days ago</Badge>
                    ) : (
                      r.last_sign_in
                    )}
                  </Td>
                </tr>
              ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="The installation by week"
            description="A missing week is a week with no sign-ins at all, and is shown as a gap rather than as a zero"
          />
          <Table
            head={['Week beginning', 'Sign-ins', 'Distinct users', 'Changes recorded']}
            empty={!data.weeks.length}
            emptyLabel="No sign-ins in the last twelve weeks."
          >
            {data.weeks.map((w) => (
              <tr key={w.week_start}>
                <Td className="font-medium">{w.week_start}</Td>
                <Td>{w.sign_ins}</Td>
                <Td>{w.active_users}</Td>
                <Td>{w.changes}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}
