# School Bus Tracker

An Android app that turns the driver's own phone into the bus's GPS unit.

The driver opens a run, the phone reports where the bus is for as long as that
run is open, and the driver closes it. Between runs the app collects nothing.
It is a tracker for a school route, not a tracker for a person.

The wire protocol it speaks is `docs/BUS_TRACKER_CONTRACT.md` at the root of
this repository. That file is authoritative for both halves — this app and the
server endpoints — and this app implements it as written. Where the contract is
silent, this README says so rather than the code guessing.

This is the second app of this shape in the repo. It is deliberately a sibling
of `mobile/apps/sms-gateway`: same Gradle setup, same package layout, same
EncryptedSharedPreferences use, same foreground-service-plus-WorkManager
arrangement. If you have read that one, you have read most of this one.

## Why the phone pushes, where the gateway polls

The SMS gateway polls because the server has work *for* it and cannot reach a
handset behind carrier-grade NAT. This is the other way round: the phone holds
the data the server wants, so it POSTs. It still needs configuration —
how often to report, whether it has been paused — and it gets that back on
every push rather than in a call of its own.

## The trip is the unit of visibility

Nothing this app reports outside an open trip is visible to anyone.

The phone belongs to the driver and does not stop existing at 4pm. A live map
that shows a school employee at their own front door in the evening is
workplace surveillance that happens to be spelled "transport feature". So:

- the location subscription is torn down the moment the run ends;
- the foreground service is started when the driver presses **Start Run** and
  stopped when they press **End Run** — not at boot, and not on app launch;
- `BootReceiver` schedules a *check* for an interrupted run, and resumes only
  if one is genuinely open. A tracker that started itself on every boot would
  be following a driver home.

## Pairing

1. In the admin console, open the transport screen and generate a pairing code
   **against the specific vehicle**. It is 8 characters and expires in ten
   minutes. The vehicle is chosen there, not typed into the handset: a driver
   entering a registration number is a driver mistyping one, and the wrong bus
   on the map is worse than no bus at all.
2. On the phone, open **School Bus Tracker**.
3. Enter the school's server address — it must start with `https://`.
4. Type the pairing code. Spaces and hyphens are ignored, so `ABCD-2345` works.
5. Press **Pair**.

The app then shows the **vehicle registration** the server sent back and asks,
in as many words, whether that is the bus you are driving today. **Read it.**
That is the last point at which a mis-pairing can be stopped. Pressing "No —
stop" unpairs immediately.

The device token is stored in Android's `EncryptedSharedPreferences`, backed by
a keystore-held master key, and is never written to a log. If the server ever
rejects it, the app unpairs itself and says so rather than retrying a dead
credential for ever.

## Starting a run

Pick **Pickup** or **Drop**, then press **Start Run** next to the route.

The server answers with the trip id *and the stop list, including each stop's
geofence radius*. Those radii are stored on the phone, which is what lets it
tell the driver "Reached Anna Nagar" inside a tunnel with no signal. The
school's own record of arrivals is still the server's — it walks the same
geofences from the same radii when the fixes land — so a phone with a wandering
GPS can mislead its own driver for a second and cannot mislead a parent at all.

**Ending a run matters.** Only `End Run` records the run as ended by the
driver, which is the fact that means the children were dropped off. A phone
that simply stops is closed by the server's timeout sweeper instead, and that
is a different and weaker fact.

## Routes: the one gap in the contract

The contract has no device-facing endpoint that lists routes. `POST
/bus-tracker/trips` takes a `route_id` uuid and nothing hands the phone the
uuids to choose from.

Rather than invent a field the server does not send, this app keeps a local
**route book**: whoever sets the phone up adds each route once, pasting the
route id from the transport screen and giving it a name the driver will
recognise ("Morning — Anna Nagar"). After that the driver picks by name. It is
a setup task done with the office, not something anyone does at 6:40am.

If a `GET /bus-tracker/routes` is ever added to the contract, replacing the
route book with it is a small change confined to `SettingsStore` and
`RunViewModel`.

## Battery, permissions and Doze — the whole engineering problem

### The two-stage location permission

Location has to be asked for in two steps, and the order is enforced by the
platform, not chosen for style:

1. `ACCESS_FINE_LOCATION` (+ coarse, + notifications) in the first request.
2. `ACCESS_BACKGROUND_LOCATION` **on its own, afterwards**.

From Android 11, a request that bundles background location with the
foreground ones is denied outright without showing the user anything, and from
Android 11 the background request does not present a dialog at all — it opens
the app's location settings page, where the driver must choose "Allow all the
time" themselves. An app that fires both at once looks like it asked and
silently has neither. The prompt therefore explains what each grant buys before
either system dialog appears.

Coarse-only is treated as **not working**. A cell-tower fix on the office map
is a bus in the wrong street, which is worse than a bus that is honestly
missing.

### Why `foregroundServiceType="location"`

The service is declared `android:foregroundServiceType="location"` and the app
declares `FOREGROUND_SERVICE_LOCATION`. All three of these matter:

- **Android 10+** stops delivering location to an app that is not visible
  unless it is running a foreground service *typed for location*. Without the
  type the fixes simply stop when the driver puts the phone down — which is
  most of a run — and nothing errors.
- **Android 14+** refuses to start a typed foreground service when the matching
  permission is not declared, and refuses a `location` service outright when
  the location permission is not held. `startForeground` throws
  `SecurityException`; the service catches it, tells the driver the permission
  is missing, and stops, rather than sitting there looking alive.
- **Not `dataSync`**, which would compile and run: from Android 15 a `dataSync`
  service is capped at roughly six hours in any 24, which a two-shift bus
  reaches, and it would still not license background fixes.
- **Not `specialUse`** — which is what the SMS gateway correctly uses, because
  its work has no other category. This one has an exact category, and using it
  is what makes the OS grant the location.

### Doze, and battery optimisation

A location foreground service is exempt from Doze while it runs, so Doze is not
what stops the fixes. What thins them out is OEM battery management on a phone
lying still on a dashboard: the fixes keep arriving but unevenly, and the map
shows a bus that jumps a kilometre at a time. The run screen offers the
"allow unrestricted" system dialog with that explanation next to it. The app
never asks for it silently, and never asks at all until the driver is looking
at the screen.

`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is declared and only ever reached from
that button.

### Spending as little battery as the school allows

- The location subscription asks the OS for the server's `ping_seconds` as its
  interval, so the radio sleeps between fixes. Requesting continuous updates
  and discarding most of them is how a tracking app flattens a battery before
  lunch.
- `ping_seconds` and `paused` come back on **every** push and every heartbeat
  and are obeyed, clamped to the contract's 5–300. The phone never picks its
  own interval: battery is the school's trade against freshness.
- The heartbeat runs at three times the ping, floored at a minute and capped at
  five. It carries no position and is not what keeps the map fresh.
- No minimum-distance filter. A bus stationary at a stop for ten minutes must
  still report, or the office cannot tell it apart from a phone that has died.
- The platform `LocationManager` is used rather than Play Services' fused
  provider. That avoids a dependency and a hard requirement on a
  Play-certified handset — including the phones sold in India with no Play
  Services at all. Fused would give slightly smoother fixes; a bus that cannot
  be tracked because the driver's phone is not Google-blessed is a worse trade.

## The dead zone

Every fix is written to SQLite *before* anything tries to upload it. Uploading
is a separate loop reading from that buffer.

- Batches of at most **200**, oldest first — the dead-zone history is what is
  at risk, and sending the newest fix first would leave the tunnel unsent.
- The server answers with `accepted`: the list of `recorded_at` values it
  actually stored, not a count. **Only those rows are deleted.** A partial
  accept costs a retry, never a hole in the history.
- The acknowledgement is matched **on the instant, not the string**. The server
  formats its answer in its own zone, so a fix sent as
  `2026-08-19T14:32:05+05:30` comes back as `2026-08-19T09:02:05Z`. Comparing
  text would acknowledge nothing, the buffer would never drain, and the bus
  would re-upload its whole morning on every ping.
- `recorded_at` is truncated to whole seconds, because the server round-trips
  it through Go's `time.RFC3339`, which has no sub-second part. Two fixes
  inside one second would otherwise both match one acknowledgement.
- `recorded_at` is when the **phone took the fix**, never when it uploaded.
  Filing buffered fixes at receive time draws a straight line out of the dead
  zone the bus actually crawled through.
- A push that succeeds and leaves fixes behind loops immediately instead of
  waiting a ping, so a bus coming out of a tunnel with an hour of history
  catches up in seconds rather than staying behind the bus for the rest of the
  route.

`trip_open: false` stops everything. The app abandons the run, raises a
high-importance notification saying the school closed it, and stops the
service — rather than buffering into a trip that no longer exists.

## The map on the run screen

Google Maps, through `maps-compose`. The run screen draws the route line,
numbered stop markers and a bus arrow on it, heading-up with the bus in the
lower third while a run is on, north-up with the whole route in frame from
the yard. The map's own blue dot is off: the app's location pipeline is the
one source of the bus's position.

The key is `MAPS_API_KEY` in `secrets.properties` at the project root
(git-ignored; the Secrets Gradle Plugin puts it in the manifest). A checkout
without that file builds against the empty key in `local.defaults.properties`
and draws a blank map. A night style in `res/raw/map_style_night.json` is
applied when the phone is in dark mode.

The earlier **stops-to-scale sketch** (`RouteSketch`) is still in the tree
for a phone with no signal: longitude is scaled by cos(latitude) so the
arrangement of stops is not stretched, and both axes share one scale, so the
sketch cannot lie about distance.

## The honest limits

Named here so the app is never asked for them:

- **Fuel level and mileage telematics** need a sensor in the tank.
- **Cabin video and seatbelt monitoring** need cameras.
- **AIS-140 / VAHAN compliance** is a certification of a specific device, not a
  shape of data. A phone is not an AIS-140 unit, and software claiming that
  compliance would be a false statement to a transport authority rather than
  merely an empty screen.
- **Accuracy is the phone's accuracy.** Under a flyover or between tall
  buildings the fix wanders, and the app reports `accuracy_m` honestly rather
  than smoothing it into a confident lie.
- **A phone with a wrong clock is refused**, not corrected. More than 24 hours
  from server time and the server answers `422 skewed_clock`; the app drops
  that batch, tells the driver the clock is wrong, and keeps going, because
  retrying it forever would wedge every later fix behind it.

## Privacy

- Nothing is collected outside an open run. The location subscription does not
  exist between runs.
- No coordinate is ever written to a log. `BtLog` is the only thing in this app
  that touches `android.util.Log`, and log lines carry counts, trip ids and
  outcomes. A latitude/longitude pair in logcat is the driver's home address on
  the evening they forgot to end a run.
- Ktor's `Logging` plugin is deliberately not installed, in debug or release: a
  request body here is a minute-by-minute record of where a bus full of
  children has been.
- The token is never in a log or a `toString`. `ClaimResponse.toString()`
  redacts it explicitly.
- Cloud backup and device transfer are refused outright in
  `data_extraction_rules.xml`. A restored copy of this app on a second phone
  would report a second position for the same bus.
- `READ_CONTACTS`, `RECORD_AUDIO`, `CAMERA` and `READ_PHONE_STATE` are stripped
  from the manifest with `tools:node="remove"`, so a future dependency cannot
  quietly merge one in.

## Building

```
./gradlew :app:assembleDebug          # a debug APK
./gradlew :app:testDebugUnitTest      # the unit tests (no device needed)
./gradlew :app:connectedDebugAndroidTest   # the Room buffer tests; needs a device
```

Requires an Android SDK; point `ANDROID_HOME` at it or write `sdk.dir` into
`local.properties` (which is not, and must not be, committed). The build uses a
Java 17 toolchain and will provision one if the machine has a different JDK.

There is no signing configuration and no `keystore.properties`. `assembleRelease`
produces an **unsigned** APK; whoever ships this adds signing separately.
`*.jks`, `*.keystore`, `keystore.properties` and `local.properties` are all
gitignored: never commit signing material.

## Layout

```
app/src/main/kotlin/com/schoolerp/bustracker/
  core/         BaseUrl, PairCode, Rfc3339 (format and acknowledgement matching),
                Geo (haversine + geofence slack), BtLog
  data/remote/  Ktor client, the DTOs for the five contract endpoints, and
                ApiFailures — the contract's error table in one testable place
  data/local/   Room: the fix buffer and the trip's stop list
  data/prefs/   DataStore for settings, the open run and the route book;
                EncryptedSharedPreferences for the token
  data/repo/    TrackerRepository — pair, open, buffer, push, end, heartbeat
  device/       LocationSource, LocationPermissions (the source of location_ok),
                DeviceStatusProvider
  engine/       TripEngine's three loops, the status aggregator, GeofenceWatcher
  service/      the location foreground service, boot receiver, WorkManager net
  ui/           two Compose screens: pair, and run
```

The order of operations that matters most: **fix, persist, then upload.** A fix
is in SQLite before any request is attempted, so a dead zone, a crash or a
process kill costs nothing. And the buffer's primary key is
`(tripId, recordedAtSeconds)` — the same key the server's unique index uses —
so a retried batch cannot duplicate anything and an acknowledgement identifies
exactly one row to delete.
