# UI elements: inventory and audit (2026-10-01)

The living checklist is the Elements gallery: `/design/elements` (platform
admins, or anyone signed in with `?elements=1`), source
`web/src/features/design/ElementsGallery.tsx`. Every row below marked "in
gallery" renders there in its variants, in whatever theme, palette, glow and
corner setting the viewer has chosen.

## The spec every element is held to

| Property | Rule | Token / source |
|---|---|---|
| Control height | 40px desktop, 44px on a phone (coarse pointer or < 640px) | `--control-h` in `index.css` |
| Small button | 32px desktop, 44px floor on a coarse pointer | `Button size="sm"` |
| Radius | control 7, input 8, card 11, dialog 14 (each × `--radius-k`, capped) | `--radius-control/-input/-card/-dialog` |
| Spacing | 4px grid; card padding `--card-pad` | Tailwind spacing |
| Type | body 14, secondary 13, caption 12, title 16 semibold, page H1 from PageHead | |
| Colour | theme tokens only (`hsl(var(--…))`, `--elev-*`, `--sel-*`); hex only inside palette definitions and fixed-hue student kit | `index.css`, `bento-theme.css` |
| Fields | borderless: a soft shadow and a faint ring of shade, no drawn border; focus adds the ring colour and halo | `--field-shadow`, `--ring-halo` |
| Focus | `:focus-visible` ring 2px `--ring` on every interactive element | |
| States | hover wash, pressed sink (`--elev-press`), disabled 50%/muted, loading = TriLoader inside the control | |
| Elevation | `--elev-1` rest, `--elev-2` hover, `--elev-3` sheets/dialogs (`-up` for bottom sheets) | |
| Dark | every surface/ink from tokens; elevation in the dark is tone first | `.dark` block |
| Motion | arrivals honour `prefers-reduced-motion` (global rule) | `lib/motion` |
| Overflow | labels in controls truncate; body text wraps; tables scroll sideways inside `.table-frame` | |
| RTL | logical `padding-inline` on fields; most utilities still physical (open) | |

## Inventory

| Element | Where defined | Variants | Status | Notes |
|---|---|---|---|---|
| Button | `components/ui.tsx` `Button` | primary, secondary, ghost, ink, outline × md/sm × danger tone × pending/disabled × icon-only | fixed | md now 40px desktop via `--control-h`; in gallery |
| ConfirmButton | `ui.tsx` | inline two-step | ok | in gallery |
| PrintButton / Reload / ExportButton / ExportTable | `ui.tsx` | busy state | ok | in gallery |
| Input (text, password, date, number) | `ui.tsx` `Input` → `.field` | focused, disabled, invalid, Telugu | fixed | borderless + `--field-shadow` |
| Textarea | `ui.tsx` | | fixed | same `.field` |
| Select (combobox) | `ui.tsx` `Select` | searchable, add-your-own | fixed | rides `.field` |
| PickerMenu (dropdown pill) | `components/PickerMenu.tsx` | | fixed | was bordered `rounded-md`; now input radius + field shadow |
| RangePicker | `ui.tsx` | grouped options | ok | uses PickerMenu |
| SearchBox (search pill) | `components/rows.tsx` | empty / clear | fixed | inherits borderless field |
| Checkbox | `ui.tsx` | checked, unchecked, hint, Telugu | ok | |
| Switch / segment / dropdown / slider rows | `features/bento/SettingsRows.tsx` | Row, NavRow (current), SwitchRow, SegmentRow, DropdownRow, SliderRow | ok | accent is `--sel-*` (palette mint) by design |
| Radio | none shared | | open | screens use SegmentRow or segClass; no radio component |
| Field / FormGrid / FormNotice | `ui.tsx` | ok / error | ok | in gallery |
| Dialog | `ui.tsx` `Dialog` | sm/md/lg/xl, title+description, footer, raised; desk card, phone bottom sheet | fixed | radius and shadows moved to `--radius-dialog` / `--elev-3(-up)` tokens (was hard rgba); now closes on the phone's Back (overlay history) |
| Anchored menu | `features/bento/Menu.tsx`, `components/anchored.ts` | | ok | in gallery |
| TabMenu (context) | `components/TabMenu.tsx` | | ok | not in gallery (needs a tab target) |
| Underline tabs | `ui.tsx` `TAB_BAR` + `tabClass` | active, idle, disabled | fixed | now control height, focus ring, nowrap, disabled style |
| Segmented | `ui.tsx` `SEG_BAR` + `segClass` | with `SlidingIndicator` | fixed | focus ring added |
| Student Segmented | `features/portal/student-kit.tsx` | | ok | in gallery |
| TabStrip (workspace tabs) / ScreenTabs | `components/TabStrip.tsx`, `features/portal/ScreenTabs.tsx` | | ok | shell-level, seen on every screen shot |
| Badge | `ui.tsx` | neutral/primary/success/warning/danger/info | ok | long text does not ellipsize (open, low) |
| StatusPill | `components/NeedsAttention.tsx` | known + unknown status | ok | |
| DueChip / DoneCheck / Tile | `student-kit.tsx` | | ok | fixed hue hex by design (student portal) |
| Card / CardHeader / Panel | `ui.tsx` | | ok | |
| Stat / CellGrid (tint grid) | `ui.tsx` | icon, delta ±, clickable, hint | ok | phone figure scales (container query) |
| Bento CardShell / app icons | `features/bento/bento-cards.tsx`, `FeatureGlyph` | | ok | sizing owned by the bento work in progress |
| Table / Td / table-frame / scroll-x | `ui.tsx` | rows, empty, sortable, expand | ok | phone: long first cell clips at the frame edge rather than ellipsis (open) |
| Showing / paging | `components/rows.tsx`, `ui.tsx` Table paging | | ok | |
| EmptyState / ErrorState / UnavailableState | `ui.tsx` | | ok | |
| Loading / skeletons | `ui.tsx` `Loading`, `components/Skeleton.tsx` | page, table, cards, form, inline; Text, Rows, Tiles, Cards, Form | ok | all in gallery |
| TriLoader | `components/Loader.tsx` | | ok | |
| Toasts / LiveToasts | `components/Toast.tsx`, `LiveToasts.tsx` | ok / error | ok | trigger buttons in gallery |
| Saved popup (setup) | `features/setup/panels.tsx` | | fixed | now the shared Dialog |
| Notification panel rows | `components/Notifications.tsx` | | ok | own drawer (z 100); not migrated |
| StatusRings / StoryViewer | `features/comms/status/`, `components/StoryViewer.tsx` | | ok | on the dashboard; viewer is full-screen by design |
| Avatars | `components/StudentAvatar.tsx` | 24–64, selectable | ok | in gallery |
| Progress rings / bars / meters | `student-kit` Ring/Bar, `lms-shared` ProgressRing, `bento-kit` Meter, `bento-viz` Ring | | ok | four ring implementations: consolidation open |
| FilePicker | `components/FilePicker.tsx` | chosen / uploading | ok | in gallery |
| Tooltip | native `title` (Button turns it into aria-label) | | ok | no custom tooltip component |
| Banners | `OfflineBanner`, role-hint banner, `FormNotice` | | ok | OfflineBanner only shows offline |
| PageHead / breadcrumbs | `ui.tsx` `PageHead` | eyebrow, actions | ok | |
| Top bar / rail / dock / student tab bar | `components/Shell.tsx`, `student-kit` `StudentTabBar` | | ok | checked on 15 screens × 2 widths × 2 themes |
| Print sheet | `components/print-sheet.css`, `PrintButton` | | ok | |

## One-off count (grep, after this pass)

| Pattern | Count | Notes |
|---|---|---|
| `fixed inset-0` overlays outside ui.tsx | 29 in 23 files | many are legitimate full-screen pages (StaffRecord, ProgressDetail, RecordBlock sheets, Homework viewer, BulkImport full table, CardViewer, FleetMap) or click-catchers |
| Dialogs on the shared `Dialog` | 9 call sites | +4 this pass: setup Saved popup, DataPortActions Import, StudentEditDialog, SmartImport |
| Raw `<select>` | 15 | e.g. the Students/Staff filter on the dashboard tiles; should move to PickerMenu |
| Raw `className="field"` inputs | 20 | look right (same class) but skip Input's behaviour |
| Hand-made pills (`rounded-full px-2 text-[10–12px]`) | 15 | candidates for Badge |
| `bg-primary text-primary-foreground` outside Button | 26 | mostly selected chips/avatars, not buttons |
| Hex colours in `features/` | 540 | mostly bento palettes, student hues and charts; not swept |

## Open

- Remaining hand-made dialogs: Setup "Staff logins" full-screen panel, BulkImport's centred variant, Homework viewer, AppearanceDialog, BentoLauncher sheet, FirstRunTour, CommandSearch, WriteWithAI phone sheet. Each has its own sizing or history wiring; migrate one at a time.
- 15 raw `<select>` and 15 hand-made pills.
- Badge with very long text cannot ellipsize (inline-flex).
- Four progress-ring implementations.
- RTL: most spacing utilities are physical (`ml-`, `pl-`), not logical.
- At 390px in a mouse browser a `size="sm"` button stays 32px beside a 44px field; real phones (coarse pointer) get the 44px floor.
