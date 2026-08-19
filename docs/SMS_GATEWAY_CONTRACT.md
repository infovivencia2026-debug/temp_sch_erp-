# Phone SMS gateway — the wire contract

An Android phone with a SIM acts as the school's SMS provider. This is the
contract between it and the server; both halves are built against this file.

## Why the phone pulls

The obvious design has the server POST to the phone. It does not survive
contact with a mobile network: the handset is behind carrier-grade NAT with no
inbound route, its address rotates, and Doze will suspend a listening socket.
Port-forwarding works until the ISP renumbers.

So the phone polls. It is reachable from nowhere and reaches out to one place,
which is also the security posture you want on a device sitting in an office
drawer. `push` mode exists for a phone on the school's own LAN or behind a
tunnel, and is off by default.

## Enrolment

A phone is paired once, from the admin screen, using a short-lived code.

    POST /api/v1/sms-gateway/pair        (admin, sms_gateway.write)
      -> { pair_code: "8-char", expires_at }

    POST /api/v1/public/sms-gateway/claim  (unauthenticated, rate-limited)
      { pair_code, device_name, android_version, sim_operator }
      -> { device_id, device_token, institution, poll_seconds }

The token is the phone's only credential. It is shown once, stored sealed
server-side (`sealSecret`), and kept in Android's EncryptedSharedPreferences.
A pair code is single-use and expires in 10 minutes.

## The polling loop

    GET /api/v1/sms-gateway/outbox?max=20
      Authorization: Bearer <device_token>
      -> { messages: [ { id, to, body, attempt } ], poll_seconds }

Claiming is atomic: rows move to `dispatching` with the device id and a lease
expiry under `FOR UPDATE SKIP LOCKED`, so two phones on one school never send
the same message twice. A lease that expires unacknowledged returns to queued.

    POST /api/v1/sms-gateway/receipts
      Authorization: Bearer <device_token>
      { receipts: [ { id, status: sent|failed, sent_at, error?, parts? } ] }
      -> { accepted: n }

Receipts are idempotent on `id` — a phone that sends and then loses the network
before acknowledging will retry the receipt, and must not cause a second send.

    POST /api/v1/sms-gateway/heartbeat
      { battery_pct, charging, signal_dbm, sim_ready, app_version, sent_today }
      -> { poll_seconds, paused }

The heartbeat is how the admin screen knows the phone is alive. A gateway that
has not been heard from is worse than no gateway, because the school believes
messages are going out.

## Rules the phone must honour

- **Never send without a message id from the server.** No local composition.
- **One SIM, one rate.** Carriers throttle; the server sets `poll_seconds` and
  a per-minute cap, and the phone obeys rather than deciding for itself.
- **Report failure honestly.** A failed `SmsManager` result is `failed` with the
  reason, never a silent drop and never an optimistic `sent`.
- **Long messages are multipart.** Report `parts` so the school can see what a
  campaign actually costs.
- **Never log message bodies.** They contain children's names and fee amounts.

## What this is not

Not a replacement for a licensed bulk-SMS provider. Indian commercial SMS needs
DLT-registered sender ids and templates; a personal SIM sending hundreds of
messages will be throttled and may be disconnected. This is for a school of a
few hundred families sending tens of messages a day, and the admin screen says
so.
