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
| Deploy guard and rule; always push main | scripts/deploy-guard.sh, CLAUDE.md |

## Building

| Asked | Notes |
|---|---|
| Animations never cut off part-way | Restarted 2026-10-02 (a restart lost the first attempt) |
| Help Centre (Mac / iPhone / Windows style) and seller support desk, maintainable at 10 schools | Restarted 2026-10-02; builds on the other session's Team screen, ticket queue and recorded support access |
| User guide for every role, as one HTML book | Restarted 2026-10-02 |
| Every screen checked for silly UI mistakes | Restarted 2026-10-02 |

## Next

| Asked | Notes |
|---|---|
| Native apps: ONE generic XULO app, plus a per-school app on demand; both ready | Decided 2026-10-02. Offline first like WhatsApp: local data, an outbox that sends when the network returns, push, biometrics, camera, background sync. Android, iOS, Windows |
| Apple-like extras: drag-to-close sheets everywhere, slide between screens, shrinking large titles | Partly in the motion kit |

## Clash (asked differently in two sessions; the later ask is live)

| Thing | Session A | Session B | Live now |
|---|---|---|---|
| Assistant ball | dark ball | "the first fluid ball back" | first fluid ball |
| Phone card sizes | 2x2, 2x4, 4x4 on a 4x5 page | Small, Tall, Medium, Large | settled by the owner 2026-10-02: no Tall on phones (it clipped content at 360px); a desk Tall draws Large |
| "Status" in the bell's Activity tab | Class Status only | learning-hub items of the week | both |

## Waiting on the owner

- Native apps: Apple Team ID; Play key password (not in chat).
- `*.xulo.in` DNS record and the school-address proxy deploy; switchover go-ahead.
- PhonePe keys; WhatsApp, SMS, email and push accounts; Gemini key rotation.
- Yajur and JSM admin sign-ins, to issue logins there.
- A Telugu speaker's read of the new Telugu strings.
- Real-phone check of: keyboard behaviour in the assistant chat and All features search.

## Known and not fixed

- Web tests: 5 failures that predate this work (1 palette contrast, 4 bento size tiers).
- Four Work-layout pages scroll slightly sideways on phones (My students, My classes, My pay, Background jobs).
- "Hold a card to customize" hint sits half behind the dock.
- Tinted stat tiles: label and icon too faint in dark.
