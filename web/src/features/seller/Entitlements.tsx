import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, FormNotice, Loading, ErrorState,
} from '@/components/ui'
import {
  usePlatform, usePlatformSave, rupees, type EntitlementResponse,
} from '../super_admin/platform-lib'

/**
 * Which modules each plan includes, and which each school actually has on.
 *
 * The two are not the same thing and the gap between them is the point of the
 * screen. A module switched on beyond the plan is either a concession somebody
 * granted and forgot, or the renewal conversation — and until now nothing put
 * the two lists side by side, so it was neither.
 *
 * A plan with an empty module list includes everything. That is the convention
 * the seed established so the top plan does not need editing each time a
 * module is added, and it is why "beyond plan" is empty for those schools
 * rather than being every module at once.
 */
export default function Entitlements() {
  const { data, isLoading, error } = usePlatform<EntitlementResponse>('entitlements', '/entitlements')
  const set = usePlatformSave('entitlements', '/entitlements')

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const beyond = data.schools.filter((s) => s.beyond_plan.length > 0)
  const noPlan = data.schools.filter((s) => !s.plan)

  return (
    <>
      <PageHead
        eyebrow="Entitlements"
        title="Module entitlement matrix"
        description="What each plan includes, what each school has switched on, and where the two disagree."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Plans" value={data.plans.length} />
          <Stat label="Schools" value={data.schools.length} />
          <Stat label="On a module beyond their plan" value={beyond.length} />
          <Stat label="On no plan at all" value={noPlan.length} />
        </CellGrid>

        <Card>
          <CardHeader title="Plans" description="An empty module list means the plan includes everything" />
          <Table head={['Code', 'Plan', 'Price', 'Schools', 'Modules included']} empty={!data.plans.length}>
            {data.plans.map((p) => (
              <tr key={p.code}>
                <Td className="font-mono text-[12.5px]">{p.code}</Td>
                <Td className="font-medium">{p.name}</Td>
                <Td>{rupees(p.price_paise)}</Td>
                <Td>{p.schools}</Td>
                <Td>
                  {p.modules.length === 0 ? (
                    <Badge tone="primary">Everything</Badge>
                  ) : (
                    <span className="text-[13px]">{p.modules.join(', ')}</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="The matrix"
            description="A cell is what the school has switched on; a plan that does not cover it is marked"
          />
          <div className="overflow-x-auto">
            <table className="responsive-table w-full text-[14px]">
              <thead>
                <tr>
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">School</th>
                  <th className="px-5 py-2.5 text-left text-[12px] font-medium text-muted-foreground">Plan</th>
                  {data.modules.map((m) => (
                    <th key={m} className="px-3 py-2.5 text-left text-[12px] font-medium text-muted-foreground">
                      {m}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.schools.map((s) => (
                  <tr key={s.institution_id}>
                    <td className="px-5 [padding-block:var(--row-py)] font-medium">{s.school}</td>
                    <td className="px-5 [padding-block:var(--row-py)]">
                      {s.plan_name ?? <span className="text-muted-foreground">None</span>}
                    </td>
                    {data.modules.map((m) => {
                      const on = s.enabled.includes(m)
                      const covered = s.plan_modules.length === 0 || s.plan_modules.includes(m)
                      return (
                        <td key={m} className="px-3 [padding-block:var(--row-py)]">
                          <Button
                            size="sm"
                            variant={on ? 'primary' : 'secondary'}
                            tone={on && !covered ? 'danger' : undefined}
                            disabled={set.isPending}
                            title={
                              on && !covered
                                ? 'Switched on but not included in this plan'
                                : covered
                                  ? 'Included in the plan'
                                  : 'Not included in the plan'
                            }
                            onClick={() =>
                              set.mutate({ institution_id: s.institution_id, module: m, enabled: !on })
                            }
                          >
                            {on ? (covered ? 'On' : 'On — beyond plan') : 'Off'}
                          </Button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {set.isError && (
            <div className="border-t p-5">
              <FormNotice error={set.error} />
            </div>
          )}
        </Card>

        {beyond.length > 0 && (
          <Card>
            <CardHeader
              title="Beyond the plan"
              description="Either a concession worth recording, or the renewal conversation"
            />
            <Table head={['School', 'Plan', 'Modules beyond it']}>
              {beyond.map((s) => (
                <tr key={s.institution_id}>
                  <Td className="font-medium">{s.school}</Td>
                  <Td>{s.plan_name ?? '—'}</Td>
                  <Td>
                    <Badge tone="warning">{s.beyond_plan.join(', ')}</Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  )
}
