import { useEffect, useState } from 'react'
import { Video, VideoOff, School } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Input, Select, Checkbox, Field, FormGrid, Button, ConfirmButton, FormNotice,
  Loading, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { useToast } from '@/components/Toast'
import {
  meetingsBase, useConnectorMutation, useMeetingConnector, useMeetingRequests,
  whenRead, type MeetingAccount,
} from './connectors-lib'

/* The platform half of live classes.
 *
 * The live-class model is not here and is not duplicated here. A session is a
 * row in virtual_class_sessions, scheduled by a teacher through the launcher
 * under Faculty, with a nullable join link and a status that says plainly when
 * it has nowhere to happen yet. That was built and it works.
 *
 * What was missing is this: which meeting provider the installation has an
 * account with, its credentials, which schools may use it, and the seam where a
 * real "create meeting" call would go. That is what this screen configures.
 *
 * And it configures a seam that currently refuses. Creating a Zoom meeting from
 * a server needs a server-to-server OAuth app on the school's own Zoom account;
 * Meet needs a Workspace service account with domain-wide delegation; Teams
 * needs an Entra app registration. This installation has none of the three, so
 * every attempt below resolves to "paste the link" — recorded, so somebody can
 * see how often it was wanted, rather than swallowed.
 *
 * The pasted link keeps working exactly as it did. It is the fallback and it
 * stays the fallback: a launcher that invented a plausible meeting URL would
 * send thirty children to a room that does not exist, and the failure would
 * surface at 9am on the day.
 */

export default function VirtualClassroom() {
  const can = useCan()
  const mayConfigure = can('platform.tenants.write')

  const conn = useMeetingConnector()
  const requests = useMeetingRequests()
  const [editing, setEditing] = useState<MeetingAccount | null>(null)

  if (conn.isLoading) return <Loading label="Reading the meeting accounts…" />
  // A failed query is never rendered as "nothing configured": that would tell a
  // platform operator a school has no provider when the truth is we could not
  // ask.
  if (conn.error) return <ErrorState error={conn.error} />

  const c = conn.data!

  return (
    <>
      <PageHead
        eyebrow="Platform Setup"
        title="Virtual classroom integration"
        description="Which meeting account live classes run on, and who may use it. The classes themselves are scheduled by teachers in the live class launcher; this is the account behind them."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={3}>
          <Stat
            label="Sessions with a link"
            value={c.sessions_joinable}
            icon={Video}
            hint="Joinable today, by a link somebody pasted"
          />
          <Stat
            label="Sessions still without one"
            value={c.sessions_awaiting_url}
            icon={VideoOff}
            delta={
              c.sessions_awaiting_url
                ? { value: 'Each needs a link before the lesson', positive: false }
                : { value: 'Every scheduled class has somewhere to go', positive: true }
            }
          />
          <Stat
            label="Schools with a provider chosen"
            value={c.schools_using}
            icon={School}
            hint="From the school's own live class settings"
          />
        </CellGrid>

        {/* From the server. Whether a meeting can be created automatically is a
            fact about this deployment's credentials, not a label a screen picks. */}
        <Card>
          <CardHeader
            title="No meeting is created automatically"
            description={c.live_create_note}
            action={<Badge tone="warning">Pasted links only</Badge>}
          />
          <Table head={['Route', 'Creates a meeting']}>
            {c.routes.map((r) => (
              <tr key={r.key}>
                <Td>{r.label}</Td>
                <Td>
                  <Badge tone={r.live_create ? 'success' : 'neutral'}>
                    {r.live_create ? 'Yes' : 'Not on this installation'}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="Meeting accounts"
            description="An account marked for every campus is what a school falls back to when it has none of its own. Credentials are stored encrypted and never shown again — a secret that can create meetings in the installation's own Zoom account is the vendor's to hold, not a school's to read."
          />
        <Table
            head={['Provider', 'Account', 'Host reference', 'Credential', 'Scope', 'State', '']}
            empty={c.accounts.length === 0}
            emptyLabel="No meeting account has been configured."
          >
            {c.accounts.map((a) => (
              <tr key={a.id}>
                <Td>{c.systems.find((s) => s.key === a.provider)?.name ?? a.provider}</Td>
                <Td>{a.display_name}</Td>
                <Td>{a.account_ref ?? '—'}</Td>
                <Td>
                  <Badge tone={a.has_credentials ? 'success' : 'neutral'}>
                    {a.has_credentials ? 'Stored' : 'None'}
                  </Badge>
                </Td>
                <Td>{a.is_installation_default ? 'Every campus' : 'This school'}</Td>
                <Td>
                  <Badge tone={a.is_enabled ? 'success' : 'neutral'}>
                    {a.is_enabled ? 'Enabled' : 'Off'}
                  </Badge>
                </Td>
                <Td>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(a)}>
                      Edit
                    </Button>
                    <RemoveAccount id={a.id} name={a.display_name} may={mayConfigure} />
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
          <div className="px-5 pb-5 pt-1">
            {/* key={} on the form is what makes editing a second account reset
                the fields. Without it the form keeps the first account's state
                and saves it under the second one's name — nine bugs of exactly
                that shape have shipped in this codebase. */}
            <MeetingAccountForm
              key={editing?.id ?? 'new'}
              account={editing}
              systems={c.systems}
              styles={c.auth_styles}
              mayConfigure={mayConfigure}
              onDone={() => setEditing(null)}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="What was asked for"
            description="Every request for a meeting to be created, and what came of it. On this installation each one resolves to 'paste the link' — kept so somebody can see how often the feature was wanted, and so there is a backlog to drain the day a credential arrives."
          />
          {requests.error ? (
            <div className="p-5">
              <ErrorState error={requests.error} />
            </div>
          ) : (
            <Table
              head={['Class', 'Scheduled', 'Route', 'Outcome', 'Asked', 'Detail']}
              empty={!requests.isLoading && (requests.data?.items.length ?? 0) === 0}
              emptyLabel="Nothing has been asked for yet."
            >
              {(requests.data?.items ?? []).map((q) => (
                <tr key={q.id}>
                  <Td>{q.topic}</Td>
                  <Td>{whenRead(q.scheduled_at)}</Td>
                  <Td>{q.provider}</Td>
                  <Td>
                    <Badge
                      tone={
                        q.status === 'created'
                          ? 'success'
                          : q.status === 'failed'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {q.status === 'manual' ? 'Link pasted by hand' : q.status}
                    </Badge>
                  </Td>
                  <Td>{whenRead(q.requested_at)}</Td>
                  <Td>{q.detail ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function RemoveAccount({ id, name, may }: { id: string; name: string; may: boolean }) {
  const toast = useToast()
  const remove = useConnectorMutation(
    () => api.del(`${meetingsBase}/providers/${id}`),
    () => toast.ok(`${name} was removed.`),
  )
  return (
    <ConfirmButton
      size="sm"
      variant="secondary"
      confirmLabel="Remove"
      question={`Remove ${name}? Sessions already carrying a link keep it.`}
      onConfirm={() => remove.mutate(undefined as never)}
      disabled={!may || remove.isPending}
    >
      Remove
    </ConfirmButton>
  )
}

/* One meeting account.
 *
 * The secret is write-only: sent only when something was typed, so a reload and
 * a save cannot wipe a credential the form was never shown. */
function MeetingAccountForm({
  account,
  systems,
  styles,
  mayConfigure,
  onDone,
}: {
  account: MeetingAccount | null
  systems: { key: string; name: string }[]
  styles: { key: string; name: string }[]
  mayConfigure: boolean
  onDone: () => void
}) {
  const toast = useToast()
  const [provider, setProvider] = useState(account?.provider ?? 'zoom')
  const [name, setName] = useState(account?.display_name ?? '')
  const [accountRef, setAccountRef] = useState(account?.account_ref ?? '')
  const [authStyle, setAuthStyle] = useState(account?.auth_style ?? 'oauth_s2s')
  const [baseURL, setBaseURL] = useState(account?.base_url ?? '')
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(account?.is_enabled ?? false)
  const [installationDefault, setInstallationDefault] = useState(
    account?.is_installation_default ?? false,
  )

  // The form is remounted per account by its key, so this only has to cover the
  // case where the same account is refetched with newer values.
  useEffect(() => {
    if (!account) return
    setEnabled(account.is_enabled)
  }, [account])

  const save = useConnectorMutation(
    () =>
      api.put(`${meetingsBase}/providers`, {
        provider,
        display_name: name,
        account_ref: accountRef,
        auth_style: authStyle,
        base_url: baseURL,
        is_enabled: enabled,
        is_installation_default: installationDefault,
        ...(secret === '' ? {} : { secret }),
      }),
    () => {
      setSecret('')
      toast.ok('The meeting account was saved.')
      onDone()
    },
  )

  return (
    <div className="space-y-4">
      <FormGrid>
        <Field label="Provider" required>
          <Select
            value={provider}
            onChange={setProvider}
            options={systems.map((s) => ({ value: s.key, label: s.name }))}
          />
        </Field>
        <Field label="Account name" required hint="What support should call this account.">
          <Input value={name} onChange={setName} placeholder="Trust-wide Zoom (Education plan)" />
        </Field>
        <Field
          label="Host reference"
          hint="The provider's own id for the host: a Zoom user id, a Workspace address. The first thing support asks for when a meeting fails."
        >
          <Input value={accountRef} onChange={setAccountRef} placeholder="principal@school.edu.in" />
        </Field>
        <Field label="Authentication">
          <Select
            value={authStyle}
            onChange={setAuthStyle}
            options={styles.map((s) => ({ value: s.key, label: s.name }))}
          />
        </Field>
        <Field label="API endpoint" hint="Left blank unless the provider needs a regional host.">
          <Input value={baseURL} onChange={setBaseURL} placeholder="https://api.zoom.us/v2" />
        </Field>
        <Field label="Client secret" hint="Write-only. Leave blank to keep whatever is stored.">
          <Input value={secret} onChange={setSecret} type="password" placeholder="••••••••" />
        </Field>
        <Field label="Availability">
          <Checkbox
            checked={enabled}
            onChange={setEnabled}
            label="Schools in scope may use this account"
            hint="Separate from whether a credential exists: an account can be configured and switched off."
          />
        </Field>
        <Field label="Scope">
          <Checkbox
            checked={installationDefault}
            onChange={setInstallationDefault}
            label="Every campus falls back to this account"
            hint="Otherwise it belongs to the school being configured."
          />
        </Field>
      </FormGrid>
      <FormNotice error={save.error} />
      <div className="flex gap-3">
        <Button
          onClick={() => save.mutate(undefined as never)}
          disabled={!mayConfigure || save.isPending}
        >
          {account ? 'Save this account' : 'Add the account'}
        </Button>
        {account && (
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
