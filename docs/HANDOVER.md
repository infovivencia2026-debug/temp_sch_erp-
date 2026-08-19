# Handover — continuing on another machine

Written 19 Aug 2026. Everything below is fact checked against the repo and the
running server at the time of writing, not recollection.

## 1. The one thing you cannot recover if you lose it

**The Android release signing key.**

    /home/qb/.keystores/sms-gateway.jks          the key
    /home/qb/.keystores/sms-gateway.pass         its password
    /home/qb/.keystores/backup/sms-gateway-keystore.tar.gz   both, bundled

It is **not in git and must never be**, so `git clone` on the new machine will
not bring it. Copy that tarball across by hand — a USB stick, `scp` from your
own shell, a password manager, anything you control.

Android ties app updates to the signing key. Lose it and no future build can
update an installed app: every school would have to uninstall, losing its
pairing, and re-pair a fresh install. There is no recovery path and no support
desk that can help.

    Certificate SHA-256:
    70:11:18:A6:FF:1E:B1:E3:8A:E0:D8:6F:D2:F4:BE:A2:50:D8:D7:11:39:EF:C6:0E:D9:39:31:FD:6A:DE:28:9A
    Valid until 11 Aug 2056.

On the new machine, put the two files somewhere with mode 600 and write
`mobile/apps/sms-gateway/keystore.properties` (gitignored) pointing at them:

    storeFile=/path/to/sms-gateway.jks
    storePassword=<contents of sms-gateway.pass>
    keyAlias=sms-gateway
    keyPassword=<same>

Absent that file the release build still succeeds — it just produces an
unsigned APK rather than failing, which is the trap to know about.

## 2. Where the code is

- Branch **`operational-erp`** is the working branch. **`main`** and
  **`sony`** are kept level with it.
- Another session has been pushing to `sony`/`main` in parallel all day.
  **Always `git fetch` and check before assuming yours is ahead** — see §6.
- Production runs from **`main`**, built on the server.

## 3. Standing up a new machine

Postgres, Go 1.25+, Node, and for the app: Android SDK + JDK 17 toolchain.

    createdb school_erp                       # owner erp_owner
    cp .env.example .env                      # then fill it in
    make migrate
    make demo                                 # seeds a school and one user per role
    make dev

`.env` needs `DATABASE_URL`, `SESSION_SECRET` (≥32 bytes), `PASSWORD_PEPPER`
and `CREDENTIAL_KEY`. **Tests need `CREDENTIAL_KEY` too** — without it the SMS
gateway tests fail with "refusing to store a password in clear", which looks
like a code defect and is not.

    go build ./... && go vet ./internal/...
    TEST_DATABASE_URL=... ERP_TEST_DATABASE_URL=... CREDENTIAL_KEY=... go test ./internal/... ./tests/...
    cd web && npx tsc --noEmit

**Never run `npm run build` or `vite` while agents are working** — it is the
single biggest memory consumer and this machine had ~2 GB spare all day.
Deploys build on the server for exactly that reason.

## 4. Deploying

    ssh root@187.127.178.100 'BRANCH=main bash -s' < scripts/build-on-server.sh

Builds Go and the SPA on the server from git, migrates, restarts. `make deploy`
also exists but builds locally — prefer the server one.

**Back up first, and check the backup.**

    ssh root@187.127.178.100 "sudo -u postgres pg_dump temperp | gzip > /var/backups/temperp/pre-deploy-$(date +%F-%H%M).sql.gz"

Dump **as `postgres`, not as the app role**: every table has
`FORCE ROW LEVEL SECURITY`, so an app-role dump silently truncates. It produced
a 63 KB file for a 513 KB database and looked like it had worked. Always
`gzip -t` and check the size.

Live: **https://temperp.187-127-178-100.sslip.io** — service `temperp-web`,
database `temperp`, webroot `/var/www/temperp`. There is a second unrelated
deployment on the same host at `erp.187-…` (`school-erp-web`, database
`school_erp`); do not confuse them.

## 5. Where things stand

**452 catalogued, 414 built, 38 deferred** — see `docs/DEFERRED.md`, which also
records four open security decisions and six known defects.

Deployed and working: everything except the three below.

**Not finished, in priority order:**

1. **The APK is built but not published.** It is at
   `mobile/apps/sms-gateway/app/build/outputs/apk/release/app-release.apk`
   (2.0 MB, signed, `sha256 f881faf2…`). What remains: put it in
   `/var/www/temperp/`, publish the certificate fingerprint beside it so an
   administrator can verify what they installed, add a download link and QR to
   the pairing screen, and add a version endpoint so the app can tell a school
   it is outdated — there is no store to do that.
   **Google Play is not an option**: `SEND_SMS` is restricted to default SMS
   handlers. Sideloading is the route, which is why the foreground service is
   `specialUse` rather than `dataSync` (the latter is capped at ~6h/day from
   Android 15 and would stop a school's messages every afternoon).
2. **WhatsApp is deployed but unconfigured** — zero provider rows, zero
   allowlist entries. Needs the System-User token, the phone-number and WABA
   ids, and **at least one Meta-approved template**. Outside a 24-hour window
   WhatsApp permits only approved templates, so the code refuses free text by
   design rather than failing against a real parent. Template approval takes
   Meta time — start it before writing any more code.
3. **The recipient allowlist sends to nobody until configured.** That is
   deliberate: no policy row means an empty allowlist means no recipients. Add
   `+91 9100575183` on the messaging screen or nothing goes out.

## 6. Things that cost time today — do not rediscover them

- **`origin` was behind local three times.** A `git reset --hard origin/<branch>`
  would have destroyed merged work, including once the very commit the worker
  was told to build on. Reset to an explicit SHA, never a branch name.
  `docs/AGENT_CONTRACT.md` §0 was rewritten for this.
- **Migration numbers collide constantly** when several people work at once.
  goose refuses anything numbered below the current version, so a migration
  written today may need renumbering above whatever landed first. Eight were
  renumbered today. Numbering has gaps — never infer a version from a file count.
- **goose's statement splitter breaks on a `;` inside a `/* */` comment.** Use
  `--` comments in migrations. Four workers lost a run to this.
- **A UNIQUE index containing a nullable column enforces nothing**, because a
  NULL is distinct from every other NULL. `COALESCE(col, '0000…'::uuid)`. This
  has been hit eight times, including one index unenforced since migration
  00008.
- **A form initialising state from props keeps the previous record's values**
  when the parent swaps the prop. `key={record.id}`. Ten shipped bugs of this
  exact shape, including a counselling message that could be sent to the wrong
  family and a GST rate written onto the wrong fee head.
- **`files.owner_type` / `owner_id` are dead columns** — never written by
  anything. Attach files with a typed join table holding `file_id`.
- **`web/node_modules` is absent in fresh worktrees**; `tsc` needs it.
- Two halves of an integration will disagree on a field name if the contract
  does not state it. `per_minute_cap` vs `max_per_minute` cost a silent
  misbehaviour that nothing logged.
