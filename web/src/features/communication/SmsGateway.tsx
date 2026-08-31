import { useState } from 'react'
import { AlertTriangle, BatteryLow, Signal, Smartphone, UserCheck } from 'lucide-react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, Input, Checkbox, Field, FormGrid, FormNotice,
  Loading, ErrorState, EmptyState, Table, Td,
} from '@/components/ui'
import {
  useSMSGateway, usePairPhone, useUpdateDevice, useRevokeDevice, useApproveDevice,
  healthTone, healthLabel, when, signalWords,
  type GatewayDevice, type PairCode,
} from './sms-gateway-lib'

/**
 * SMS Gateway Integration — a phone in a drawer as the school's SMS sender.
 *
 * Three things shaped this screen, and all three are arguments about honesty
 * rather than about layout:
 *
 *   A dead gateway must be loud. The school believes messages are going out;
 *   that belief is the danger. A handset that has stopped reporting gets a
 *   full-width red banner naming it and saying how long it has been silent —
 *   not a grey dot in a table somebody has to think about. The banner is the
 *   first thing on the page, above the numbers, because the numbers are
 *   reassuring and wrong in exactly the case that matters.
 *
 *   It must not pretend to be a bulk provider. Indian commercial SMS needs a
 *   DLT-registered sender id and pre-approved templates; a personal SIM sending
 *   hundreds of messages is throttled and may be disconnected. That sentence is
 *   on the screen, served by the server so it cannot be edited out of the UI
 *   alone, and it sits near the top rather than in a footer — a school that
 *   reads it after planning a fee campaign has read it too late.
 *
 *   The pairing code is shown once. It is minted on demand, lives ten minutes,
 *   and is never retrievable. The screen says so beside it, because an
 *   administrator who assumes they can come back for it will close the panel.
 */
export default function SmsGateway() {
  const gateway = useSMSGateway()
  const pair = usePairPhone()

  if (gateway.isLoading) return <Loading />
  // A failed query is never rendered as "no phones paired". That reads as a
  // school with no gateway, which is a different and much calmer fact than
  // "this screen could not find out".
  if (gateway.error) return <ErrorState error={gateway.error} />

  const data = gateway.data
  if (!data) return <ErrorState error={new Error('The gateway status could not be read.')} />

  const pending = data.devices.filter((d) => d.pending)
  const stale = data.devices.filter((d) => d.health === 'stale')
  const live = data.devices.filter((d) => d.health === 'live')

  return (
    <>
      <PageHead
        eyebrow="Messaging"
        title="SMS Gateway (school phone)"
        description="A spare Android handset with a SIM, acting as this school's SMS sender."
        actions={
          <Button disabled={pair.isPending} onClick={() => pair.mutate()}>
            {pair.isPending ? 'Generating…' : 'Pair a phone'}
          </Button>
        }
      />
      <PageBody>
        {/* Above the fault banner because it is the only thing here a person
            can fix by pressing a button: a phone is enrolled and waiting, and
            until somebody approves it the handset is handed nothing at all. */}
        {pending.length > 0 && <PendingApprovals devices={pending} />}

        {/* Loud, first, and full width. Everything below this is detail. */}
        {stale.length > 0 && <StaleBanner devices={stale} />}

        {data.devices.length > 0 && live.length === 0 && stale.length === 0 && (
          <NothingSendingBanner reason={data.reason} />
        )}

        {data.devices.length === 0 && <GetTheAppPanel />}

        {pair.data && <PairCodePanel code={pair.data} />}
        {pair.error && (
          <Card>
            <div className="p-5">
              <FormNotice error={pair.error} />
            </div>
          </Card>
        )}

        <ComplianceNotice advisory={data.advisory} />

        <CellGrid cols={4}>
          <Stat
            label="Gateway"
            value={data.configured ? 'Sending' : 'Not sending'}
            hint={data.configured ? `${live.length} phone${live.length === 1 ? '' : 's'} reporting` : data.reason}
            icon={Smartphone}
          />
          <Stat
            label="Waiting for a phone"
            value={data.waiting}
            hint={data.in_flight > 0 ? `${data.in_flight} being sent now` : 'Nothing held'}
          />
          <Stat
            label="Sent today"
            value={data.sent_today}
            hint={data.parts_today > data.sent_today ? `${data.parts_today} SMS parts` : undefined}
            period="since midnight"
          />
          <Stat
            label="Failed today"
            value={data.failed_today}
            hint={data.failed_today ? 'Reasons are listed below' : 'Nothing rejected'}
            period="since midnight"
          />
        </CellGrid>

        {!data.selected && <NotSelectedNotice />}

        <Card>
          <CardHeader
            title="Paired phones"
            description="What each handset reports about itself, every twenty seconds"
          />
          {data.devices.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No phone is paired yet"
                body="Pair a spare Android handset with a working SIM to start sending SMS. Use “Pair a phone” above; the code lasts ten minutes."
              />
            </div>
          ) : (
            /* A Table goes as a sibling of the padded body, never inside one —
               the card body's p-5 and the table's own px-5 double-inset every
               cell and the header stops lining up with the rows. */
            <Table
              head={['Phone', 'State', 'Battery', 'Signal', 'Sent today', 'Failed', 'Last heard']}
              empty={false}
            >
              {data.devices.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <span className="font-medium">{d.name}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {[d.sim_operator, d.android_version && `Android ${d.android_version}`]
                        .filter(Boolean)
                        .join(' · ') || 'no details reported'}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={healthTone(d.health)}>{healthLabel(d)}</Badge>
                  </Td>
                  <Td>
                    {d.battery_pct === undefined ? (
                      '—'
                    ) : (
                      <span
                        className={
                          d.battery_pct < 20 && !d.charging ? 'text-destructive' : undefined
                        }
                      >
                        {d.battery_pct}%{d.charging ? ' (charging)' : ''}
                      </span>
                    )}
                  </Td>
                  <Td className="text-[13px]">
                    {signalWords(d.signal_dbm)}
                    {d.sim_ready === false && (
                      <span className="block text-[12px] text-destructive">SIM not ready</span>
                    )}
                  </Td>
                  <Td>{d.sent_today}</Td>
                  <Td className={d.failed_today ? 'text-destructive' : undefined}>
                    {d.failed_today}
                  </Td>
                  <Td className="whitespace-nowrap text-[13px] text-muted-foreground">
                    {when(d.last_seen_at)}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {/* One editor per phone. `key` is the device id: without it React keeps
            the previous phone's draft state when the list re-renders and the
            office renames the wrong handset — nine bugs of exactly this shape
            have shipped in this codebase. */}
        {data.devices.map((d) => (
          <DevicePanel key={d.id} device={d} />
        ))}

        <Card>
          <CardHeader
            title="Failures"
            description="What the handset could not send, and the reason it gave"
          />
          <Table
            head={['When', 'Phone', 'Message', 'Reason']}
            empty={data.failures.length === 0}
            emptyLabel="Nothing has failed. "
          >
            {data.failures.map((f) => (
              <tr key={f.message_id}>
                <Td className="whitespace-nowrap">{when(f.at)}</Td>
                <Td>{f.device ?? 'a phone since removed'}</Td>
                <Td className="font-mono text-[12px] text-muted-foreground">
                  {/* The message id, not the message. A screen that listed the
                      text would be a copy of message_log for anybody who can
                      open this page. */}
                  {f.message_id.slice(0, 8)}
                </Td>
                <Td className="text-[13px]">
                  {f.reason}
                  {f.state === 'expired' && (
                    <span className="block text-[12px] text-warning">
                      Not re-sent — it may already have gone out.
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}

/**
 * The queue of handsets waiting for a person.
 *
 * Enrolment by sign-in means a phone can arrive at any hour with a real
 * credential and no permission to send. The office had nowhere to see that:
 * the device sat in the paired list looking like an ordinary quiet phone, and
 * the only cure was a pair code nobody needed. This panel is that missing
 * place, and it is exported so the principal's Circulars screen can carry it
 * too -- there is no institution-scoped catalogue key for the gateway screen
 * itself, so the approval has to reach a screen the office already opens.
 */
export function PendingApprovals({ devices }: { devices: GatewayDevice[] }) {
  return (
    <Card>
      <CardHeader
        title={
          devices.length === 1
            ? 'A phone is waiting to be approved'
            : `${devices.length} phones are waiting to be approved`
        }
        description="Somebody signed in on a handset to enrol it. It sends nothing until it is approved here."
      />
      <div className="divide-y divide-border">
        {devices.map((d) => (
          <PendingRow key={d.id} device={d} />
        ))}
      </div>
    </Card>
  )
}

// One waiting handset. Its own component because approve and revoke are hooks
// keyed by device id, and a shared mutation would report the wrong phone's
// error beside every row.
function PendingRow({ device }: { device: GatewayDevice }) {
  const approve = useApproveDevice(device.id)
  const revoke = useRevokeDevice(device.id)

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-medium">
            <UserCheck className="h-4 w-4 shrink-0 text-warning" />
            {device.name}
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {[
              device.enrolled_by && `Enrolled by ${device.enrolled_by}`,
              `Arrived ${when(device.paired_at)}`,
              device.sim_operator,
              device.android_version && `Android ${device.android_version}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button disabled={approve.isPending} onClick={() => approve.mutate()}>
            {approve.isPending ? 'Approving…' : 'Approve'}
          </Button>
          <ConfirmButton
            confirmLabel="Reject it"
            question="The handset's credential is destroyed and it can never send for this school. Somebody would have to enrol it again."
            onConfirm={() => revoke.mutate({ reason: 'rejected while awaiting approval' })}
            tone="danger"
          >
            Reject
          </ConfirmButton>
        </div>
      </div>
      <FormNotice error={approve.error ?? revoke.error} />
    </div>
  )
}

/**
 * The banner that exists because silence is the dangerous state.
 *
 * Destructive, full width, above everything, and it names the phone and the
 * elapsed time. A school reading this has a handset in a drawer with a flat
 * battery and a queue of absence alerts nobody has been told about.
 */
function StaleBanner({ devices }: { devices: GatewayDevice[] }) {
  return (
    <div className="rounded-[10px] border border-destructive/30 bg-destructive/5 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-destructive">
            {devices.length === 1
              ? 'The gateway phone has stopped reporting'
              : `${devices.length} gateway phones have stopped reporting`}
          </p>
          <p className="mt-1.5 text-[14px] leading-relaxed">
            {devices.map((d) => (
              <span key={d.id} className="block">
                <strong>{d.name}</strong> has not reported in for {d.silent_for ?? 'a while'} — last
                heard {when(d.last_seen_at)}.
              </span>
            ))}
          </p>
          <p className="mt-2.5 text-[13px] text-muted-foreground">
            Nothing is being sent through it. SMS is held in the queue rather than lost, and will go
            out when the phone reports in again. Check that the handset is charged, on the network,
            and that the gateway app is open.
          </p>
        </div>
      </div>
    </div>
  )
}

// Paired, not stale, and still not sending: every phone is paused, or has never
// reported at all. A quieter banner than the one above, because this state is
// somebody's decision rather than a fault.
function NothingSendingBanner({ reason }: { reason?: string }) {
  return (
    <div className="rounded-[10px] border border-warning/30 bg-warning/5 p-5">
      <div className="flex items-start gap-3">
        <BatteryLow className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="text-[15px] font-medium">No SMS is going out</p>
          <p className="mt-1.5 text-[14px] text-muted-foreground">
            {reason ?? 'No paired phone is currently able to send.'}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * The sentence this feature is not allowed to ship without.
 *
 * Served by the server rather than written here, so removing it from the
 * product means changing Go and failing a test, not deleting a paragraph from a
 * TSX file during a redesign.
 */
function ComplianceNotice({ advisory }: { advisory: string }) {
  return (
    <Card>
      <div className="flex items-start gap-3 p-5">
        <Signal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-[14px] font-medium">Before you rely on this</p>
          <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">{advisory}</p>
        </div>
      </div>
    </Card>
  )
}

// The school has paired phones but has not pointed the sms channel at them, so
// nothing will ever reach the handset. Worth saying plainly: everything else on
// this screen looks healthy in that state.
function NotSelectedNotice() {
  return (
    <Card>
      <div className="p-5">
        <p className="text-[14px] font-medium">SMS is not set to use the school phone</p>
        <p className="mt-1.5 text-[14px] text-muted-foreground">
          Messages will not reach a paired handset until the SMS channel is set to the phone
          gateway on the messaging providers screen. Until then the phones below will sit idle
          however healthy they look.
        </p>
      </div>
    </Card>
  )
}

/**
 * The pairing code, shown exactly once.
 *
 * Deliberately rendered from the mutation's own result rather than from a
 * query: there is no endpoint that reads a code back, because the server stores
 * only its digest. If this component unmounts the code is gone, and the panel
 * says so rather than letting somebody discover it.
 */
function PairCodePanel({ code }: { code: PairCode }) {
  return (
    <Card>
      <CardHeader
        title="Pair a phone"
        description="Type this into the gateway app on the handset"
      />
      <div className="space-y-3 p-5">
        <p className="font-mono text-[28px] font-semibold tracking-[0.2em]">{code.pair_code}</p>
        <p className="text-[13px] text-muted-foreground">
          Valid for {code.valid_minutes} minutes, until {when(code.expires_at)}. It works once. This
          is the only time it is shown — if you lose it, generate another.
        </p>
      </div>
    </Card>
  )
}

/**
 * One phone's settings.
 *
 * The rate is editable and framed as what it is: the thing keeping the SIM
 * alive. An office that raises it to send a campaign faster is the office whose
 * number gets disconnected, so the hint says so at the point of editing rather
 * than in a policy document.
 */
function DevicePanel({ device }: { device: GatewayDevice }) {
  const update = useUpdateDevice(device.id)
  const revoke = useRevokeDevice(device.id)

  const [name, setName] = useState(device.name)
  const [paused, setPaused] = useState(device.paused)
  const [poll, setPoll] = useState(String(device.poll_seconds))
  const [cap, setCap] = useState(String(device.per_minute_cap))

  return (
    <Card>
      <CardHeader
        title={device.name}
        description={`Paired ${when(device.paired_at)}${device.app_version ? ` · app ${device.app_version}` : ''}`}
        action={
          <>
            <Badge tone={healthTone(device.health)}>{healthLabel(device)}</Badge>
            <Button
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  name: name.trim(),
                  paused,
                  poll_seconds: Number(poll) || device.poll_seconds,
                  per_minute_cap: Number(cap) || device.per_minute_cap,
                })
              }
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
            <ConfirmButton
              confirmLabel="Revoke it"
              question="This phone stops sending at once and its credential is destroyed. Anything it was holding goes back to the queue."
              onConfirm={() => revoke.mutate({ reason: 'revoked from the admin screen' })}
              tone="danger"
            >
              Revoke
            </ConfirmButton>
          </>
        }
      />
      <div className="space-y-5 p-5">
        <FormNotice error={update.error ?? revoke.error} ok={update.isSuccess ? 'Saved.' : undefined} />
        <FormGrid>
          <Field label="Name" hint="What the office calls this handset — “front office drawer” beats “Redmi Note 12”.">
            <Input value={name} onChange={setName} />
          </Field>
          <Field
            label="Check for messages every"
            hint="Seconds between polls, 5 to 300. Shorter is faster and flatter batteries."
          >
            <Input value={poll} onChange={setPoll} />
          </Field>
          <Field
            label="Messages per minute"
            hint="The carrier's tolerance, not the phone's. Raising this is how a school SIM gets throttled or disconnected."
          >
            <Input value={cap} onChange={setCap} />
          </Field>
          <Field label="Paused" hint="Keeps the pairing but hands this phone nothing — for a handset going home for the weekend.">
            <Checkbox
              checked={paused}
              onChange={setPaused}
              label="Do not send through this phone"
            />
          </Field>
        </FormGrid>
      </div>
    </Card>
  )
}


/* Where the app comes from.

   Google Play restricts SEND_SMS to apps registered as the default SMS
   handler, which this is not and should not be -- it sends on the school's
   behalf and never reads an inbox. So there is no store listing and the app is
   sideloaded from this server, over the same certificate as the rest of the
   product.

   The fingerprint is printed because a sideloaded APK is exactly the case
   where somebody should be able to check what they installed. It is the
   signing certificate's SHA-256, which Android shows under the app's details,
   and it will not change across updates -- the key is what ties an update to
   the app it updates.

   No QR code: this project carries no QR library, and EventPasses.tsx already
   settled that question -- a barcode-shaped picture no scanner reads is worse
   than a short address somebody types. */
function GetTheAppPanel() {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <Card>
      <CardHeader
        title="Get the app onto the phone"
        description="Do this before generating a pairing code — the code expires in ten minutes."
      />
      <div className="space-y-3 p-5 text-[13px]">
        <p className="text-muted">
          On the handset that will send the messages, open a browser and go to:
        </p>
        <p className="select-all break-all font-mono text-[15px]">
          {origin}/download
        </p>
        <p className="text-muted">
          Download <span className="font-mono">sms-gateway-latest.apk</span> and open it.
          Android will ask permission to install from this source; that is expected for an
          app that does not come from the Play Store.
        </p>
        <p className="text-muted">
          Verify what you installed, if you wish. Android shows the app's signing
          certificate under its details; it should read:
        </p>
        <p className="select-all break-all font-mono text-[12px] text-muted">
          70:11:18:A6:FF:1E:B1:E3:8A:E0:D8:6F:D2:F4:BE:A2:50:D8:D7:11:39:EF:C6:0E:D9:39:31:FD:6A:DE:28:9A
        </p>
        <p className="text-muted">
          Keep the phone on a charger and exempt it from battery optimisation, or Android
          will stop it overnight and the school's messages will queue until somebody notices.
        </p>
      </div>
    </Card>
  )
}
