import { useState } from 'react'
import { cn } from '@/lib/utils'
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


/* THE FIVE FIELDS NOBODY SHOULD HAVE TO LOOK UP.

   Host, port and encryption are not decisions a school makes. They are facts
   about whichever mail account it already has, they are identical for every
   school using that provider, and getting one of them wrong produces a failure
   that looks like a wrong password: a connection that hangs, or an auth error,
   with nothing on screen to say which of the three was at fault.

   So the provider is picked and the three are filled. What is NOT filled is
   anything only the school knows -- the address, the name, the credential --
   because those are the parts a preset cannot guess and must not overwrite.

   `note` is the reason this list is worth more than the hostnames. Almost every
   provider here refuses an ordinary account password over SMTP now, and the
   thing that unblocks it differs per provider: an App Password behind 2-Step
   Verification for Google and Yahoo, an app-specific password for iCloud, the
   literal username "apikey" for SendGrid, SMTP credentials that are not the AWS
   keys for SES. That is the step people lose an afternoon to, so it is on the
   screen rather than in a support call. */
interface MailPreset {
  key: string
  label: string
  host: string
  port: number
  security: string
  /* Some providers dictate the username. SendGrid's is the literal word
     "apikey" for every account on it, which reads as a placeholder and is
     therefore the single most commonly mistyped field on that provider. */
  username?: string
  note: string
}

const PRESETS: MailPreset[] = [
  {
    key: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: 587, security: 'starttls',
    note: 'Needs an App Password, not the Gmail password — turn on 2-Step Verification first, then Google Account → Security → App passwords. The From address must be the same account, or Gmail rewrites it. Roughly 500 recipients a day.',
  },
  {
    key: 'workspace', label: 'Google Workspace', host: 'smtp.gmail.com', port: 587, security: 'starttls',
    note: 'Same server as Gmail and the same App Password requirement, on your own domain. Roughly 2,000 recipients a day, and you can send as office@yourschool.com — which is what stops fee notices looking personal.',
  },
  {
    key: 'm365', label: 'Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls',
    note: 'The tenant administrator must enable SMTP AUTH on the mailbox — it is off by default and Microsoft is retiring it, so check this still works before you depend on it for a fee run.',
  },
  {
    key: 'outlook', label: 'Outlook.com / Hotmail', host: 'smtp-mail.outlook.com', port: 587, security: 'starttls',
    note: 'Personal Microsoft accounts are being moved off password sign-in for SMTP. Test it before relying on it; a school account on Microsoft 365 is the supported route.',
  },
  {
    key: 'yahoo', label: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 465, security: 'tls',
    note: 'Needs an App Password from Yahoo Account Security. The ordinary password is refused.',
  },
  {
    key: 'zoho_in', label: 'Zoho Mail (India)', host: 'smtp.zoho.in', port: 587, security: 'starttls',
    note: 'For accounts on zoho.in. Use smtp.zoho.com if the account was created on the global site — the two are not interchangeable. An App Password is required when two-factor is on.',
  },
  {
    key: 'icloud', label: 'iCloud Mail', host: 'smtp.mail.me.com', port: 587, security: 'starttls',
    note: 'Needs an app-specific password from appleid.apple.com. The username is the full iCloud address.',
  },
  {
    key: 'brevo', label: 'Brevo', host: 'smtp-relay.brevo.com', port: 587, security: 'starttls',
    note: 'A sending service rather than a mailbox: the credential is an SMTP key from the Brevo console, and the sending domain has to be verified there. Built for volume, so it does not have a mailbox provider\u2019s daily cap.',
  },
  {
    key: 'sendgrid', label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, security: 'starttls',
    username: 'apikey',
    note: 'The username is the literal word "apikey" — filled in above, and it is correct as it stands. The password is the API key itself.',
  },
  {
    key: 'ses_mumbai', label: 'Amazon SES (Mumbai)', host: 'email-smtp.ap-south-1.amazonaws.com', port: 587, security: 'starttls',
    note: 'The credential is a pair of SES SMTP credentials generated in the SES console — NOT your AWS access key, which will be refused. A new SES account is in the sandbox and can only mail verified addresses until you ask for production access.',
  },
]

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
/**
 * platform: the seller's own providers rather than a school's. Same screen,
 * same routes -- a platform account's institution is NULL, and the handlers
 * read and write the platform's rows for it -- with the copy saying so.
 */
export default function EmailServer({ platform = false }: { platform?: boolean } = {}) {
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
        eyebrow={platform ? 'Delivery' : 'Messaging'}
        title={platform ? 'Password reset delivery' : 'Email Server (SMTP)'}
        description={platform
          ? "The seller's own mail server and SMS channel. Every school's password-reset links leave through these, whatever the school has set up."
          : "Where this school's mail goes out, whether it works, and what has left the building."}
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
            description={platform ? 'Every message sent by email from the seller, newest first' : 'Every message this school has sent by email, newest first'}
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
  const [preset, setPreset] = useState<MailPreset | null>(null)
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

        {/* Picked before the form, because it answers three of the fields in it
            and warns about the fourth. */}
        <div>
          <p className="mb-2 text-[13px] font-medium text-secondary-foreground">
            Start from a known provider
          </p>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((x) => (
              <button
                key={x.key}
                type="button"
                onClick={() => {
                  setPreset(x)
                  /* Host, port and encryption only -- plus the username where
                     the provider dictates it. The address, the name and the
                     credential are the school's own and are never touched: a
                     preset that wiped a From address somebody had just typed
                     would be worse than no preset. */
                  setDraft({
                    ...v,
                    host: x.host,
                    port: x.port,
                    security: x.security,
                    ...(x.username ? { username: x.username } : {}),
                  })
                }}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[13px] transition-colors',
                  preset?.key === x.key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-accent',
                )}
              >
                {x.label}
              </button>
            ))}
          </div>
          {preset && (
            /* The part that actually saves the afternoon. Every provider on
               this list refuses an ordinary password over SMTP, and each wants
               something different instead. */
            <p className="mt-2.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
              <span className="font-medium">{preset.label}: </span>
              {preset.note}
            </p>
          )}
        </div>

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
          {/* WHY THE BUTTON WILL NOT PRESS, ON THE SCREEN.

              The reason was in a `title` attribute, which is a tooltip: it
              needs a mouse to hover, so it does not exist on a phone or a
              tablet at all, and on a desktop it appears only if somebody
              already suspects the button is disabled for a reason and holds
              still over it long enough to find out.

              What that produced is a section headed "Prove it works" whose only
              control is greyed out and silent. The commonest cause is not a
              broken screen and not a missing password -- it is the switch at
              the bottom of the form being off, which the server reports
              verbatim as "configured but switched off" and which takes two
              clicks to fix once somebody knows.

              So it is said in the open, next to the control it explains, with
              the fix named rather than implied. */}
          {!provider.configured && (
            <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
              <span className="font-medium">Cannot send a test yet. </span>
              {provider.reason ?? 'The mail server is not set up.'}
              {/* Named for what the reader must do, not for what is wrong. The
                  two states have different fixes and only one of them involves
                  typing anything. */}
              {/^configured but switched off$/.test(provider.reason ?? '')
                ? ' — tick “Send email through this server” above and press Save, then test.'
                : ' — fill in the server above and press Save, then test.'}
            </p>
          )}
          {/* A change that has not been saved is not a change the test can use:
              the button reads the SAVED provider, so filling the form in and
              pressing Send a test tests the previous settings, or nothing. */}
          {provider.configured && (draft || enabled !== provider.enabled) && (
            <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
              These settings have not been saved. A test sends through the saved
              server, not what is on screen — press Save first.
            </p>
          )}
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
