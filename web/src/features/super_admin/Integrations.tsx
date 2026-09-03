import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  Badge,
  Card,
  CardHeader,
  CellGrid,
  ErrorState,
  Input,
  SkeletonTable,
  PageBody,
  PageHead,
  Stat,
  Table,
  Td,
} from '@/components/ui'
import {
  HEALTH_LABEL,
  HEALTH_TONE,
  fixPath,
  needsAttention,
  useIntegrationsIndex,
  whenLabel,
  type IntegrationEntry,
} from './integrations-lib'

/**
 * Integrations — one index over every connector, and what each thinks of itself.
 *
 * The screen answers three questions in the order an administrator asks them:
 * what is switched on and actually working (two different questions), what is
 * not set up and what it needs, and where to go to fix it.
 *
 * Two rules govern everything below.
 *
 * A failed fetch is never drawn as an empty state. On this screen especially,
 * "all connectors healthy" rendered from a request that never returned would
 * be the exact lie the screen exists to prevent — so an error replaces the
 * summary and the table rather than sitting beside them, and the counts are
 * not rendered at all when the query failed.
 *
 * Nothing here decides whether a connector is working. Every status, sentence
 * and flag arrives from the server, which asked the connector. The screen
 * chooses typography, not truth.
 */
export default function Integrations() {
  const { data, isLoading, error } = useIntegrationsIndex()
  const [filter, setFilter] = useState('')

  const items = data?.items ?? []
  const attention = useMemo(() => items.filter(needsAttention), [items])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (e) =>
        e.label.toLowerCase().includes(q) ||
        e.group.toLowerCase().includes(q) ||
        (e.provider ?? '').toLowerCase().includes(q),
    )
  }, [items, filter])

  return (
    <>
      <PageHead
        eyebrow="Platform Configuration"
        title="Integrations"
        description="Every connector this school and this installation have, and what each one reports about itself. Switched on and actually working are different questions; both are answered here."
        width="wide"
      />
      <PageBody width="wide">
        {/* The failure branch comes first and replaces everything. There is no
            arrangement of this screen in which a failed request may share the
            page with a green summary. */}
        {error ? (
          <ErrorState error={error} />
        ) : isLoading ? (
          <SkeletonTable columns={6} label="Asking every connector" />
        ) : (
          <>
            <CellGrid cols={4}>
              <Stat label="Connectors" value={data?.counts.total ?? 0} />
              <Stat label="Working" value={data?.counts.working ?? 0} />
              <Stat
                label="Need attention"
                value={data?.counts.attention ?? 0}
                hint={attention.length ? 'failing or silent' : undefined}
              />
              <Stat label="Not set up" value={data?.counts.not_configured ?? 0} />
            </CellGrid>

            {/* Loud, not a grey dot. A connector that has gone quiet is named
                here at the top of the page with the reason, because the whole
                point is that nobody was going to notice it in a table. */}
            {attention.length > 0 && (
              <Card className="border-destructive/40 p-5">
                <p className="text-[13px] font-medium text-destructive">
                  {attention.length === 1
                    ? '1 connector needs attention'
                    : `${attention.length} connectors need attention`}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {attention.map((e) => (
                    <li key={e.key} className="text-[13px] text-secondary-foreground">
                      <span className="font-medium text-foreground">{e.label}</span>
                      {' — '}
                      {e.last_error || e.health_note || HEALTH_LABEL[e.health]}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {data && !data.institution_selected && (
              <Card className="p-5">
                <p className="text-[13px] text-secondary-foreground">
                  No school is selected, so only installation-wide connectors are listed.
                  Choose a school to see its email, SMS, WhatsApp and Tally connectors.
                </p>
              </Card>
            )}

            <Card>
              <CardHeader
                title="Connectors"
                description={data?.note}
                action={
                  <Input
                    value={filter}
                    onChange={setFilter}
                    placeholder="Filter connectors"
                    srLabel="Filter connectors by name, group or provider"
                  />
                }
              />
              {/* Table is a sibling of CardHeader, not inside a padded body:
                  Td supplies px-5 already and a p-5 body would double-inset it. */}
              <Table
                head={[
                  'Connector',
                  'Status',
                  'Last recorded activity',
                  'What it needs',
                  'Configure',
                ]}
                empty={!shown.length}
                emptyLabel={
                  filter
                    ? 'No connector matches that filter.'
                    : 'No connectors are visible to you.'
                }
              >
                {shown.map((e) => (
                  <ConnectorRow key={e.key} entry={e} />
                ))}
              </Table>
            </Card>

            <Card className="p-5">
              <p className="text-[13px] text-secondary-foreground">
                This index stores nothing and decides nothing. It asks each connector
                what it reports about itself and lays the answers side by side. Where a
                connector keeps no record of success or failure, it says so rather than
                being counted as healthy — and where one has no live API at all, the
                note on its row says which manual route does work.
              </p>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}

/**
 * One connector.
 *
 * A plain function returning a `<tr>`, called in the map rather than mounted as
 * a component: Table injects the mobile `data-label` into each `<td>` by
 * walking its rows, and it cannot walk into a component's render.
 */
function ConnectorRow({ entry: e }: { entry: IntegrationEntry }) {
  const path = fixPath(e.fix_key)
  const loud = needsAttention(e)

  return (
    <tr key={e.key}>
      <Td className="font-medium">
        {e.label}
        <span className="block text-[12px] font-normal text-secondary-foreground">
          {e.group}
          {e.provider ? ` · ${e.provider}` : ''}
          {e.scope === 'platform' ? ' · installation-wide' : ''}
        </span>
      </Td>

      <Td>
        <Badge tone={HEALTH_TONE[e.health]}>{HEALTH_LABEL[e.health]}</Badge>
        {/* Switched on and working are separate facts, so they get separate
            lines. A connector can be enabled and failing. */}
        {e.configured && !e.enabled && (
          <span className="block text-[12px] text-secondary-foreground">switched off</span>
        )}
        {e.live_available === false && e.scope === 'platform' && (
          <span className="block text-[12px] text-secondary-foreground">no live API</span>
        )}
      </Td>

      <Td>
        {e.last_ok_at ? (
          <>
            <span className="tabular-nums">{whenLabel(e.last_ok_at)}</span>
            {e.last_ok_label && (
              <span className="block text-[12px] text-secondary-foreground">
                {e.last_ok_label}
              </span>
            )}
          </>
        ) : (
          <span className="text-secondary-foreground">nothing recorded</span>
        )}
        {typeof e.silent_days === 'number' && typeof e.stale_after_days === 'number' && (
          <span
            className={
              loud
                ? 'block text-[12px] font-medium text-destructive'
                : 'block text-[12px] text-secondary-foreground'
            }
          >
            {e.silent_days} days ago · expected at least every {e.stale_after_days}
          </span>
        )}
        {typeof e.failed_recently === 'number' && e.failed_recently > 0 && (
          <span className="block text-[12px] font-medium text-destructive">
            {e.failed_recently} failed in the last 24 hours
          </span>
        )}
      </Td>

      {/* The connector's own sentences, verbatim. Each was written by somebody
          who knew which credential was missing; rewording them here is how an
          actionable sentence becomes a shrug. */}
      <Td>
        {e.last_error && (
          <span className="block text-[13px] text-destructive">{e.last_error}</span>
        )}
        {e.reason && <span className="block text-[13px]">{e.reason}</span>}
        {e.health_note && (
          <span className="block text-[12px] text-secondary-foreground">{e.health_note}</span>
        )}
        {e.live_note && (
          <span className="block text-[12px] text-secondary-foreground">{e.live_note}</span>
        )}
        {!e.last_error && !e.reason && !e.health_note && !e.live_note && (
          <span className="text-secondary-foreground">—</span>
        )}
      </Td>

      <Td>
        {path ? (
          <Link to={path} className="text-[13px] text-primary hover:underline">
            {e.fix_label}
          </Link>
        ) : (
          <span className="text-secondary-foreground">—</span>
        )}
      </Td>
    </tr>
  )
}
