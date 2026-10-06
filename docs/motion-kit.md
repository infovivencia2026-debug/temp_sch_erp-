# Colour system and motion kit

Two small vocabularies that sit on top of the theme. Both are loaded from
`web/src/main.tsx` after `index.css`:

- `web/src/styles/color-system.css` — the system colours (tokens and a few classes)
- `web/src/styles/motion.css` + `web/src/lib/motion.ts` — the motion kit (CSS and hooks)

`web/src/styles/color-system.test.ts` measures every colour against the
surfaces it is promised to clear, in light and in dark. A value that fails
fails the test run.

## Part A — colour

The rule: the ground stays grey, cards stay white or near-black, ink stays
neutral. Colour is spent on the one thing you press, on what a status means,
on which workspace you are in, and on a switch that is on.

### Tokens

Every hue has three roles, because one value cannot do three jobs. All are HSL
triplets (`hsl(var(--sys-blue))`, `hsl(var(--sys-blue) / 0.12)`).

| Role | Token | Use | Contract (tested) |
| --- | --- | --- | --- |
| vivid | `--sys-<hue>` | dot, ring, progress arc, switch track, chart series | 3:1 on the card |
| fill | `--sys-<hue>-fill` | a filled control carrying white text | white text 4.5:1 |
| ink | `--sys-<hue>-ink` | text and icons on card or ground, tinted badge label | 4.5:1 on card and ground |

Hues: `blue green orange red purple teal indigo pink`, plus two neutrals
`gray brown` (nine workspaces cannot share eight hues).

Semantic roles (override these, not the hues):

| Token family | Default | Meaning |
| --- | --- | --- |
| `--sys-accent`, `-fill`, `-ink` | blue | primary action, link, active item |
| `--sys-success` … | green | went well, present, paid, done |
| `--sys-warning` … | orange | needs attention, due today |
| `--sys-danger` … | red | destructive, failed, overdue |
| `--sys-info` … | teal | neutral information |
| `--sys-switch-on` | green | the ON track of every switch |
| `--chart-1` … `--chart-8` | blue, orange, green, purple, pink, teal, indigo, brown | chart series, in this order |
| `--sys-ring-unseen` | orange→pink→purple sweep | the status ring with something new |

The theme's own tokens are rebased onto these: `--primary` (accent fill),
`--ring`, `--success`, `--warning`, `--info` (inks), `--destructive` (fill in
light, ink in dark — a solid `.bg-destructive` is kept on the fill in both).

Note on the name: `--accent` in this codebase is the neutral hover surface
(the shadcn convention) and is left alone. The accent colour is `--sys-accent`.

### Who can override

1. The school's brand colour: `lib/brand.ts` writes `--primary` inline on
   `<html>`, which beats this stylesheet. Buttons, links, focus rings and the
   active tab follow the school. `--sys-danger`, `--sys-success` etc. do not
   move, so a school whose brand is red still has a distinct destructive red.
2. A palette (`lib/paint.ts`, `lib/personality.ts`): set any `--sys-*`,
   `--dom-*` or `--chart-*` token in the palette's rule.
3. The contrast settings (`:root[data-contrast=…]` in index.css) keep their
   own deeper or paler values; their selectors are more specific.

### Workspace identity

One solid hue per workspace, through the existing `--dom-<workspace>`,
`--dom-<workspace>-soft` and `--dom-<workspace>-text` tokens:

| Workspace | Hue | Workspace | Hue |
| --- | --- | --- | --- |
| academics | blue | attendance | teal |
| students | indigo | admissions | orange |
| staff | purple | communication | pink |
| finance | green | operations | brown |
| reports | gray | critical / success / warning | red / green / orange |

Set `--dom-current: var(--dom-finance)` on a page root and these follow:
`.sys-section` (heading dot), `.sys-selected` (selected row: leading bar and
faint wash).

### Classes

| Class | What it paints |
| --- | --- |
| `.sys-dot[data-tone]` | 8px status dot: `success warning danger info neutral`, accent by default |
| `.sys-badge[data-tone]` | solid pill with white text (an unread count, a live state) |
| `.btn.sys-danger` | solid red primary button |
| `.sys-link` | accent-ink link with a soft underline |
| `.sys-switch` | on a `role="switch"` (or its track span): green when checked, white knob |
| `.sys-section`, `.sys-selected` | workspace dot and selected-row marker |

### Where colour is applied

- Primary buttons, links, focus ring, active tab underline, student tab bar:
  through `--primary` (system blue, or the school's brand).
- Badge tones, FormNotice, KindChip, LMS progress ring: through `--success`,
  `--warning`, `--info`, `--destructive`.
- Switches: Settings rows (`SettingsRows.tsx`) and the Focus arrange sheet.
- Status rings: unseen ring is the warm sweep, seen is grey (`StatusRings.tsx`).
- Student and parent screens: every hard-coded Tailwind hex in the student
  kit, home, record, attendance, card, requests, courses, quiz and profile is
  now a system token and follows dark mode on its own.
- Charts: the attendance trend line and the student sparkline use `--chart-1`.
- Notifications: the unread count and Clear hover use the danger tokens.
- Toast: the Saved tile's mark is success green.

## Part B — motion

Rules: transform and opacity only; reduced motion (the system setting, or the
account's own, stamped as `html[data-reduce-motion]`) makes everything instant;
an engine without the feature shows the thing simply there.

Tokens (motion.css): `--spring-snappy` (a control under the finger),
`--spring-gentle` (a sheet or panel), `--spring-bouncy` (a tick, a toast),
`--spring-dur` 380ms, `--spring-dur-fast` 240ms, `--stagger-step` 24ms. Real
springs via `linear()` where supported, cubic-bezier otherwise. The duration
tokens in index.css (`--motion-press` … `--motion-slow`) are unchanged.

| Term | Where it is used | How to apply |
| --- | --- | --- |
| Spring physics | all of the below | `transition: transform var(--spring-dur) var(--spring-gentle)` |
| Microinteraction / press state | status rings; any card or row that is not a `<button>` | class `m-press` |
| Staggered list entrance | status rings strip; notification day groups and status activity | class `m-stagger` on the list; `ref={useStaggerOnce()}` if the list re-keys (first 12 children, 24ms apart, first paint only) |
| Container transform / shared element / hero | status ring face → story viewer avatar; Focus card → its full screen (corner arrow) | `containerTransform(fromEl, commit, () => toEl)` — View Transitions API, plain commit elsewhere |
| Bottom sheet with scrim | Focus arrange sheet | classes `m-sheet` + `m-scrim` for a new sheet |
| Drag-to-dismiss | Focus arrange sheet (pull the grip or title down) | `ref = useDragDismiss({ onDismiss, handle }, () => scrimEl)` |
| Swipe-to-dismiss | hook ready; toast needs the one-line edit below | class `m-swipe`, `ref = useSwipeDismiss(onDismiss)` |
| Pull-to-refresh | student home (already there, kept) | `<PullToRefresh onRefresh>` from the student kit |
| Collapsing toolbar / large title | student home greeting on a phone | classes `m-large-title`, `m-large-title-sub`; `ref={useCollapsingTitle()}` on their container (scroll-driven animation where supported, scroll listener otherwise) |
| Scroll-driven animation | the collapsing title | `animation-timeline: scroll(nearest)` inside `@supports` |
| Scroll snap | status rings strip | class `m-snap-x` on a horizontal scroller |
| Overscroll containment (rubber-band stays inside) | status rings strip | part of `m-snap-x` |
| Toast / snackbar | every confirmation toast: rises on the bouncy spring; error toast shakes once | automatic (motion.css targets the toast classes) |
| Success / error micro-animation | Saved tile: green disc pops, tick draws, ripple; error shake | automatic |
| Enter / exit pair | available | class `m-pop-in`, with `usePresence` and `data-closing` for the exit |
| Skeleton shimmer, sticky headers, route crossing | already in index.css, unchanged | — |

Not used, on purpose: ripple (the product uses a press dip and wash instead,
as iOS does), parallax, and any whole-screen route animation — index.css
records that the owner found route fades and scales distracting, so only the
pressed card moves in a container transform and the frame stays still.

## One-line edits for files owned by other work

These files were being edited by other sessions when the kit was written. Each
edit is optional; the kit works without them.

`web/src/components/ui.tsx`

- Button, destructive primary — nothing to do: `bg-destructive` is mapped to
  the red fill in both modes by color-system.css.
- Badge — the `solid` prop is accepted and ignored. To honour it, add to the
  `cn(...)` list: `_solid && 'sys-badge'` and put `data-tone={tone}` on the span.
- `SEG_BAR` — append ` m-snap-x` so segmented strips snap on a phone.
- Dialog (phone sheet form) — add `m-scrim` to the backdrop and
  `ref={useDragDismiss({ onDismiss: onClose })}` to the panel.
- Table rows that navigate — add `m-press` to the row class.

`web/src/components/Toast.tsx`

- Swipe-to-dismiss, in `Confirmation` and the error branch of `ToastRow`:
  `const swipe = useSwipeDismiss<HTMLDivElement>(onDismiss)` then
  `ref={swipe}` and `m-swipe` in the row's className.

`web/src/index.css` — none.

## Part C — nothing is cut off part-way (2026-10)

The owner: "smooth continuous animation, no breaking in the middle". What
broke, and the kit-level rule that now prevents it:

| Break | Rule now |
| --- | --- |
| Menus, popovers, the launcher, notifications, search and card menus vanished in one frame on close (rendered as `{open && ...}`) | `installMotionGuard()` (lib/motion.ts, called from main.tsx) puts an inert copy (`[data-ghost]`: no pointer, no focus, aria-hidden) back for the exit and removes it after. A surface with its own exit sets `data-closing` (usePresence) and is left alone; `data-no-exit` opts out |
| Closed while still opening: the exit keyframe restarted from full | When `data-closing` flips, the guard rewrites the exit's first frame to the values the entrance had reached; a ghost of a half-open surface leaves from half-way |
| A second view transition (Focus/Work pressed twice, Back during a card opening) skipped the first to its end | One crossing at a time: `crossfade`, `transitioned` and `containerTransform` commit inside a crossing already running |
| Notifications drawer unmounted when a row's entrance ended (animationend bubbles) | Only the drawer's own animationend ends it |
| Drag/swipe dismiss fired on a guessed timer, part-way down | `afterMotion(el, done)`: on the element's own transitionend, timer as a fallback |
| Exit longer than the time the surface stayed mounted | Tokens `--motion-exit` (160ms) and `--motion-exit-sheet` (220ms), both under `EXIT_MS` (240ms) in usePresence |
| Sliding thumb drifted on window resize and snapped when a tab was added in the same update | Slides only on a change of selection or a move within a row of the same width; a resize re-places it in one step; unchanged measurements are ignored |
| Hover lean on rail/dock icons was a keyframe on `:hover`, cancelled mid-tilt when the pointer left | A transition, which turns round from where it is |
| Fetch bar band snapped to its start while fading out | The sweep is paused, not removed |
| Skeleton sweep seam every 1.9s (band still on screen at loop end) | Ends off screen, linear |
| Loops running in a hidden tab | `html[data-tab-hidden]` pauses every animation |
| `will-change` held on sheets and the large title at rest | Only while dragging |
| Progress bars and the upload bar animated `width`; `transition-all` on rows | `scaleX` from the left; explicit property lists |
| Focus fell to the page after the launcher or the search palette closed | `restoreFocus(opener)`; the palette refocuses its button |

Dev only: `window.__motionAudit()` lists animations that were cancelled, cut
by an unmount, jumped between frames (judged on each animation's own clock
and travel; a frame over 100ms is reported as jank instead), replayed on one
element, animated a layout property, or ran over 600ms.
`window.__motionAudit.reset()` empties it. Tests: `lib/motion.test.ts`.
