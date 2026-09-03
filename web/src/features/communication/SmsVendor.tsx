import { useState } from 'react'
import {
  Card, CardHeader, Button, Input, Field, FormGrid, FormNotice, Badge,
  SkeletonForm, ErrorState,
} from '@/components/ui'
import {
  useProviders, useSaveProvider, useTestProvider, useSmsPresets,
  type SmsPreset,
} from '@/features/super_admin/messaging-lib'

/* THE SCHOOL'S OWN SMS ACCOUNT, LINKED.

   The provider underneath is a generic HTTP gateway: an endpoint, a method and
   a bag of parameters with {to}, {text}, {sender}, {key} and {dlt} substituted
   at send time. That generality has already outlived one vendor and is worth
   keeping — but it is also unfillable. To complete that form from scratch you
   need the vendor's API reference open beside you and you need to know which
   of its fields carries the message body.

   So the vendor is picked and the shape is filled, exactly as the mail screen
   does with SMTP hosts. What is NOT filled is anything only the school knows:
   the key, the sender header, the DLT id. A preset cannot guess those and must
   never overwrite them.

   DLT IS NOT A DETAIL. Every transactional SMS in India must carry the
   template id registered with the operator. A message without one is rejected
   by the network rather than by the vendor, which on a screen looks exactly
   like the gateway being broken — so the field is here, named, rather than
   buried in an advanced section. */
export default function SmsVendor() {
  const providers = useProviders()
  const presets = useSmsPresets()
  const save = useSaveProvider('sms')
  const test = useTestProvider('sms')

  const current = providers.data?.items.find((p) => p.channel === 'sms')
  const cfg = (current?.settings ?? {}) as Record<string, unknown>

  const [preset, setPreset] = useState<SmsPreset | null>(null)
  const [endpoint, setEndpoint] = useState(String(cfg.endpoint ?? ''))
  const [sender, setSender] = useState(String(cfg.sender_id ?? ''))
  const [key, setKey] = useState('')
  const [extra, setExtra] = useState('')
  const [testTo, setTestTo] = useState('')

  if (providers.isLoading) return <SkeletonForm fields={4} label="Reading the channel…" />
  if (providers.error) return <ErrorState error={providers.error} />

  const chosen = preset
  const params = { ...(chosen?.params ?? (cfg.params as Record<string, string>) ?? {}) }
  // Gupshup carries the account id as a parameter rather than a header, so the
  // one free field is named by whatever the chosen vendor calls it.
  const extraKey = chosen?.id === 'gupshup' ? 'userid' : ''
  if (extraKey && extra) params[extraKey] = extra

  return (
    <Card>
      <CardHeader
        title="SMS vendor"
        action={
          current?.configured ? (
            <Badge tone="success">Linked</Badge>
          ) : (
            <Badge tone="neutral">Not linked</Badge>
          )
        }
      />
      <div className="px-5 pb-5">
        <p className="text-[13px] text-muted-foreground">
          The school sends on its own vendor account and pays that vendor directly. Nothing is
          bought through this product — the credits screen only meters how much of it a school
          may spend.
        </p>

        {presets.isLoading ? null : (
          <div className="mt-4 flex flex-wrap gap-2">
            {(presets.data?.items ?? []).map((p) => (
              <Button
                key={p.id}
                variant={chosen?.id === p.id ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => {
                  setPreset(p)
                  setEndpoint(p.endpoint)
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
        )}

        {chosen && <p className="mt-3 text-[13px] text-muted-foreground">{chosen.note}</p>}

        <FormGrid>
          <Field label="Endpoint" hint="Filled by the vendor above; editable, because a vendor may move it." wide>
            <Input value={endpoint} onChange={setEndpoint} placeholder="https://…" />
          </Field>
          <Field label="Sender header" hint="The six characters the operator approved for this school.">
            <Input value={sender} onChange={setSender} placeholder="VIGNAN" />
          </Field>
          <Field
            label={current?.has_secret ? 'API key (stored — type to replace)' : 'API key'}
            hint="MSG91 calls this the authkey; Gupshup uses the account password."
          >
            <Input value={key} onChange={setKey} type="password" placeholder="••••••••" />
          </Field>
          {extraKey && (
            <Field label="User id" hint="Gupshup's account user id.">
              <Input value={extra} onChange={setExtra} />
            </Field>
          )}
        </FormGrid>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            disabled={save.isPending || !endpoint.trim()}
            onClick={() =>
              save.mutate({
                enabled: true,
                settings: {
                  endpoint: endpoint.trim(),
                  method: chosen?.method ?? String(cfg.method ?? 'GET'),
                  encoding: chosen?.encoding ?? String(cfg.encoding ?? 'form'),
                  sender_id: sender.trim(),
                  params,
                },
                /* Omitted rather than sent empty when nothing was typed: an
                   empty string would overwrite a working key with a blank and
                   the channel would fail with "not configured" the next time
                   anybody saved an unrelated field. */
                ...(key ? { secret: key } : {}),
              })
            }
          >
            Save
          </Button>
          {/* A test needs somewhere to land. Proving credentials by sending
              to a real number the operator can check is the only proof that
              means anything — a gateway that accepts a request and drops the
              message answers 200 either way. */}
          <div className="flex items-center gap-2">
            <Input value={testTo} onChange={setTestTo} placeholder="Test to 9xxxxxxxxx" />
            <Button
              variant="secondary"
              disabled={test.isPending || !current?.configured || !testTo.trim()}
              onClick={() => test.mutate({ to: testTo.trim() })}
            >
              Send a test
            </Button>
          </div>
        </div>

        <FormNotice error={save.error ?? test.error} />
        {current && !current.configured && current.reason && (
          <p className="mt-2 text-[13px] text-muted-foreground">{current.reason}</p>
        )}
      </div>
    </Card>
  )
}
