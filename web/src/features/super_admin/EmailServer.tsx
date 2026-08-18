import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, Input, Select, Checkbox, Field, FormGrid, FormNotice,
  Loading, ErrorState, Table, Td,
} from '@/components/ui'
import {
  useProviders, useSaveProvider, useForgetProvider, useTestProvider,
  useMessageLog, useDispatch, statusTone, when,
  type Provider, type SmtpSettings,
} from './messaging-lib'

/**
 * Email Server (SMTP) Integration.
 *
 * The school's own outbound mail, and the honest state of every other channel
 * beside it. Three things had to be true for this screen to be worth building:
 *
 *   Nothing pretends. A channel that cannot send says so, in a sentence naming
 *   what is missing. SMS and WhatsApp sit here reading "awaiting a vendor
 *   account" rather than being hidden, because a school that cannot see them
 *   asks why the fee reminder never arrived instead of asking for a gateway.
 *
 *   The password is write-only. It goes out encrypted and never comes back;
 *   the screen shows only whether one is stored. A settings screen that can
 *   read back the mail password is a settings screen that leaks it to anyone
 *   who can open it, and in a school that is a convincing fee demand sent from
 *   the office's own address.
 *
 *   Testing is a real send. The button opens a real connection through the
 *   same provider a fee reminder uses, and records the outcome. A test that
 *   took a different route would prove nothing about the route that matters.
 */
export default function EmailServer() {
  const providers = useProviders()
  const log = useMessageLog('?channel=email&limit=50')
  const dispatch = useDispatch()

  if (providers.isLoading) return <Loading />
  if (providers.error) return <ErrorState error={providers.error} />

  const items = providers.data?.items ?? []
  const email = items.find((p) => p.channel === 'email')
  const others = items.filter((p) => p.channel !== 'email')
  const queued = items.reduce((n, p) => n + p.queued, 0)

  return (
    <>
      <PageHead
        eyebrow="Messaging"
        title="Email Server (SMTP)"
        description="Where this school's mail goes out, whether it works, and what has left the building."
        actions={
          <Button
            variant="secondary"
            disabled={dispatch.isPending || queued === 0}
            onClick={() => dispatch.mutate({ limit: 100 })}
            title={queued === 0 ? 'Nothing is waiting' : 'Send everything that is due now'}
          >
            {dispatch.isPending ? 'Sending…' : `Send queued (${queued})`}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Email"
            value={email?.configured ? 'Working' : 'Not set up'}
            hint={email?.configured ? email.provider : email?.reason}
          />
          <Stat label="Waiting to go" value={queued} hint="Across every channel" />
          <Stat label="Sent today" value={email?.sent_today ?? 0} period="last 24 hours" />
          <Stat
            label="Failed today"
            value={email?.failed_today ?? 0}
            hint={email?.failed_today ? 'Open the log below' : 'Nothing rejected'}
            period="last 24 hours"
          />
        </CellGrid>

        {email && <SmtpPanel provider={email} />}

        <Card>
          <CardHeader
            title="Other channels"
            description="Modelled the same way as email, so each is a missing credential rather than missing code"
          />
          <Table head={['Channel', 'State', 'Waiting', 'Sent today', 'Last error']} empty={others.length === 0}>
            {others.map((p) => (
              <tr key={p.channel}>
                <Td>{p.label}</Td>
                <Td>
                  <Badge tone={p.configured ? 'success' : 'neutral'}>
                    {p.configured ? 'Ready' : (p.reason ?? 'Not set up')}
                  </Badge>
                </Td>
                <Td>{p.queued}</Td>
                <Td>{p.sent_today}</Td>
                <Td className="text-[13px] text-muted-foreground">{p.last_error ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="Email dispatch log"
            description="Every message this school has sent by email, newest first"
          />
          <Table
            head={['Queued', 'To', 'Subject', 'Status', 'Why / rule']}
            empty={(log.data?.items ?? []).length === 0}
            emptyLabel="Nothing has been sent by email yet."
          >
            {(log.data?.items ?? []).map((row) => (
              <tr key={row.id}>
                <Td className="whitespace-nowrap">{when(row.queued_at)}</Td>
                <Td>{row.recipient}</Td>
                <Td>{row.subject ?? row.template_code ?? '—'}</Td>
                <Td>
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  {row.send_after && row.status === 'queued' && (
                    <span className="block text-[12px] text-muted-foreground">
                      held until {when(row.send_after)}
                    </span>
                  )}
                </Td>
                <Td className="text-[13px] text-muted-foreground">
                  {row.error ?? row.rule ?? row.source_kind ?? 'sent by hand'}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}

const SECURITY = [
  { value: 'none', label: 'None (plain, port 25 or a local relay)' },
  { value: 'starttls', label: 'STARTTLS (usually port 587)' },
  { value: 'tls', label: 'Implicit TLS (usually port 465)' },
]

/**
 * The SMTP form.
 *
 * The security mode is named rather than inferred from the port. A school on
 * 587 behind an appliance that does not offer STARTTLS otherwise gets a
 * connection that hangs with no explanation, and the person filling this in
 * has no way to tell that from a wrong password.
 */
function SmtpPanel({ provider }: { provider: Provider }) {
  const settings = provider.settings as SmtpSettings
  const save = useSaveProvider('email')
  const forget = useForgetProvider('email')
  const test = useTestProvider('email')

  const [draft, setDraft] = useState<SmtpSettings | null>(null)
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(provider.enabled)
  const [testTo, setTestTo] = useState('')

  const v: SmtpSettings = { ...settings, ...(draft ?? {}) }
  const set = <K extends keyof SmtpSettings>(k: K, val: SmtpSettings[K]) =>
    setDraft({ ...(draft ?? {}), [k]: val })

  return (
    <Card>
      <CardHeader
        title="Outgoing mail server"
        description={
          provider.configured
            ? `Sending through ${v.host}:${v.port}`
            : (provider.reason ?? 'Not configured')
        }
        action={
          <>
            <Badge tone={provider.configured ? 'success' : 'warning'}>
              {provider.configured ? 'Ready to send' : 'Not sending'}
            </Badge>
            <Button
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    enabled,
                    settings: {
                      host: (v.host ?? '').trim(),
                      port: Number(v.port) || 0,
                      username: (v.username ?? '').trim(),
                      from_address: (v.from_address ?? '').trim(),
                      from_name: (v.from_name ?? '').trim(),
                      security: v.security ?? 'starttls',
                    },
                    // Omitted entirely when untouched, which is what tells the
                    // server to keep the stored password: sending an empty
                    // string would read as "erase it" and take email down at
                    // the next fee run.
                    ...(secret ? { secret } : {}),
                  },
                  { onSuccess: () => { setDraft(null); setSecret('') } },
                )
              }
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      />
      <div className="space-y-5 p-5">
        <FormNotice error={save.error} ok={save.isSuccess && !draft ? 'Saved.' : undefined} />

        <FormGrid>
          <Field label="Host" required hint="The mail server this school sends through.">
            <Input value={v.host ?? ''} onChange={(x) => set('host', x)} placeholder="smtp.gmail.com" />
          </Field>
          <Field label="Port" required hint="587 for STARTTLS, 465 for implicit TLS, 25 for a local relay.">
            <Input value={String(v.port ?? '')} onChange={(x) => set('port', Number(x) || 0)} />
          </Field>
          <Field label="Encryption" hint="Named, not guessed from the port — an appliance that does not offer STARTTLS simply hangs.">
            <Select value={v.security ?? 'starttls'} onChange={(x) => set('security', x)} options={SECURITY} />
          </Field>
          <Field label="Username" hint="Leave empty for a relay that authenticates by IP rather than by password.">
            <Input value={v.username ?? ''} onChange={(x) => set('username', x)} />
          </Field>
          <Field
            label="Password"
            hint={
              provider.has_secret
                ? 'A password is stored. Leave this empty to keep it; it is never shown again.'
                : 'Stored encrypted. It is never returned to this screen once saved.'
            }
          >
            <Input type="password" value={secret} onChange={setSecret} placeholder={provider.has_secret ? '••••••••' : ''} />
          </Field>
          <Field label="From address" required hint="A message with no sender is rejected by every recipient.">
            <Input value={v.from_address ?? ''} onChange={(x) => set('from_address', x)} placeholder="office@school.edu.in" />
          </Field>
          <Field label="From name" hint="What a parent sees in their inbox.">
            <Input value={v.from_name ?? ''} onChange={(x) => set('from_name', x)} placeholder="St John's School Office" />
          </Field>
          <Field label="Switched on" hint="Off keeps the settings but stops every email at the door.">
            <Checkbox checked={enabled} onChange={setEnabled} label="Send email through this server" />
          </Field>
        </FormGrid>

        <div className="border-t pt-5">
          <p className="mb-2 text-[13px] font-medium text-secondary-foreground">Prove it works</p>
          <p className="mb-3 text-[13px] text-muted-foreground">
            Sends a real message through this server, by the same route a fee reminder takes. The
            outcome is recorded here whether it succeeds or fails.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[260px] flex-1">
              <Input value={testTo} onChange={setTestTo} placeholder="your.name@school.edu.in" />
            </div>
            <Button
              variant="secondary"
              disabled={test.isPending || !testTo.trim() || !provider.configured}
              title={provider.configured ? undefined : (provider.reason ?? 'Not configured')}
              onClick={() => test.mutate({ to: testTo.trim() })}
            >
              {test.isPending ? 'Sending…' : 'Send a test'}
            </Button>
            {provider.has_secret && (
              <ConfirmButton
                confirmLabel="Forget it"
                question="The stored password and these settings are erased. Email stops until they are entered again."
                onConfirm={() => forget.mutate()}
                tone="danger"
              >
                Forget credentials
              </ConfirmButton>
            )}
          </div>
          <div className="mt-3">
            <FormNotice error={test.error} ok={test.data?.ok ? test.data.message : undefined} />
          </div>
          {(provider.last_ok_at || provider.last_error) && (
            <p className="mt-3 text-[13px] text-muted-foreground">
              {provider.last_error
                ? `Last attempt failed: ${provider.last_error}`
                : `Last confirmed working ${when(provider.last_ok_at)}.`}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
