# What the owner asked for, and where each thing stands

One list for every session. The integrating session keeps it current, merges
everything into `main`, checks each item on the test site and deploys.
**Other sessions: when the owner asks you for something, add a line here in the
same commit as the work**, so nothing asked in one session is lost or undone by
another. Status: `live` (on the test site and on `main`), `building`,
`waiting` (needs the owner), `clash` (two sessions were asked different things).

Last checked: 2026-10-02.

## Live

| Asked | Where |
|---|---|
| Class Status: photo, video and text statuses, 24h, rings on home, viewer, views, school side, approval | Communication > Class Status; rings on every home |
| Status in the notification panel, media previews, Add (Photo / Video / Camera / Text), unseen count | Bell panel |
| LMS = Subjects > Modules; modules hold sub-modules and any content; kid-friendly; Back / Next kept | Student > LMS |
| "E-Learning Resource Hub" renamed LMS | Student menu |
| Bento app icons as 1:1 tiles, All-features look, one-word labels; four to a tile on desktop | Focus home |
| Board fills to the dock; no space under it but the page dots | Focus home |
| No empty band under any phone page; one bottom reserve | Every phone page (3,216 measured) |
| Phone dock is a floating rounded pill | Phones |
| Work icon out of the dock; no Dock settings on phones | Dock, Settings |
| Settings screen on phones | Settings |
| Theme-matched scrollbars, old browsers included | Everywhere |
| Page tabs are rounded pills; Communication "Where to go" is buttons | Tabs; Teaching > Communication |
| Smooth press, sliding tab pills, Focus <-> Work cross-fade, dialog exits | Everywhere |
| Show it first, save after (optimistic), with rollback and Retry | Notifications, approvals, register Save, chat, delete with Undo, pins, reorder |
| ChatGPT-style assistant chat on phones | Assistant |
| All features: search pill at the bottom, fuzzy search, results pop in, bigger icons, no underline | All features |
| Text areas grow with their lines | Everywhere |
| Haptics only at decisions; Haptics switch | Settings > Appearance |
| Dark mode on phones readable in every palette | Phones |
| Solid system colours where they mean something (Apple / Google style) | Switches, status, badges, workspace accents |
| Motion kit from the owner's list | docs/motion-kit.md |
| Colour wheel has Done; tick on chosen, cross on the rest | Settings > Colour |
| Every element listed and checked | docs/ui-elements.md, Elements gallery |
| Backend: fewer queries per request, 13 indexes, feature-switch cache, status gaps | Worker |
| Phone home is a 4 x 5 page: cards 2x2, 2x4, 4x4 only (no Tall on phones); icons 1x1 or 1x2 by the Icon size setting | Focus home on phones |
| Bento card: one round arrow; the menu on a long press (right-click or keyboard on desktop) | Focus home |
| Page dots never overlap the dock or the cards: their own band, 9px from each | Phone home (measured 390 and 360, three roles) |
| Deploy guard and rule; always push main | scripts/deploy-guard.sh, CLAUDE.md |

## Building

| Asked | Notes |
|---|---|
| Animations never cut off part-way | Restarted 2026-10-02 (a restart lost the first attempt) |
| Help Centre (Mac / iPhone / Windows style) and seller support desk, maintainable at 10 schools | Built on `main` 2026-10-03, not yet on the test site: Help (? key, top bar, Settings > Account > Help), requests answered by the school's Helpdesk first then XULO support (no child's name ever sent), error Ref codes, Me too, troubleshooters, three-pane desk, Quick Assist (read-only), known issues, reports, help content edited once for every school. Telugu: Help Centre chrome only; articles English until read by a Telugu speaker |
| User guide for every role, as one HTML book | Restarted 2026-10-02 |
| Every screen checked for silly UI mistakes | 2026-10-03: all routes x 4 accounts crawled (2,122 loads); 16 root causes fixed (4 blockers incl. cut money figures, restore crash, dark brand ink, phone gutters); open: page dots on last card, ISO dates, polish contrast; seller Controls dark not reachable |

## Done on `cloudflare-workers`, not deployed (session of 2026-10-01/02; needs the Worker and tenant migrations 0024-0026)

| Asked | Where | Note for the integrator |
|---|---|---|
| Notification pressed: open in full, with a button to its screen | Bell panel | Live already |
| "Make the seller admin and support real", for real people | Seller > Support > Team, Support tickets | `/seller/staff` routes; support logins hold only the ticket queue; a support login enters a school only on a recorded session (tenant 0025 rebuilds `impersonation_grants`). Overlaps the Help Centre / support desk item under Building: reconcile, do not duplicate |
| Ticket queue shows SLA and who holds each ticket | Support tickets | tenant 0024 |
| Class Status "good and efficient" | Class Status | Feed signs media, thumbnail and seen addresses per viewer: 1 read instead of 11; no feed reload per post seen. `status_perf.test.ts` holds the ceilings |
| Stats: detailed, descriptive, interactive (Neon / Cloudflare style) | Shared `Stat` (`components/stat-extras.tsx`); used on Support tickets, Team, Status "Seen by", Enquiry links | Other screens take `parts`, `trend`, `detail` as they are revisited |
| Enquiry and CRM: a link the parent fills in; application details that need no hard copy; customisable | Admissions > Enquiries > Enquiry links; lead panel "Send application link"; form builder field type "Bring to school (hard copy)" | tenant 0026 `enquiry_links`; public page `/admissions/enquire/<slug>`; a new enquiry rings the bell of everyone with admissions.write (one entry while unread); `enquiry_links.test.ts` |
| Inventory of every feature, route and table | `docs/inventory.xlsx`, `scripts/inventory/` | Regenerate after merges |
| Bento board "can be made better"; "modern solid colors for default" | Focus home, default palettes (Light Modern, Dark Modern) | Each domain card is one solid colour with white text; a card with nothing to show sits on the plain card, so colour marks the cards with a figure. Picked card colours untouched. Parent board has no domain colours (by design), so it stays white |
| Misaligned buttons and elements, "make a list and fix them" | Assistant composer, parent-teacher chat, role note, page headers, screen tab strip, phone dock Settings, parent fees card, Reload | Nine fixes measured in a browser at 1440, 390 and 360, light and dark. Staff messages and the teacher / student boards share the fix but were not opened (no seed login) |
| Seller admin controls everything (configuration, never a school's records) | Seller > Entitlements opens on Controls: School settings (grouped, source chip, Reset, search), Apply to schools (preview), Defaults (platform and per plan), Role templates (push, skips schools that changed the role), Configuration templates (export / import); Plan matrix and Feature switches beside it | building: on `main`, not deployed. CONTROL 0014; `docs/seller-controls.md`; `seller_controls.test.ts`. Support logins read only |

## Next

| Asked | Notes |
|---|---|
| Native apps: ONE generic XULO app, plus a per-school app on demand; both ready | Decided 2026-10-02. Offline first like WhatsApp: local data, an outbox that sends when the network returns, push, biometrics, camera, background sync. Android, iOS, Windows |
| Offline core (web, every shell) | Built 2026-10-03: encrypted capped local store, saved session opens offline, outbox with clock/tick/red + Retry/Discard, allow-list (never money, logins, results, admissions; their buttons say Needs internet), remote wipe, SW no longer caches API. Clash: the store used to be kept across sign-out and the SW used to cache API reads; both replaced as asked. Shell contract v2 (docs/native-shell.md), generic app /start picker, desktop/Android/iOS shells built 2026-10-03; Android not compiled here (no JDK), iOS simulator build passes, desktop smoke-started; needs Team ID, APNs/FCM keys, signing, update hosting, Share Extension target added in Xcode |
| Apple-like extras: drag-to-close sheets everywhere, slide between screens, shrinking large titles | Partly in the motion kit |

## Clash (asked differently in two sessions; the later ask is live)

| Thing | Session A | Session B | Live now |
|---|---|---|---|
| Assistant ball | dark ball | "the first fluid ball back" | first fluid ball |
| Phone card sizes | 2x2, 2x4, 4x4 on a 4x5 page | Small, Tall, Medium, Large | settled by the owner 2026-10-02: no Tall on phones (it clipped content at 360px); a desk Tall draws Large |
| "Status" in the bell's Activity tab | Class Status only | learning-hub items of the week | both |
| Card colour | CLAUDE.md UI rule: solid colour only where it means something, everything else neutral | "modern solid colors for default" (2026-10-02) | solid domain grounds, but only on cards that carry a figure |

## Waiting on the owner

- Native apps: Apple Team ID; Play key password (not in chat).
- `*.xulo.in` DNS record and the school-address proxy deploy; switchover go-ahead.
- PhonePe keys; WhatsApp, SMS, email and push accounts; Gemini key rotation.
- Yajur and JSM admin sign-ins, to issue logins there.
- A Telugu speaker's read of the new Telugu strings (now also the Help Centre's: web/src/locales/te.ts, keys help.*).
- Real-phone check of: keyboard behaviour in the assistant chat and All features search.

## Known and not fixed

- Remote school databases are behind (2026-10-06): demo has 21 and demo-school 20 tenant migrations pending (0032-0052), and 0036_status_likes reads as a checksum mismatch where it was recorded without a checksum. The deploy guard now refuses until `migrate.mjs up --remote` is run (or ALLOW_PENDING_MIGRATIONS=1).
- deploy-cloudrun no longer runs on push (Cloud Run being retired, its DATABASE_URL secret is gone); start it by hand if ever needed.
- Four Work-layout pages scroll slightly sideways on phones (My students, My classes, My pay, Background jobs).
- "Hold a card to customize" hint sits half behind the dock.
- Tinted stat tiles: label and icon too faint in dark.
