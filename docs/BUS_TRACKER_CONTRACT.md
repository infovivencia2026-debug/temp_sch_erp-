# Bus tracker — the wire contract

The driver's own Android phone is the vehicle's GPS unit. This is the contract
between it and the server; both halves are built against this file.

It is written because the SMS gateway taught the lesson the hard way: the
contract did not name the rate-cap field, two workers building from it
independently arrived at `per_minute_cap` and `max_per_minute`, and neither
side failed, logged, or noticed. Every field below is named on purpose.

## Why the phone pushes, when the SMS gateway pulls

The SMS gateway polls because the server has work *for* it and cannot reach a
handset behind carrier-grade NAT. The tracker is the other way round: the phone
is the one holding data the server wants, so it POSTs. It still polls, but only
for configuration — how often to ping, whether it has been paused — and it gets
that answer back on every push rather than in a call of its own.

## Enrolment

A phone is paired once, from the transport screen, against **one named
vehicle**. The vehicle is chosen when the code is generated, not typed into the
handset: a driver entering a registration number is a driver mistyping one, and
the wrong bus on the map is worse than no bus at all.

    POST /api/v1/transport/trackers/pair       (admin, transport.write)
      { vehicle_id }
      -> { pair_code: "8-char", expires_at, valid_minutes }

    POST /api/v1/public/bus-tracker/claim      (unauthenticated, rate-limited)
      { pair_code, device_name, device_model, android_version, app_version }
      -> { device_id, device_token, institution, vehicle, ping_seconds }

The token is the phone's only credential. It is shown once, stored sealed
server-side (`sealSecret`, the same AES-GCM helper that protects the SMTP
password), and kept in Android's EncryptedSharedPreferences. A pair code is
single-use and expires in 10 minutes. Generating a code retires every other
unclaimed code for that school.

`vehicle` in the claim response is `{ id, registration_no }`, echoed so the app
can show the driver which bus it has become before it starts reporting. A
driver who sees the wrong registration must be able to stop there.

## The trip is the unit of visibility

**Nothing the phone reports outside an open trip is visible to a parent.**

The phone is the driver's own and it does not stop existing at 4pm. A live map
that shows a school employee at their own front door in the evening is
workplace surveillance that happens to be spelled "transport feature". So
position is filed against a trip, and a trip is opened deliberately.

    POST /api/v1/bus-tracker/trips              (device token)
      { route_id, direction: "pickup"|"drop", started_at }
      -> { trip_id, stops: [ { id, name, sequence, latitude, longitude,
                               geofence_m, scheduled_at } ] }

The stop list comes back with the trip so the app can evaluate geofences
offline. A bus in a dead zone still knows it has arrived somewhere.

    POST /api/v1/bus-tracker/trips/{id}/end     (device token)
      { ended_at, reason: "driver" }
      -> { ended: true }

A trip the server has not heard from for `trip_timeout_mins` is closed with
reason `timeout`. That is a different fact from `driver` and is kept as one:
only the driver ending a run means the children were dropped off.

One open trip per vehicle, enforced by a unique index. Opening a second closes
the first with reason `superseded`.

## Positions

    POST /api/v1/bus-tracker/positions          (device token)
      { trip_id,
        fixes: [ { recorded_at, latitude, longitude,
                   speed_kmph, heading_deg, accuracy_m } ] }
      -> { accepted: [recorded_at, ...], ping_seconds, paused, trip_open }

Batched, because a bus through a cellular dead zone must not lose twenty
minutes of history. Up to **200 fixes** per request.

`recorded_at` is when the **phone took the fix**, not when it uploaded — RFC
3339 with offset, e.g. `2026-08-19T14:32:05+05:30`. Filing buffered fixes at
receive time draws a straight line out of the dead zone.

The response returns `accepted` as the list of `recorded_at` values actually
stored, not a count. The gateway contract learned this: a count cannot tell the
phone *which* fix to stop retrying, so a partial accept becomes an all-or-
nothing retry. Duplicates are accepted silently — the unique index on
`(trip_id, recorded_at)` makes a replayed batch a no-op, which is what lets the
phone retry without thinking.

`trip_open: false` means the server closed the trip underneath the app, on
timeout or from the office. The app must stop reporting and tell the driver
rather than buffering into a trip that no longer exists.

**Clock skew.** A fix whose `recorded_at` is more than 24 hours from server
time is rejected with `422 skewed_clock` naming the server's time, because a
phone with a wrong clock writes history that cannot be untangled later. Inside
that window the phone's time is trusted; it is the one that was there.

## Heartbeat

    POST /api/v1/bus-tracker/heartbeat          (device token)
      { battery_pct, charging, location_ok, app_version }
      -> { ping_seconds, paused, notices: [ { id, body, sent_at } ] }

`location_ok` is the field the office actually needs. A phone that is online,
charged, and reporting `location_ok: false` — permission revoked, or the OS
denying background location — is the exact failure where everything looks
healthy and the bus is not on the map.

`notices` are the office's messages to this bus that nobody has tapped OK on
yet (see below). An older server omits the key; the phone treats that as none.

## The children

    GET  /api/v1/bus-tracker/trips/{id}/roster       (device token; session read if sent)
      -> { trip_id, direction, leg,
           students: [ { id, name, admission_no, class, stop_id, has_photo,
                         absent, absent_reason, status, marked_at } ] }

Every child allocated to the trip's route, with the stop they use on this leg
(`pickup_stop_id` for pickup, `drop_stop_id` for drop; empty when none is set).
`absent` is somebody else's word — a parent's report through the portal or the
class register — and the phone greys the card rather than letting the driver
wait. `status` is the driver's own mark for today's leg: `boarded`,
`alighted`, `absent`, or empty.

    POST /api/v1/bus-tracker/trips/{id}/boarding     (device token; session read if sent)
      { marks: [ { student_id, status, at } ] }
      -> { accepted: [student_id, ...] }

Batched and idempotent on `(student, day, leg)`, for the same reason positions
are: the phone keeps a mark on disk until the server names it in `accepted`.
`at` is when the driver tapped, RFC 3339. A child not on this route is skipped,
not an error. `leg` is `morning` for a pickup run and `afternoon` for a drop.

    GET  /api/v1/bus-tracker/students/{id}/photo     (device token)
      -> image bytes, or 404

Only for a child currently allocated to a route this bus runs. Nothing but the
image leaves; a wrong id and a child with no photo are the same 404.

## Notices

    POST /api/v1/bus-tracker/notices/{id}/ack        (device token; session read if sent)
      -> { acknowledged: true }

The office writes a notice to a vehicle (`POST /api/v1/transport/vehicles/{id}/notices`,
`transport.write`). It rides down on the heartbeat until the driver taps OK,
which is this call, or until it expires twelve hours after sending. The office
sees who tapped and when.

## What the server decides and the phone obeys

`ping_seconds` (5–300) and `paused` come back on every push. The phone does not
choose its own interval: battery is the school's trade against freshness, and a
handset picking for itself is a handset flat by two o'clock.

## Errors

| Status | Code | Meaning |
|---|---|---|
| 401 | `unauthorized` | token unknown, revoked, or CREDENTIAL_KEY rotated — re-pair |
| 404 | `no_such_trip` | trip id not this device's, or already closed |
| 409 | `trip_already_open` | opening a trip while one is open, when `supersede` was not set |
| 422 | `skewed_clock` | a fix more than 24h from server time; body carries `server_time` |
| 429 | `too_fast` | pushing faster than `ping_seconds` allows; body carries `retry_after` |

Every error body is `{ error: { code, message } }`, the shape `httpx.Error`
already emits everywhere else in this API.

## What this does not make possible

Naming it here so the app is never asked for it:

- **Fuel level and mileage telematics** need a sensor in the tank.
- **Cabin video and seatbelt monitoring** need cameras.
- **AIS-140 / VAHAN compliance** is a certification of a specific device, not a
  shape of data. A phone is not an AIS-140 unit, and software claiming the
  compliance would be a false statement to a transport authority rather than
  merely an empty screen.
