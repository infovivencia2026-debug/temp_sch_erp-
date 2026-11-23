/* Yajur Connect Settings: read-only. How the school's WhatsApp is set up and
   how messages go out. Changing the connection, the test list or the guard is
   done in the messaging settings, not here. No token or id is ever shown. */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Badge, Button, Card, ErrorState, Loading } from '@/components/ui'
import { useConnectOverview } from './ConnectOverview'

const CONNECTION: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; detail: string }> = {
  ready: { label: 'Connected', tone: 'success', detail: 'The school number and its access are stored. Messages go out through WhatsApp.' },
  incomplete: { label: 'Not finished', tone: 'warning', detail: 'The WhatsApp number or its access is missing. Messages cannot go out until it is completed.' },
  off: { label: 'Switched off', tone: 'danger', detail: 'WhatsApp is set up but switched off. No messages go out.' },
  not_set_up: { label: 'Not set up', tone: 'neutral', detail: 'No WhatsApp number is connected yet.' },
}

function Box({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col gap-2 p-[var(--card-pad)]">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <div className="min-w-0 text-sm">{children}</div>
      {action && <div className="mt-auto pt-2">{action}</div>}
    </Card>
  )
}

export default function ConnectSettings({ goRules }: { goRules: () => void }) {
  const ov = useConnectOverview()
  // Needs the send permission; without it only the count from the overview shows.
  const tests = useQuery({
    queryKey: ['connect', 'test-numbers'], retry: false,
    queryFn: () => api.call('GET /comms/yajur-connect/send/test-numbers'),
  })
  if (ov.isLoading) return <Loading />
  if (ov.error || !ov.data) return <ErrorState error={ov.error} onRetry={() => ov.refetch()} />
  const d = ov.data
  const conn = CONNECTION[d.connection] ?? CONNECTION.not_set_up
  const list = tests.data?.items ?? []

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-2xl font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground">The school's WhatsApp number and how messages go out.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Box title="WhatsApp connection">
          <div className="mb-1"><Badge tone={conn.tone}>{conn.label}</Badge></div>
          <p className="text-muted-foreground">{conn.detail}</p>
        </Box>

        <Box title="Who can receive messages">
          <div className="mb-1"><Badge tone={d.guard_on ? 'warning' : 'success'}>{d.guard_on ? 'Test list only' : 'All parents'}</Badge></div>
          <p className="text-muted-foreground">
            {d.guard_on
              ? 'Messages go only to the numbers on the test list. Messages to anyone else are held back.'
              : 'Messages go to every parent chosen. Parents who opted out are skipped.'}
          </p>
        </Box>

        <Box title="Test numbers">
          {list.length > 0
            ? <ul className="flex flex-col gap-1">
                {list.map((t) => (
                  <li key={t.id} className="truncate"><span className="tabular-nums">{t.phone}</span>{t.label && <span className="text-muted-foreground">{` (${t.label})`}</span>}</li>
                ))}
              </ul>
            : <p className="text-muted-foreground">
                {d.test_numbers === 0 ? 'No test numbers yet.' : `${d.test_numbers} ${d.test_numbers === 1 ? 'number' : 'numbers'} on the test list.`}
              </p>}
        </Box>

        <Box title="Auto-replies" action={<Button variant="secondary" size="sm" onClick={goRules}>Manage</Button>}>
          <p className="text-muted-foreground">
            {d.autoreplies.total === 0
              ? 'No auto-replies yet.'
              : `${d.autoreplies.total} ${d.autoreplies.total === 1 ? 'rule' : 'rules'}, ${d.autoreplies.enabled} on. A parent's message with a set keyword gets the set reply.`}
          </p>
        </Box>

        <Box title="24-hour reply rule">
          <p className="text-muted-foreground">
            After a parent writes, you can reply in your own words for 24 hours. After that, WhatsApp only allows an approved template until the parent writes again.
          </p>
        </Box>
      </div>
    </div>
  )
}
