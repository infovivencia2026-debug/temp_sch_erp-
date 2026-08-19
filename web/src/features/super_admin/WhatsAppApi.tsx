import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, Input, Select, Checkbox, Field, FormGrid, FormNotice,
  Loading, ErrorState, Table, Td,
} from '@/components/ui'
import {
  useWhatsAppSettings, useSaveWhatsApp, useForgetWhatsApp, useTestWhatsApp,
  useWhatsAppTemplates, useSaveWhatsAppTemplate, useWhatsAppLog,
  useRecipientPolicy, useSetRecipientMode, useAddRecipient, useRemoveRecipient,
  waStatusTone, waWhen, waRedact,
  type WhatsAppSettings, type WhatsAppTemplate, type RecipientPolicy,
} from './whatsapp-lib'

/**
 * WhatsApp API Integration.
 *
 * Three things this screen has to say plainly, in this order.
 *
 *   Who is being messaged, before anything else. The banner at the top is the
 *   first thing on the page because the failure it guards against is a school
 *   believing it is live when it is not — or, far worse, believing it is in
 *   testing when it is not. It states the mode in words, not as a toggle
 *   somebody has to interpret.
 *
 *   That WhatsApp is not free text. Outside a 24-hour window opened by the
 *   parent's own reply, Meta accepts only a pre-approved template — and every
 *   message this product sends is outside that window. So the template mapping
 *   is not an advanced panel at the bottom; it is the second half of setting
 *   the account up, and a template with no mapping is shown as work outstanding
 *   rather than quietly listed.
 *
 *   What the token can and cannot do. It goes out encrypted and never comes
 *   back; the screen shows only whether one is stored. Without it nothing here
 *   can send, and the screen says so rather than offering buttons that fail.
 */
export default function WhatsAppApi() {
  const settings = useWhatsAppSettings()
  const policy = useRecipientPolicy()

  // A failed query is never an empty state. "No recipients are allowed" and
  // "the server did not answer" are opposite facts, and showing the first for
  // the second is how somebody concludes the guard is off.
  if (settings.isLoading || policy.isLoading) return <Loading />
  if (settings.error) return <ErrorState error={settings.error} />
  if (policy.error) return <ErrorState error={policy.error} />

  const s = settings.data!
  const p = policy.data!

  return (
    <>
      <PageHead
        eyebrow="Messaging"
        title="WhatsApp API Integration"
        description="The school's WhatsApp Business account, the approved templates behind it, and who may currently be messaged."
        actions={
          <Badge tone={s.configured ? 'success' : 'warning'}>
            {s.configured ? 'Ready to send' : 'Not sending'}
          </Badge>
        }
      />
      <PageBody>
        <RecipientGuard policy={p} />

        <CellGrid cols={4}>
          <Stat
            label="WhatsApp"
            value={s.configured ? 'Connected' : 'Not set up'}
            hint={s.configured ? (s.business_number || s.endpoint) : s.reason}
          />
          <Stat label="Waiting to go" value={s.queued} hint="Queued on this channel" />
          <Stat label="Sent" value={s.sent_today} period="last 24 hours" />
          <Stat
            label="Held back"
            value={s.suppressed_today}
            hint={s.suppressed_today ? 'Not on the allowlist' : 'Nothing held'}
            period="last 24 hours"
          />
        </CellGrid>

        <AccountPanel settings={s} />
        <TemplateMapping />
        <DispatchLog />
      </PageBody>
    </>
  )
}

/**
 * The banner, and the reason it is loud.
 *
 * A school in allowlist mode that believes it is live sends nothing and blames
 * the product. A school in 'everyone' mode that believes it is testing sends a
 * fee reminder to every family. The second is unrecoverable, so the mode is
 * stated in a sentence rather than shown as a switch position, and turning the
 * guard off is typed rather than clicked.
 */
function RecipientGuard({ policy }: { policy: RecipientPolicy }) {
  const setMode = useSetRecipientMode()
  const add = useAddRecipient()
  const remove = useRemoveRecipient()

  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')
  const [confirm, setConfirm] = useState('')
  const [note, setNote] = useState(policy.note)

  const guarded = policy.mode === 'allowlist'

  return (
    <Card className={guarded ? 'border-warning/50' : 'border-destructive/50'}>
      <CardHeader
        title={guarded ? 'Testing — outbound messages are restricted' : 'Live — every family will be messaged'}
        description={policy.explanation}
        action={
          <Badge tone={guarded ? 'warning' : 'danger'}>
            {guarded ? 'Allowlist' : 'Everyone'}
          </Badge>
        }
      />
      <div className="space-y-5 p-5">
        <p className="text-[13px] text-muted-foreground">
          This guard applies to every channel — SMS, WhatsApp, email and the phone gateway — and is
          enforced where messages are dispatched, so nothing can queue around it. A message it holds
          back is recorded as <strong>suppressed</strong> with the reason, never dropped, so the
          school can see exactly what would have gone out.
        </p>

        <FormNotice
          error={setMode.error ?? add.error ?? remove.error}
          ok={setMode.isSuccess ? 'Mode saved.' : undefined}
        />

        <FormGrid>
          <Field
            label="Add a recipient"
            hint="A phone number or an email address. +91 91005 75183, 919100575183 and 9100575183 are the same entry."
          >
            <Input value={value} onChange={setValue} placeholder="+91 91005 75183" />
          </Field>
          <Field label="Whose is it?" hint="An allowlist nobody can attribute is one nobody dares edit.">
            <div className="flex gap-3">
              <Input value={label} onChange={setLabel} placeholder="Project mobile" />
              <Button
                variant="secondary"
                disabled={add.isPending || !value.trim()}
                onClick={() =>
                  add.mutate(
                    { value: value.trim(), label: label.trim() },
                    { onSuccess: () => { setValue(''); setLabel('') } },
                  )
                }
              >
                {add.isPending ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </Field>
        </FormGrid>
      </div>

      <Table
        head={['Recipient', 'As matched', 'Whose', 'Added', '']}
        empty={policy.items.length === 0}
        emptyLabel="Nobody is on the allowlist, so nothing is being sent to anybody."
      >
        {policy.items.map((r) => (
          <tr key={r.id}>
            <Td>{r.raw}</Td>
            <Td className="font-mono text-[13px] text-muted-foreground">{r.normalised}</Td>
            <Td>{r.label || '—'}</Td>
            <Td className="whitespace-nowrap">{waWhen(r.created_at)}</Td>
            <Td>
              <ConfirmButton
                confirmLabel="Remove"
                question="This recipient stops receiving messages immediately."
                onConfirm={() => remove.mutate(r.id)}
                tone="danger"
              >
                Remove
              </ConfirmButton>
            </Td>
          </tr>
        ))}
      </Table>

      <div className="space-y-3 border-t p-5">
        <p className="text-[13px] font-medium text-secondary-foreground">
          {guarded ? 'Go live' : 'Go back to testing'}
        </p>
        {guarded ? (
          <>
            <p className="text-[13px] text-muted-foreground">
              Removing the guard means the next dispatch reaches every parent, guardian and member of
              staff this school has on file. It cannot be recalled. Type <code>everyone</code> to
              confirm.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <Input
                value={confirm}
                onChange={setConfirm}
                placeholder="everyone"
                srLabel="Type everyone to confirm going live"
                className="max-w-[200px]"
              />
              <Input
                value={note}
                onChange={setNote}
                placeholder="Why, and who decided"
                srLabel="Note recording why the guard was removed"
              />
              <Button
                tone="danger"
                disabled={setMode.isPending || confirm.trim() !== 'everyone'}
                onClick={() =>
                  setMode.mutate({ mode: 'everyone', note: note.trim(), confirm: 'everyone' })
                }
              >
                {setMode.isPending ? 'Saving…' : 'Message everyone'}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Input
              value={note}
              onChange={setNote}
              placeholder="Why testing was resumed"
              srLabel="Note recording why the guard was put back"
            />
            <Button
              variant="secondary"
              disabled={setMode.isPending}
              onClick={() => setMode.mutate({ mode: 'allowlist', note: note.trim(), confirm: '' })}
            >
              {setMode.isPending ? 'Saving…' : 'Restrict to the allowlist'}
            </Button>
          </div>
        )}
        {policy.updated_at && (
          <p className="text-[13px] text-muted-foreground">
            Last changed {waWhen(policy.updated_at)}
            {policy.note ? ` — ${policy.note}` : ''}
          </p>
        )}
      </div>
    </Card>
  )
}

const LANGUAGES = [
  { value: 'en', label: 'English (en)' },
  { value: 'en_US', label: 'English, US (en_US)' },
  { value: 'en_GB', label: 'English, UK (en_GB)' },
  { value: 'te', label: 'Telugu (te)' },
  { value: 'hi', label: 'Hindi (hi)' },
]

/** The WhatsApp Business Cloud account itself. */
function AccountPanel({ settings }: { settings: WhatsAppSettings }) {
  const save = useSaveWhatsApp()
  const forget = useForgetWhatsApp()
  const test = useTestWhatsApp()
  const templates = useWhatsAppTemplates()

  const [draft, setDraft] = useState<Partial<WhatsAppSettings> | null>(null)
  const [token, setToken] = useState('')
  const [testTo, setTestTo] = useState('')
  const [testCode, setTestCode] = useState('')

  const v = { ...settings, ...(draft ?? {}) }
  const set = <K extends keyof WhatsAppSettings>(k: K, val: WhatsAppSettings[K]) =>
    setDraft({ ...(draft ?? {}), [k]: val })

  const mapped = (templates.data?.items ?? []).filter((t) => t.mapped)

  return (
    <Card>
      <CardHeader
        title="WhatsApp Business Cloud account"
        description={
          settings.mode === 'gateway'
            ? 'This school currently sends WhatsApp through a reseller gateway. Entering a phone number id below moves it to Meta’s own Cloud API.'
            : settings.configured
              ? `Sending through ${settings.endpoint}`
              : (settings.reason ?? 'Not configured')
        }
        action={
          <Button
            disabled={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  phone_number_id: (v.phone_number_id ?? '').trim(),
                  waba_id: (v.waba_id ?? '').trim(),
                  business_number: (v.business_number ?? '').trim(),
                  api_version: (v.api_version ?? '').trim(),
                  default_language: (v.default_language ?? '').trim(),
                  allow_free_text: !!v.allow_free_text,
                  enabled: !!v.enabled,
                  // Omitted entirely when untouched, which is what tells the
                  // server to keep the stored token: an empty string would
                  // read as "erase it" and stop every reminder.
                  ...(token ? { token } : {}),
                },
                { onSuccess: () => { setDraft(null); setToken('') } },
              )
            }
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        }
      />
      <div className="space-y-5 p-5">
        <FormNotice error={save.error} ok={save.isSuccess && !draft ? 'Saved.' : undefined} />

        <FormGrid>
          <Field
            label="Phone number id"
            required
            hint="The numeric id from Meta’s WhatsApp Manager, not the phone number itself."
          >
            <Input
              value={v.phone_number_id ?? ''}
              onChange={(x) => set('phone_number_id', x)}
              placeholder="1133027929890477"
            />
          </Field>
          <Field
            label="WhatsApp Business Account id"
            hint="Not used to send. It is what Meta’s support asks for when a template is rejected."
          >
            <Input value={v.waba_id ?? ''} onChange={(x) => set('waba_id', x)} placeholder="976272885261436" />
          </Field>
          <Field label="Business number" hint="The number parents see. Display only.">
            <Input
              value={v.business_number ?? ''}
              onChange={(x) => set('business_number', x)}
              placeholder="+91 8121306701"
            />
          </Field>
          <Field
            label="Access token"
            hint={
              settings.has_token
                ? 'A token is stored. Leave this empty to keep it; it is never shown again.'
                : 'A long-lived System User token. Stored encrypted and never returned to this screen.'
            }
          >
            <Input
              type="password"
              value={token}
              onChange={setToken}
              placeholder={settings.has_token ? '••••••••' : ''}
            />
          </Field>
          <Field
            label="Graph API version"
            hint="Pinned rather than latest: Meta changes the request shape between versions."
          >
            <Input value={v.api_version ?? ''} onChange={(x) => set('api_version', x)} placeholder="v21.0" />
          </Field>
          <Field label="Default template language" hint="Used when a template mapping names none.">
            <Select
              value={v.default_language ?? 'en'}
              onChange={(x) => set('default_language', x)}
              options={LANGUAGES}
            />
          </Field>
          <Field label="Switched on" hint="Off keeps the settings but stops every WhatsApp message at the door.">
            <Checkbox
              checked={!!v.enabled}
              onChange={(x) => set('enabled', x)}
              label="Send WhatsApp through this account"
            />
          </Field>
          <Field
            label="Free-form text"
            hint="Leave off. WhatsApp accepts free text only within 24 hours of the parent’s own reply, and this product has no inbound webhook, so it cannot tell whether that window is open. Switching this on does not open one — it only turns a refusal here into a rejection at Meta, which lowers the number’s quality rating."
          >
            <Checkbox
              checked={!!v.allow_free_text}
              onChange={(x) => set('allow_free_text', x)}
              label="Allow free-form text sends (unsafe)"
            />
          </Field>
        </FormGrid>

        <div className="border-t pt-5">
          <p className="mb-2 text-[13px] font-medium text-secondary-foreground">Prove it works</p>
          <p className="mb-3 text-[13px] text-muted-foreground">
            Sends a real message through this account, by the same route a fee reminder takes —
            including the allowlist, so a test cannot reach a number a real message could not.
            Choose an approved template: without one, WhatsApp will refuse.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <Input
                value={testTo}
                onChange={setTestTo}
                placeholder="+91 91005 75183"
                srLabel="Number to send the test to"
              />
            </div>
            <div className="min-w-[220px]">
              <Select
                value={testCode}
                onChange={setTestCode}
                placeholder="No template (will be refused)"
                options={mapped.map((t) => ({ value: t.code, label: `${t.code} → ${t.wa_template_name}` }))}
              />
            </div>
            <Button
              variant="secondary"
              disabled={test.isPending || !testTo.trim() || !settings.configured}
              title={settings.configured ? undefined : (settings.reason ?? 'Not configured')}
              onClick={() => test.mutate({ to: testTo.trim(), template_code: testCode })}
            >
              {test.isPending ? 'Sending…' : 'Send a test'}
            </Button>
            {settings.has_token && (
              <ConfirmButton
                confirmLabel="Forget it"
                question="The stored token and these settings are erased. WhatsApp stops until they are entered again."
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
          {(settings.last_ok_at || settings.last_error) && (
            <p className="mt-3 text-[13px] text-muted-foreground">
              {settings.last_error
                ? `Last attempt failed: ${settings.last_error}`
                : `Last confirmed working ${waWhen(settings.last_ok_at)}.`}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

/**
 * The mapping from this product's templates to approved WhatsApp ones.
 *
 * An approved template is a name plus positional parameters, and the order is
 * Meta's rather than ours — a school may reword its own body without touching
 * what was approved. So the order is typed here and stored, never inferred
 * from where a placeholder happens to appear in a sentence.
 */
function TemplateMapping() {
  const templates = useWhatsAppTemplates()
  const [code, setCode] = useState('')

  if (templates.isLoading) return <Loading />
  if (templates.error) return <ErrorState error={templates.error} />

  const items = templates.data?.items ?? []
  const chosen = items.find((t) => t.code === code) ?? items[0]
  const unmapped = items.filter((t) => !t.mapped).length

  return (
    <>
      <Card>
        <CardHeader
          title="Approved template mapping"
          description={
            unmapped > 0
              ? `${unmapped} of this school’s ${items.length} WhatsApp templates have no approved template behind them, and cannot be sent.`
              : 'Every template is mapped to an approved WhatsApp template.'
          }
        />
        <Table head={['Template', 'Approved as', 'Language', 'Parameters', 'State']} empty={items.length === 0}>
          {items.map((t) => (
            <tr key={t.code}>
              <Td>
                <button
                  type="button"
                  className="text-left underline-offset-2 hover:underline"
                  onClick={() => setCode(t.code)}
                >
                  {t.code}
                </button>
                {t.built_in && (
                  <span className="ml-2 text-[12px] text-muted-foreground">built-in</span>
                )}
              </Td>
              <Td className="font-mono text-[13px]">{t.wa_template_name || '—'}</Td>
              <Td>{t.wa_language || '—'}</Td>
              <Td className="text-[13px] text-muted-foreground">
                {t.wa_params.length ? t.wa_params.join(', ') : '—'}
              </Td>
              <Td>
                <Badge tone={t.mapped ? 'success' : 'warning'}>
                  {t.mapped ? 'Mapped' : 'Cannot be sent'}
                </Badge>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      {chosen && <MappingForm key={chosen.code} template={chosen} />}
    </>
  )
}

function MappingForm({ template }: { template: WhatsAppTemplate }) {
  const save = useSaveWhatsAppTemplate()
  const [name, setName] = useState(template.wa_template_name)
  const [lang, setLang] = useState(template.wa_language || 'en')
  const [params, setParams] = useState(template.wa_params.join(', '))
  const [active, setActive] = useState(template.is_active)

  return (
    <Card>
      <CardHeader
        title={`Mapping for ${template.code}`}
        description="What this template is called in the WhatsApp Business account, and which of its placeholders fills each approved parameter."
        action={
          <Button
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                code: template.code,
                body: template.body,
                wa_template_name: name.trim(),
                wa_language: lang.trim(),
                wa_params: params
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
                is_active: active,
              })
            }
          >
            {save.isPending ? 'Saving…' : 'Save mapping'}
          </Button>
        }
      />
      <div className="space-y-5 p-5">
        <FormNotice error={save.error} ok={save.isSuccess ? 'Mapping saved.' : undefined} />

        <div className="rounded-md bg-secondary p-3 text-[13px] whitespace-pre-wrap">
          {template.body}
        </div>
        <p className="text-[13px] text-muted-foreground">
          Placeholders in this body:{' '}
          {template.placeholders.length ? (
            <code>{template.placeholders.join(', ')}</code>
          ) : (
            'none'
          )}
        </p>

        <FormGrid>
          <Field
            label="Approved template name"
            required
            hint="Exactly as approved in WhatsApp Manager: lowercase letters, digits and underscores."
          >
            <Input value={name} onChange={setName} placeholder="absence_alert" />
          </Field>
          <Field
            label="Approved language"
            required
            hint="A template approved in English does not exist in Telugu. The wrong code reads at Meta as “no such template”."
          >
            <Select value={lang} onChange={setLang} options={LANGUAGES} />
          </Field>
          <Field
            label="Parameters, in the approved order"
            wide
            hint="Comma separated. The first name fills {{1}}, the second {{2}}, and so on — the order Meta approved, which need not be the order they appear above."
          >
            <Input value={params} onChange={setParams} placeholder="student_name, on_date" />
          </Field>
          <Field label="In use" hint="Off leaves the mapping stored but stops this template being sent.">
            <Checkbox checked={active} onChange={setActive} label="Use this template" />
          </Field>
        </FormGrid>
      </div>
    </Card>
  )
}

/** Everything WhatsApp has carried, and everything the guard held back. */
function DispatchLog() {
  const log = useWhatsAppLog()

  if (log.isLoading) return <Loading />
  if (log.error) return <ErrorState error={log.error} />

  const items = log.data?.items ?? []

  return (
    <Card>
      <CardHeader
        title="WhatsApp dispatch log"
        description="Newest first. Recipients are shown as their last four digits — a parent’s number has no business being readable over somebody’s shoulder."
      />
      <Table
        head={['Queued', 'To', 'Template', 'Status', 'Why']}
        empty={items.length === 0}
        emptyLabel="Nothing has been sent by WhatsApp yet."
      >
        {items.map((row) => (
          <tr key={row.id}>
            <Td className="whitespace-nowrap">{waWhen(row.queued_at)}</Td>
            <Td className="font-mono text-[13px]">{waRedact(row.recipient)}</Td>
            <Td>{row.template_code ?? '—'}</Td>
            <Td>
              <Badge tone={waStatusTone(row.status)}>{row.status}</Badge>
              {row.attempts > 1 && (
                <span className="block text-[12px] text-muted-foreground">
                  {row.attempts} attempts
                </span>
              )}
            </Td>
            <Td className="text-[13px] text-muted-foreground">{row.error ?? '—'}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}
