import { useEffect, useState } from 'react'
import { AlertTriangle, BusFront, MapPinOff, Radio, Smartphone } from 'lucide-react'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, Input, Checkbox, Field, FormGrid, FormNotice, Select,
  Loading, SkeletonTiles, ErrorState, EmptyState, Table, Td,
} from '@/components/ui'
import {
  useTrackers, useTrackingPolicy, usePairTracker, useUpdateTracker,
  useRevokeTracker, useSaveTrackingPolicy,
  trackerHealth, healthLabel, healthTone, elapsed, when, secondsUntil, countdown,
  type TrackerRow, type PairCode, type TrackingPolicy,
} from './tracker-lib'

/**
 * Bus tracker pairing — a driver's own phone as the vehicle's GPS unit.
 *
 * Modelled on the SMS gateway screen deliberately: a school that has paired the
 * office handset for SMS should recognise this one on sight, because it is the
 * same act — mint a code here, type it into an app there, then live with a
 * device that reports on its own.
 *
 * Three things this screen argues:
 *
 *   The list is buses, not trackers. "Which of my buses will not be on the map
 *   tomorrow morning" cannot be answered by a table of trackers, because the
 *   buses with no tracker are exactly the rows such a table does not contain.
 *   So unpaired vehicles are counted at the top and listed first.
 *
 *   The pair code is read off a monitor and typed into a phone in a car park.
 *   It is rendered large, monospaced and letter-spaced for that, with a live
 *   countdown — an administrator who walks out with a code that expired four
 *   minutes ago blames the app, not the clock.
 *
 *   Letting parents watch is a publication, not a preference. The consequence
 *   sentence comes from the server and sits against the switch, because a
 *   school should turn it on having told its families, not having found a
 *   checkbox.
 */
export default function TrackerPairing() {
  const trackers = useTrackers()
  const policy = useTrackingPolicy()
  const pair = usePairTracker()

  const [vehicle, setVehicle] = useState('')

  if (trackers.isLoading) return <SkeletonTiles count={2} />
  // A failed query never renders as "no buses paired". That reads as a school
  // with no trackers, which is a calmer fact than "this screen could not find
  // out" and would be acted on the same way — by pairing a phone that is
  // already paired.
  if (trackers.error) return <ErrorState error={trackers.error} />

  const data = trackers.data
  if (!data) return <ErrorState error={new Error('The tracker list could not be read.')} />

  const rows = data.items ?? []
  const unpaired = rows.filter((r) => !r.paired)
  const paired = rows.filter((r) => r.paired)
  const dark = paired.filter((r) => {
    const h = trackerHealth(r)
    return h === 'quiet' || h === 'no-fix' || h === 'never'
  })

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title="Bus trackers (driver's phone)"
        description="The driver's own Android phone reports the bus's position while a run is open. There is no hardware to fit."
        actions={
          <Button
            disabled={!vehicle || pair.isPending}
            onClick={() => pair.mutate({ vehicle_id: vehicle })}
          >
            {pair.isPending ? 'Generating…' : 'Generate a pairing code'}
          </Button>
        }
      />
      <PageBody>
        {unpaired.length > 0 && <UnpairedBanner rows={unpaired} />}
        {dark.length > 0 && <DarkBanner rows={dark} />}

        {pair.data && <PairCodePanel code={pair.data} />}

        <Card>
          <CardHeader
            title="Pair a phone to a bus"
            description="Choose the bus here — the driver never types a registration number"
          />
          <div className="space-y-4 p-5">
            <FormNotice error={pair.error} />
            <FormGrid>
              <Field
                label="Bus"
                hint="The code binds to this vehicle. A driver entering a registration is a driver mistyping one, and the wrong bus on the map is worse than no bus."
              >
                <Select
                  value={vehicle}
                  onChange={setVehicle}
                  placeholder="Choose a bus"
                  options={rows.map((r) => ({
                    value: r.vehicle_id,
                    label: r.paired
                      ? `${r.registration_no} — already paired (${r.tracker ?? 'a phone'})`
                      : r.registration_no,
                  }))}
                />
              </Field>
            </FormGrid>
            <p className="text-[13px] text-muted-foreground">
              Generating a code retires every other unclaimed code in this school. A code lasts ten
              minutes and works once.
            </p>
          </div>
        </Card>

        <CellGrid cols={4}>
          <Stat
            label="Buses on the map"
            value={paired.length - dark.length}
            hint={`of ${rows.length} vehicle${rows.length === 1 ? '' : 's'} in service`}
            icon={BusFront}
          />
          <Stat
            label="No phone paired"
            value={data.unpaired}
            hint={data.unpaired ? 'These buses cannot be tracked at all' : 'Every bus has a phone'}
            icon={Smartphone}
          />
          <Stat
            label="Paired but not reporting"
            value={dark.length}
            hint={dark.length ? 'Silent, never started, or no location permission' : 'All reporting'}
            icon={Radio}
          />
          <Stat
            label="Parents may watch"
            value={policy.data?.policy.parents_may_watch ? 'On' : 'Off'}
            hint={
              policy.data?.policy.parents_may_watch
                ? 'Guardians on a route see the bus during its run'
                : 'Parents see nothing; the office still does'
            }
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Buses with no phone"
            description="The question this screen exists to answer"
          />
          {unpaired.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="Every bus in service has a phone paired"
                body="Nothing here is dark for want of a tracker."
              />
            </div>
          ) : (
            <Table head={['Bus', 'Route', 'Driver', 'Last pairing', 'Why it ended']} empty={false}>
              {unpaired.map((r) => (
                <tr key={r.vehicle_id}>
                  <Td>
                    <span className="font-medium">{r.registration_no}</span>
                    {r.vehicle_model && (
                      <span className="block text-[12px] text-muted-foreground">
                        {r.vehicle_model}
                      </span>
                    )}
                  </Td>
                  <Td className="text-[13px]">{r.route || '—'}</Td>
                  <Td className="text-[13px]">{r.driver || '—'}</Td>
                  <Td className="whitespace-nowrap text-[13px] text-muted-foreground">
                    {r.revoked_at ? when(r.revoked_at) : 'never paired'}
                  </Td>
                  <Td className="text-[13px] text-muted-foreground">{r.revoked_reason || '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Paired phones"
            description="What each handset reports about itself on every push"
          />
          {paired.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title="No phone is paired yet"
                body="Choose a bus above and generate a code. The driver types it into the tracker app once; after that the phone reports on its own while a run is open."
              />
            </div>
          ) : (
            /* Table is a sibling of the padded body, never inside one: the
               card's p-5 and the table's own px-5 double-inset every cell. */
            <Table
              head={['Bus', 'Phone', 'State', 'Battery', 'Location', 'Ping', 'Last heard']}
              empty={false}
            >
              {paired.map((r) => (
                <tr key={r.vehicle_id}>
                  <Td>
                    <span className="font-medium">{r.registration_no}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {r.route || 'no run open'}
                    </span>
                  </Td>
                  <Td>
                    {r.tracker}
                    <span className="block text-[12px] text-muted-foreground">
                      {[r.device_model, r.app_version && `app ${r.app_version}`]
                        .filter(Boolean)
                        .join(' · ') || 'no details reported'}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={healthTone(trackerHealth(r))}>{healthLabel(r)}</Badge>
                  </Td>
                  <Td>
                    {r.battery_pct === undefined ? (
                      '—'
                    ) : (
                      <span
                        className={r.battery_pct < 20 && !r.charging ? 'text-destructive' : undefined}
                      >
                        {r.battery_pct}%{r.charging ? ' (charging)' : ''}
                      </span>
                    )}
                  </Td>
                  <Td className="text-[13px]">
                    {r.location_ok === false ? (
                      <span className="text-destructive">permission denied</span>
                    ) : r.location_ok ? (
                      'ok'
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="text-[13px]">{r.ping_seconds ? `${r.ping_seconds}s` : '—'}</Td>
                  <Td className="whitespace-nowrap text-[13px] text-muted-foreground">
                    {when(r.last_seen_at)}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {/* One editor per paired bus. `key` is the tracker id: without it React
            keeps the previous phone's draft when the list re-renders and the
            office renames or revokes the wrong handset. */}
        {paired.map((r) => (
          <TrackerPanel key={r.tracker_id ?? r.vehicle_id} row={r} />
        ))}

        <PolicyForm />
      </PageBody>
    </>
  )
}

/**
 * The banner that names the buses nobody can see.
 *
 * First, full width, and it lists registrations rather than a count. "3 buses
 * unpaired" is a number somebody means to look into; "TS07 UB 4412, TS09 …" is
 * a list somebody acts on before the morning run.
 */
function UnpairedBanner({ rows }: { rows: TrackerRow[] }) {
  return (
    <div className="rounded-[10px] border border-destructive/30 bg-destructive/5 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-destructive">
            {rows.length === 1
              ? '1 bus has no phone paired'
              : `${rows.length} buses have no phone paired`}
          </p>
          <p className="mt-1.5 text-[14px] leading-relaxed">
            {rows.map((r) => r.registration_no).join(', ')}
          </p>
          <p className="mt-2.5 text-[13px] text-muted-foreground">
            These vehicles appear nowhere on the live map and raise no arrival or speeding events,
            however the rest of this screen looks.
          </p>
        </div>
      </div>
    </div>
  )
}

// Paired and still not on the map — quiet, never started, or the OS refusing
// fixes. Kept separate from the unpaired banner because the fix is different:
// this one is a phone to pick up, not a code to issue.
function DarkBanner({ rows }: { rows: TrackerRow[] }) {
  return (
    <div className="rounded-[10px] border border-warning/30 bg-warning/5 p-5">
      <div className="flex items-start gap-3">
        <MapPinOff className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="text-[15px] font-medium">
            {rows.length === 1
              ? 'A paired phone is not reporting'
              : `${rows.length} paired phones are not reporting`}
          </p>
          <p className="mt-1.5 text-[14px] leading-relaxed">
            {rows.map((r) => (
              <span key={r.vehicle_id} className="block">
                <strong>{r.registration_no}</strong> — {healthLabel(r).toLowerCase()}
                {r.tracker ? ` (${r.tracker})` : ''}.
              </span>
            ))}
          </p>
          <p className="mt-2.5 text-[13px] text-muted-foreground">
            A phone that is charged and online but denied location permission is the failure that
            looks healthy from every other angle. Check that the tracker app has location access set
            to “Allow all the time”, and that the driver has started the run.
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * The code, shown once, with the clock running.
 *
 * Rendered from the mutation's own result rather than a query: the server keeps
 * only a hash, so there is no endpoint that reads a code back. If this panel
 * unmounts the code is gone, and it says so instead of letting somebody find
 * out in a car park.
 */
function PairCodePanel({ code }: { code: PairCode }) {
  // Ticks locally so the countdown moves; the expiry itself is the server's
  // instant, which is the only clock that decides anything.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const left = secondsUntil(code.expires_at, now)
  const expired = left === 0

  return (
    <Card>
      <CardHeader
        title={`Pairing code for ${code.vehicle}`}
        description="Type this into the tracker app on the driver's phone"
        action={
          <Badge tone={expired ? 'danger' : left < 120 ? 'warning' : 'neutral'}>
            {expired ? 'Expired' : `${countdown(left)} left`}
          </Badge>
        }
      />
      <div className="space-y-3 p-5">
        <p
          className={
            expired
              ? 'font-mono text-[40px] font-semibold tracking-[0.35em] text-muted-foreground line-through'
              : 'font-mono text-[40px] font-semibold tracking-[0.35em]'
          }
        >
          {code.pair_code}
        </p>
        {expired ? (
          <p className="text-[14px] text-destructive">
            This code has expired. Generate another — the phone will refuse this one.
          </p>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Valid for {code.valid_minutes} minutes, until {when(code.expires_at)}. It works once, and
            this is the only time it is shown. The app will display{' '}
            <strong>{code.vehicle}</strong> back to the driver before it starts reporting; if it
            shows another bus, stop and pair again.
          </p>
        )}
      </div>
    </Card>
  )
}

/**
 * One phone's settings.
 *
 * Pausing and revoking are both here because they are different acts. A bus off
 * the road for a week is paused — the pairing survives and the driver does
 * nothing. A driver who has left is revoked, which destroys the credential and
 * means somebody must read out a new code.
 */
function TrackerPanel({ row }: { row: TrackerRow }) {
  const id = row.tracker_id ?? ''
  const update = useUpdateTracker(id)
  const revoke = useRevokeTracker(id)

  const [name, setName] = useState(row.tracker ?? '')
  const [paused, setPaused] = useState(row.paused ?? false)
  const [ping, setPing] = useState(String(row.ping_seconds ?? 15))
  const [reason, setReason] = useState('')

  return (
    <Card>
      <CardHeader
        title={`${row.registration_no} — ${row.tracker ?? 'paired phone'}`}
        description={`${row.device_model ?? 'unknown handset'}${row.driver ? ` · driver ${row.driver}` : ''} · last heard ${when(row.last_seen_at)}`}
        action={
          <>
            <Badge tone={healthTone(trackerHealth(row))}>{healthLabel(row)}</Badge>
            <Button
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  name: name.trim(),
                  paused,
                  ping_seconds: Number(ping) || row.ping_seconds || 15,
                })
              }
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      />
      <div className="space-y-5 p-5">
        <FormNotice
          error={update.error ?? revoke.error}
          ok={update.isSuccess ? 'Saved. The phone learns of this on its next push.' : undefined}
        />
        <FormGrid>
          <Field
            label="Name"
            hint="What the office calls this handset. “Ravi's phone” is what somebody needs to read when this bus stops reporting — not “SM-A146B”."
          >
            <Input value={name} onChange={setName} />
          </Field>
          <Field
            label="Report position every"
            hint="Seconds, 5 to 300. Below 5 the handset is flat by two o'clock; above 300 the map is five minutes behind the bus."
          >
            <Input value={ping} onChange={setPing} />
          </Field>
          <Field
            label="Paused"
            hint="Keeps the pairing but stops the phone reporting — for a bus off the road, or a handset in for repair."
          >
            <Checkbox checked={paused} onChange={setPaused} label="Do not track this bus for now" />
          </Field>
          <Field
            label="Unpair this phone"
            hint="Required. The next person on this desk has to decide whether to re-pair it, and “revoked” tells them nothing."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={reason}
                onChange={setReason}
                placeholder="Driver left, handset returned"
              />
              <ConfirmButton
                confirmLabel="Unpair it"
                question="The phone stops reporting at once, its credential is destroyed and any open run is closed. Where the bus went is kept."
                disabled={!reason.trim() || revoke.isPending}
                onConfirm={() => revoke.mutate({ reason: reason.trim() })}
                tone="danger"
              >
                Unpair
              </ConfirmButton>
            </div>
          </Field>
        </FormGrid>
        {row.quiet_seconds !== undefined && row.quiet_seconds > 180 && (
          <p className="text-[13px] text-destructive">
            This phone has said nothing for {elapsed(row.quiet_seconds)}.
          </p>
        )}
      </div>
    </Card>
  )
}

/**
 * The school's tracking policy.
 *
 * Every number here is bounded by a CHECK in migration 00122 and re-stated by
 * the server in a sentence. The form does not duplicate those bounds as
 * validation: the server's refusal is the one that is true, and a browser
 * that disagreed with it would be a second rulebook to keep in step.
 */
function PolicyForm() {
  const query = useTrackingPolicy()
  const save = useSaveTrackingPolicy()
  const [draft, setDraft] = useState<TrackingPolicy | null>(null)

  // Seeded from the server rather than from constants: a school that has never
  // opened this screen still has a row, created on first read, and the defaults
  // that matter live in the schema.
  useEffect(() => {
    if (query.data && !draft) setDraft(query.data.policy)
  }, [query.data, draft])

  if (query.isLoading) return <Loading label="Reading the tracking policy…" />
  if (query.error) return <ErrorState error={query.error} />
  if (!draft || !query.data) return null

  const set = (patch: Partial<TrackingPolicy>) => setDraft({ ...draft, ...patch })
  const num = (v: string, fallback: number) => (v.trim() === '' ? fallback : Number(v))

  return (
    <Card>
      <CardHeader
        title="Tracking policy"
        description="What the school has decided about geofences, speed, and who may watch"
        action={
          <Button disabled={save.isPending} onClick={() => save.mutate(draft)}>
            {save.isPending ? 'Saving…' : 'Save policy'}
          </Button>
        }
      />
      <div className="space-y-5 p-5">
        <FormNotice error={save.error} ok={save.isSuccess ? 'Policy saved.' : undefined} />

        {/* The switch that publishes, kept out of the grid so it cannot be
            skimmed past as one field among seven. */}
        <div
          className={
            draft.parents_may_watch
              ? 'rounded-[10px] border border-warning/40 bg-warning/5 p-5'
              : 'rounded-[10px] border border-border p-5'
          }
        >
          <p className="text-[14px] font-medium">Let parents watch their child's bus</p>
          <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
            {/* Served by the server so the sentence a school reads when it
                flips this cannot be edited out of the UI alone. */}
            {query.data.parents_may_watch_notice}
          </p>
          <p className="mt-2.5 text-[13px] text-muted-foreground">
            This is off until a school turns it on. Turning it on publishes the live position of a
            school bus to every parent allocated to that route — tell them first.
          </p>
          <div className="mt-3">
            <Checkbox
              checked={draft.parents_may_watch}
              onChange={(v) => set({ parents_may_watch: v })}
              label="Show the bus to guardians on its route while a run is open"
            />
          </div>
        </div>

        <FormGrid>
          <Field
            label="Map opens to a parent"
            hint="Minutes before the scheduled pickup, so watching starts when it is useful rather than all day. Only used when parents may watch."
          >
            <Input
              value={String(draft.watch_window_mins)}
              onChange={(v) => set({ watch_window_mins: num(v, draft.watch_window_mins) })}
            />
          </Field>
          <Field
            label="Stop circle"
            hint="Metres. The circle a stop gets when it has not been given its own — 120m survives the ±30m a phone reports in a built-up street."
          >
            <Input
              value={String(draft.default_geofence_m)}
              onChange={(v) => set({ default_geofence_m: num(v, draft.default_geofence_m) })}
            />
          </Field>
          <Field
            label="Tell me above"
            hint="km/h. The speed above which the office wants to be told — not the road's limit, which is the road's."
          >
            <Input
              value={String(draft.speed_limit_kmph)}
              onChange={(v) => set({ speed_limit_kmph: num(v, draft.speed_limit_kmph) })}
            />
          </Field>
          <Field
            label="Held over for"
            hint="Seconds. One fix reading high on a flyover is not rash driving, and an alert per flyover is an alert nobody reads by the second week."
          >
            <Input
              value={String(draft.speeding_hold_secs)}
              onChange={(v) => set({ speeding_hold_secs: num(v, draft.speeding_hold_secs) })}
            />
          </Field>
          <Field
            label="Close an unheard run after"
            hint="Minutes. Too long and a parent watches a marker that stopped moving an hour ago; a timed-out run is recorded as such, not as a completed drop."
          >
            <Input
              value={String(draft.trip_timeout_mins)}
              onChange={(v) => set({ trip_timeout_mins: num(v, draft.trip_timeout_mins) })}
            />
          </Field>
          <Field
            label="Default reporting interval"
            hint="Seconds, for a newly paired phone. Each handset can be retuned above."
          >
            <Input
              value={String(draft.ping_seconds)}
              onChange={(v) => set({ ping_seconds: num(v, draft.ping_seconds) })}
            />
          </Field>
          <Field
            label="Keep the trail for"
            hint="Days. An incident enquiry needs weeks; nobody needs years, and a fleet writes millions of positions a year."
          >
            <Input
              value={String(draft.retain_days)}
              onChange={(v) => set({ retain_days: num(v, draft.retain_days) })}
            />
          </Field>
        </FormGrid>
      </div>
    </Card>
  )
}
