import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Loading, ErrorState, UnavailableState,
} from '@/components/ui'
import { usePlatform, type HealthResponse, type QueueStat } from '../super_admin/platform-lib'

/**
 * What is going wrong inside each school, before the school telephones.
 *
 * Every column is measured from the database, which is the only place this
 * installation keeps a durable record of anything failing: a payment gateway
 * that stopped answering, messages that never went out, payments the bank
 * refused, and whether anybody has taken the register today.
 *
 * Per-endpoint error rates and response times are not here, and the screen
 * says so rather than showing a number it does not have. They go to the
 * structured log and nothing reads them back.
 */
export default function InstanceHealth() {
  const { data, isLoading, error } = usePlatform<HealthResponse>('health', '/health')

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const concerned = data.items.filter((r) => r.concerns > 0)
  const noRegister = data.items.filter((r) => r.attendance_marked_today === 0)
  const queues = Object.entries(data.queues).filter(
    (e): e is [string, QueueStat] => typeof e[1] !== 'string',
  )
  const queueError = Object.entries(data.queues).find(([, v]) => typeof v === 'string')

  return (
    <>
      <PageHead
        eyebrow="Usage & Health"
        title="Instance health"
        description="Failing integrations, undelivered messages and refused payments per tenant, plus the job queues."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Schools" value={data.items.length} />
          <Stat label="With something wrong" value={concerned.length} />
          <Stat
            label="Register not taken today"
            value={noRegister.length}
            hint="The signal that most reliably precedes a support call"
          />
          <Stat
            label="Queued jobs"
            value={queues.reduce((n, [, q]) => n + q.size, 0)}
            hint={queueError ? 'Queue is unreachable' : 'Across every queue'}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="By school"
            description="Worst first. A blank row is a school with nothing measurable going wrong."
          />
          <Table
            head={[
              'School', 'Integrations', 'Messages failed (24h)', 'Payments failed (24h)',
              'Open tickets', 'Register today', 'Sign-ins (24h)',
            ]}
            empty={!data.items.length}
            emptyLabel="No active schools on this installation."
          >
            {[...data.items]
              .sort((a, b) => b.concerns - a.concerns)
              .map((r) => (
                <tr key={r.institution_id}>
                  <Td className="font-medium">{r.school}</Td>
                  <Td>
                    {r.integrations_failing > 0 ? (
                      <>
                        <Badge tone="danger">
                          {r.integrations_failing} of {r.integrations_enabled} failing
                        </Badge>
                        <span className="block text-[12px] text-muted-foreground">
                          {r.failing_providers.join(', ')}
                        </span>
                      </>
                    ) : r.integrations_enabled > 0 ? (
                      <Badge tone="success">{r.integrations_enabled} healthy</Badge>
                    ) : (
                      <span className="text-muted-foreground">None configured</span>
                    )}
                  </Td>
                  <Td>
                    {r.messages_failed_24h > 0 ? (
                      <Badge tone="warning">{r.messages_failed_24h}</Badge>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>
                    {r.payments_failed_24h > 0 ? (
                      <Badge tone="danger">{r.payments_failed_24h}</Badge>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>{r.open_vendor_tickets || '—'}</Td>
                  <Td>
                    {r.attendance_marked_today > 0 ? (
                      <Badge tone="success">{r.attendance_marked_today} marked</Badge>
                    ) : (
                      <Badge tone="warning">Not taken</Badge>
                    )}
                  </Td>
                  <Td>{r.sessions_24h}</Td>
                </tr>
              ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="Job queues"
            description="One Redis serves every school, so queue depth is per installation and not per tenant"
          />
          {queueError ? (
            <div className="p-5">
              <p className="text-[14px] text-destructive">Queue is unreachable: {queueError[1] as string}</p>
              <p className="mt-1.5 text-[13px] text-muted-foreground">
                The table above is still true — it comes from the database, which is answering.
              </p>
            </div>
          ) : (
            <Table
              head={['Queue', 'Size', 'Pending', 'Active', 'Retrying', 'Failed', 'State']}
              empty={!queues.length}
              emptyLabel="No queues reported."
            >
              {queues.map(([name, q]) => (
                <tr key={name}>
                  <Td className="font-medium">{name}</Td>
                  <Td>{q.size}</Td>
                  <Td>{q.pending}</Td>
                  <Td>{q.active}</Td>
                  <Td>{q.retry || '—'}</Td>
                  <Td>{q.failed ? <Badge tone="danger">{q.failed}</Badge> : '—'}</Td>
                  <Td>{q.paused ? <Badge tone="warning">Paused</Badge> : <Badge tone="success">Running</Badge>}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="What this screen cannot tell you" />
          <div className="p-5">
            <UnavailableState
              title="Error rates and slow endpoints are not measured."
              body={data.not_measured}
              technical={[
                { label: 'Where they go', value: 'slog, one line per request' },
                { label: 'What would be needed', value: 'a metrics store the API writes to and this screen reads' },
              ]}
            />
          </div>
        </Card>
      </PageBody>
    </>
  )
}
