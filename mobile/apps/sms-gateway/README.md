# School SMS Gateway

An Android app that turns a spare phone with a SIM into the school's SMS sender.

It polls the school's server for queued messages, sends them through the
handset's radio, and reports back what actually happened to each one. It is a
worker, not a messaging app: it cannot compose a message, it never reads your
inbox, and it does not ask for access to your contacts.

The wire protocol it speaks is `docs/SMS_GATEWAY_CONTRACT.md` at the root of
this repository. That file is authoritative for both halves — this app and the
server endpoints — and this app implements it as written.

## Why the phone pulls rather than the server pushing

A handset on a mobile network sits behind carrier-grade NAT with no inbound
route, its address rotates, and Doze suspends a listening socket. So the phone
reaches out, on an interval the server sets. That is also the security posture
you want for a device that lives in an office drawer: it is reachable from
nowhere and talks to exactly one place.

## Pairing

1. In the admin console, open the SMS gateway screen and generate a pair code.
   It is 8 characters and it expires in ten minutes.
2. On the handset, open **School SMS Gateway**.
3. Enter the school's server address — it must start with `https://`.
4. Type the pair code. Spaces and hyphens are ignored, so `ABCD-1234` is fine.
5. Press **Pair**.

The app shows the school's name back to you. **Read it.** That is the only
check that you typed the code for the right school; if it is wrong, unpair from
the status screen and ask for a new code.

The device token the server returns is stored in Android's encrypted
preferences, not in plain settings, and it is never written to a log. If the
server ever rejects it, the app unpairs itself and says so rather than retrying
a dead credential for ever.

## Permissions, and why each one

The app asks for three permissions, with the reason on screen before the
system dialog appears.

| Permission | Why | If you refuse |
| --- | --- | --- |
| **Send SMS** | Every message the school sends leaves through this SIM. | Nothing is sent. The status screen says so in as many words, and claimed messages are reported to the server as failed rather than sitting in a queue for ever. |
| **Notifications** | The permanent notice is what keeps the app running in the background. It is not decoration — Android stops a foreground service that cannot show one. | The gateway stops within minutes of the screen going off. |
| **Phone state** | Reports signal strength in the heartbeat, so the office can see that a phone is in a bad spot. | Sending is unaffected. The heartbeat omits `signal_dbm` rather than inventing a number. |

Two further permissions are declared but not "runtime" permissions: starting at
boot, and asking to be exempt from battery optimisation (see below).

**What it deliberately does not ask for.** `RECEIVE_SMS`, `READ_SMS`,
`READ_CONTACTS` and `READ_PHONE_NUMBERS` are explicitly stripped in the
manifest with `tools:node="remove"`, so that a future dependency cannot quietly
merge one in and ship a school an app that reads its staff's inbox.

## Keeping it alive

This is the part that decides whether the app actually works.

- **Use a dedicated handset.** Not somebody's personal phone. It should do
  nothing else, and nobody should be swiping the notification away or clearing
  the recents list.
- **Leave it on a charger**, and preferably a good one. A phone that dies at
  2pm is a school that stops sending at 2pm.
- **Grant the battery-optimisation exemption.** The status screen offers a
  button for it with an explanation. Without it, Doze suspends polling once the
  phone has sat still for a while — which is exactly what a phone in a drawer
  does.
- **Do not swipe away the notification.** It is the app's proof of life and its
  licence to keep running.
- **Check the status screen occasionally.** It shows the paired school, when
  the phone last reached the server, how many messages went out today, what
  failed and why. Better still, watch the heartbeat on the admin console: a
  gateway that has not been heard from is worse than no gateway, because the
  school believes messages are going out.
- Some manufacturers (Xiaomi, Oppo, Vivo, Realme, Samsung) add their own
  aggressive app-killing on top of Android's. On those handsets also enable
  "Autostart" and set the battery policy for this app to "No restrictions" or
  "Allow background activity" in the manufacturer's own settings app.

After a power cut the app restarts itself on boot. A WorkManager job also
checks every fifteen minutes that the service is running, and restarts it if
something killed it — and flushes any unreported receipts even if it cannot.

## The honest limits

**This is not a replacement for a licensed bulk-SMS provider.**

- **Carrier throttling.** Indian carriers watch personal SIMs for bulk
  behaviour. A SIM that emits hundreds of messages in a burst will be
  throttled, and can be disconnected outright. The app obeys a per-minute cap
  and the polling interval the server gives it, and the cap is deliberately
  conservative (10 a minute by default). Do not raise it because a campaign is
  running late.
- **DLT.** Commercial and transactional SMS in India is governed by TRAI's
  DLT regime: registered sender IDs, registered templates, registered consent.
  Messages sent from an ordinary personal SIM through this app are not
  DLT-registered. That is legally and practically fine for a school messaging
  its own parents at modest volume, and it is *not* fine as a marketing channel.
  If you are running admissions campaigns, buy a licensed provider.
- **Volume.** This suits a school of a few hundred families sending tens of
  messages a day — absence notices, fee reminders, a closure announcement. It
  does not suit a bulk campaign to thousands of numbers.
- **Cost.** Every part of a multipart message is a chargeable SMS. Long
  messages, and any message containing non-GSM characters (Telugu, Hindi, or a
  stray curly quote pasted from Word), are split into far more segments than
  people expect. The app reports the real part count in each receipt so the
  school can see what a send actually cost.
- **Delivery reports are unreliable.** The app reports `sent` on the radio's
  send result, which is what the contract asks for. Carrier delivery reports
  arrive later, sometimes not at all, and are recorded separately for the status
  screen rather than held against the receipt.
- **A lost send result.** If the process is killed between handing a message to
  the radio and the radio reporting back, the app does not know what happened.
  After ten minutes it reports `failed` with `no_send_result` — honest, but it
  means the server may re-queue a message that did in fact go out. A rare
  duplicate is the lesser evil against a fee reminder that silently never
  arrived.

## Privacy

Message bodies are children's names, fee amounts and absence notices.

- **No body is ever logged.** Logging carries message ids and outcomes only.
  This is enforced three ways: all logging goes through `GwLog`; the body type
  `MessageBody` redacts itself in `toString`, so interpolating one into a log
  line, a crash report or an exception message yields only a length; and a
  custom Android Lint rule, `SmsBodyLogged`, fails the build on any log call
  that mentions a body. Ktor's HTTP logging plugin is deliberately not
  installed, in debug builds too.
- **Bodies are erased as soon as they are settled.** Once a message has an
  outcome, its text is blanked in the database. What remains is an id, a time
  and a result — enough for the status screen and the receipt, and nothing a
  stranger who picks up the phone could read.
- **Nothing is backed up.** Cloud backup and device transfer are both refused
  for this app; re-pair instead of restoring.
- **HTTPS only.** A release build refuses `http://` outright, both at the
  manifest level and in `BaseUrl.parse`. Debug builds can be pointed at a
  laptop on the LAN, but only after the operator switches on an explicit
  "allow plain http" toggle in the app.

## Building

```
./gradlew :app:assembleDebug          # a debug APK
./gradlew :app:testDebugUnitTest      # the unit tests
./gradlew :lint-rules:test            # the tests for the body-logging rule
./gradlew :app:lintDebug              # runs SmsBodyLogged over the app
```

Requires an Android SDK; point `ANDROID_HOME` at it or write `sdk.dir` into
`local.properties` (which is not, and must not be, committed). The build uses a
Java 17 toolchain and will provision one if the machine has a different JDK.

Release signing is read from an untracked `keystore.properties` beside
`settings.gradle.kts`:

```
storeFile=/absolute/path/to/release.jks
storePassword=…
keyAlias=…
keyPassword=…
```

Without it, `assembleRelease` produces an unsigned APK rather than failing.
`*.jks`, `*.keystore`, `keystore.properties` and `local.properties` are all
gitignored: **never commit signing material.**

## Layout

```
app/src/main/kotlin/com/schoolerp/smsgateway/
  core/         BaseUrl, PairCode, MessageBody (the redacting body type), GwLog
  data/remote/  Ktor client and the DTOs for the four contract endpoints
  data/local/   Room: the claimed-message queue and send log
  data/prefs/   DataStore for settings; EncryptedSharedPreferences for the token
  data/repo/    GatewayRepository — claim, persist, send, report, heartbeat
  sms/          SmsSender, the sent/delivered receiver, failure vocabulary
  engine/       the five loops, the rate limiter, backoff, status rules
  service/      the foreground service, boot receiver, WorkManager safety net
  ui/           two Compose screens: pair, and status
lint-rules/     the SmsBodyLogged detector
```

The order of operations that matters most: **claim, persist, then send.** Rows
are committed to SQLite before anything reaches the radio, so a crash between
the claim and the send loses nothing. And the primary key is the server's own
message id, so a re-delivered id cannot become a second SMS to a parent.
