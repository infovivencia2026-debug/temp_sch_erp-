import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Building2, Check, ChevronLeft, ChevronRight, LayoutGrid, Maximize2, MessageSquare,
  Minimize2, Minus, Palette, Plus, ShieldCheck, Sliders, Type, UserCircle, X,
  Contrast as RotateCcw,
} from 'lucide-react'
import { resetAppearance } from '@/lib/appearance'
import { TYPEFACES, ensureAllFonts, typefaceById } from '@/lib/typefaces'
import {
  useAppearance,
  CONTRASTS, DOCK_SIZES, ICON_SIZES, SCALE_RANGE,
  type Contrast, type DockSize, type IconSize, type Scales,
} from '@/lib/appearance'
import { useT } from '@/lib/i18n'
import {
  ColourPanel,
  INK, EDGE, TRACK, WASH, RING, CHOSEN, SLIDER, SEAM, SURFACE,
} from './ColourDialog'
import { cn } from '@/lib/utils'
import { featurePath, useActiveRole, useCatalog, usable } from '@/lib/catalog'
import { useSkin, SKINS, type Skin } from '@/lib/skin'
// Aliased: '@/lib/widgets' exports a useLayout of its own, about where the
// dashboard cards sit. This one is the frame -- sidebar or focus.
import { useLayout as useFrameLayout, LAYOUTS, type Layout } from '@/lib/layout'
import { useBoard, useLayout, isRemoved, DIMS } from '@/lib/widgets'

/* Choosing a typeface by looking at it.

   A list of font names is a list of words in the wrong font. The only way to
   pick a face is to see it set, so every card renders the same specimen in the
   face it offers — letters, a grouped figure and a rupee amount, because this
   is a product where most of the type on screen is money and roll numbers, and
   a face that handles Aa beautifully can still put a comma in an ugly place.

   The specimen is the same string in every card on purpose. Comparison needs a
   constant; fifteen different sample sentences would be fifteen different
   questions. */
const SPECIMEN = 'Aa Bb 12,482 · ₹8.42Cr'

/* One row of pills per axis.

   The popover used a vertical list because it was 208px wide and had no other
   option. With the width of a dialog the choices fit on one line each, which
   turns eight settings from a scroll into a page somebody can take in — and
   the current value is visible for all of them at once rather than one at a
   time. */
/** A continuous axis: a slider, and the multiplier it is at.

    These five are not four choices somebody else made — they are a number, and
    the control now says so. The readout is a percentage rather than a raw
    multiplier because 100% gives "back to how it shipped" an obvious target,
    and the button beside it goes straight there.

    Committing on every input event rather than on release is deliberate: the
    whole point of a continuous scale is watching the page answer as you drag
    it, and the write is one custom property and one localStorage line. */
const STEP =
  'grid size-7 shrink-0 place-items-center rounded-full border transition-colors ' +
  'hover:bg-accent disabled:opacity-30 disabled:hover:bg-transparent ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function Scale({ axis, label }: { axis: keyof Scales; label: string }) {
  const { appearance, setScale } = useAppearance()
  const r = SCALE_RANGE[axis]
  const v = appearance.scales[axis]

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      <p className={cn('w-[104px] shrink-0 text-[13px] font-medium', INK)}>{label}</p>
      {/* WRAPS, BECAUSE AT 390 IT DID NOT.

          Six things in a row that refuses to wrap -- minus, track, plus, the
          percentage and the 100% button -- needed more than the 275px the
          panel has inside its padding on a phone, so the reset button sat past
          the right edge of the scroller with nothing to say it was there. The
          same defect as the tab strip, one level down and one control wide.
          Wrapping puts it on a second line instead, which costs a row of
          height on the width that has height to spare and nothing at all on
          the widths where it already fitted. */}
      <div className="flex min-w-[180px] flex-1 flex-wrap items-center gap-x-3 gap-y-2">
        {/* Minus and plus either side of the track.

            A slider is good at "somewhere around here" and bad at "one step
            more" — the thumb is 16px and a 1% change is a pixel of travel. The
            buttons give the same axis a precise gesture without taking the coarse
            one away, which is why they flank the track rather than replace it. 5%
            a press: visible, and not so large that three presses cross the whole
            range. */}
        <button
          type="button"
          onClick={() => setScale(axis, Math.max(r.min, Math.round((v - 0.05) * 100) / 100))}
          disabled={v <= r.min}
          aria-label={`${label} smaller`}
          className={cn(STEP, INK)}
        >
          <Minus className="size-3.5" aria-hidden="true" />
        </button>
        <input
          type="range"
          min={r.min}
          max={r.max}
          step={r.step}
          value={v}
          aria-label={label}
          onChange={(e) => setScale(axis, Number(e.target.value))}
          /* The track was `bg-border`, which is the palette's hairline: it
             measured 1.21-1.33:1 against the card in all four, a slider you
             cannot find. Mixed from the ink instead, with the two-tone
             handle. */
          className={cn('h-1.5 flex-1 cursor-pointer appearance-none rounded-full', TRACK, SLIDER, RING)}
        />
        <button
          type="button"
          onClick={() => setScale(axis, Math.min(r.max, Math.round((v + 0.05) * 100) / 100))}
          disabled={v >= r.max}
          aria-label={`${label} bigger`}
          className={cn(STEP, INK)}
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
        <span className={cn('w-[52px] shrink-0 text-right text-[12.5px] font-medium tabular-nums', INK)}>
          {Math.round(v * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setScale(axis, 1)}
          disabled={v === 1}
          aria-label={`Reset ${label}`}
          className={cn(
            'shrink-0 rounded-full border px-2 py-0.5 text-[11px]',
            'transition-colors disabled:opacity-30', EDGE, WASH, RING, INK,
          )}
        >
          100%
        </button>
      </div>
    </div>
  )
}

/* A toggle, for the one choice that is not a scale.

   Axis below renders minus / value / plus, which is right for text size,
   density, corners, borders and shadow: those are ORDERED, and "a bit more" is
   the thing people want to express. Layout is not ordered. Sidebar and Focus
   are two different shapes of screen, and stepping between two states with a
   plus and a minus reads as a value with more of it available -- somebody
   pressing + on a two-position control is looking for a third position that
   does not exist.

   Both states are shown and the chosen one is filled. With two options that
   costs one extra word of width and removes the question entirely. */
function Choice<T extends string>({
  label,
  value,
  options,
  onPick,
  name,
}: {
  label: string
  value: T
  options: readonly T[]
  onPick: (v: T) => void
  name: (v: T) => string
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      <p className={cn('w-[104px] shrink-0 text-[13px] font-medium', INK)}>{label}</p>
      <div className={cn('flex items-center gap-1 rounded-full border p-1', EDGE)}>
        {options.map((o) => {
          const on = o === value
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(o)}
              className={cn(
                'rounded-full px-3.5 py-1 text-[12.5px] transition-colors',
                RING,
                on ? `${CHOSEN} font-medium` : cn(WASH, INK),
              )}
            >
              {name(o)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Axis<T extends string>({
  label,
  value,
  options,
  onPick,
  name,
}: {
  label: string
  value: T
  options: readonly T[]
  onPick: (v: T) => void
  name: (v: T) => string
}) {
  /* A scale, not a row of buttons.

     Every one of these axes is ORDERED — smaller to larger, tighter to looser,
     flatter to deeper — and a row of named pills asked people to read four or
     five labels to express "a bit more". It also grew the dialog sideways in
     proportion to how many steps an axis happened to have, so the axis with
     the most options looked like the most important one.

     Minus and plus need no reading, and the current step is stated between
     them, so nothing is hidden — only the four you did not choose. */
  const at = options.indexOf(value)
  const step = (d: number) => {
    const next = options[Math.min(options.length - 1, Math.max(0, at + d))]
    if (next && next !== value) onPick(next)
  }
  const arrow = cn(
    'grid size-7 shrink-0 place-items-center rounded-full border transition-colors',
    'disabled:opacity-30 disabled:hover:bg-transparent',
    EDGE, WASH, RING, INK,
  )

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      <p className={cn('w-[104px] shrink-0 text-[13px] font-medium', INK)}>{label}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={at <= 0}
          aria-label={`${label} down`}
          className={arrow}
        >
          <Minus className="size-3.5" aria-hidden="true" />
        </button>

        {/* Fixed width so the two arrows do not shuffle sideways as the word
            between them changes length. */}
        <span
          role="status"
          aria-live="polite"
          className={cn('w-[104px] text-center text-[12.5px] font-medium', INK)}
        >
          {name(value)}
        </span>

        <button
          type="button"
          onClick={() => step(1)}
          disabled={at >= options.length - 1}
          aria-label={`${label} up`}
          className={arrow}
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </button>

        {/* The position on the scale, which the words alone no longer give. */}
        <span aria-hidden="true" className="flex items-center gap-1">
          {options.map((o) => (
            <span
              key={o}
              className={cn(
                'h-1 rounded-full transition-all',
                /* Both marks are ink now: the current step solid, the rest at
                   the track's weight. They were the accent and the hairline,
                   and on the default palette that is a pale green pip on
                   paper beside pips measuring 1.29:1. */
                o === value ? 'w-4 bg-[var(--bento-ink)]' : cn('w-1.5', TRACK),
              )}
            />
          ))}
        </span>
      </div>
    </div>
  )
}

/** Toggle panel: lets the user hide individual dock category icons. */
function DockItemsToggle() {
  const role = useActiveRole()
  const { appearance, set } = useAppearance()

  // Collect unique workspace names this role has access to
  const workspaces: string[] = []
  for (const s of role?.sections ?? []) {
    if (!workspaces.includes(s.workspace || 'Other')) {
      workspaces.push(s.workspace || 'Other')
    }
  }
  if (!workspaces.length) return null

  const hidden = new Set(
    (appearance.hiddenDockItems ?? '').split(',').map(s => s.trim()).filter(Boolean)
  )

  const toggle = (name: string) => {
    const next = new Set(hidden)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    set('hiddenDockItems', [...next].join(','))
  }

  return (
    <div className="mt-3">
      <p className={cn('mb-2 text-[12px]', INK)}>Visible categories in dock</p>
      <div className="flex flex-wrap gap-2">
        {workspaces.map(name => {
          const visible = !hidden.has(name)
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              className={cn(
                'rounded-full border px-3 py-1 text-[12px] transition-colors',
                RING,
                visible
                  ? `${CHOSEN} font-medium`
                  : cn('border-dashed', EDGE, WASH, INK),
              )}
            >
              {visible ? '✓ ' : ''}{name}
            </button>
          )
        })}
      </div>
    </div>
  )
}


/* THE PART OF SETTINGS THAT IS NOT DECORATION.

   Everything above this comment is about how the product looks: the typeface,
   the palette, the size of the dock, which cards sit on the board. That was
   the WHOLE of Settings, and it should not have been. A principal presses a
   cog labelled Settings expecting the school -- the year and the classes, who
   the school messages and from what address, who can sign in and with what
   role -- and found a font picker. The real screens all existed; there was
   simply no cog that led to them, so the only way in was to know the section
   of the sidebar they were filed under, and on a phone in Focus layout there
   is no sidebar to know.

   So Appearance became ONE section of Settings rather than the entirety of it,
   and the sections below link out to the screens that were already there. They
   are links and not embedded forms on purpose: message channels is a page with
   a test button on it, school setup is sixteen steps, and reimplementing
   either inside a 980px dialog would give us two of them to keep in step.

   HONESTY IS THE WHOLE DESIGN CONSTRAINT HERE.

   A settings list that offers a principal a row leading to "That feature is
   not in your workspace" is worse than a settings list that does not mention
   it: the first is a broken promise, the second is merely silence. So nothing
   below is hardcoded to a role name. Every row names a section slug and a
   feature slug, and is rendered only if the signed-in user's own catalogue
   response contains that pair AND `usable` says it is built and in scope. The
   server decides; this file only asks.

   That is not a theoretical guard. A school still in its first-run setup gets
   a deliberately reduced catalogue -- the live tenant used for checking this
   comes back with four usable features in total -- so on that account School
   and Account appear and Messaging and Security do not, which is exactly what
   that principal can actually reach today. When the setup completes and the
   grants arrive, the rows appear with no client release. */
type LinkSpec = {
  /** section slug, then feature slug, as the catalogue names them.

      Absent on the two rows below that are not catalogue features at all --
      see `always` on the group. */
  at?: [string, string]
  /** Where a built-in row goes, and what it is called. Only for rows with no
      `at`, which the catalogue therefore never gets a vote on. */
  href?: string
  name?: string
  /** What the screen does, said the way somebody would say it out loud. */
  note: string
}

type LinkGroup = {
  id: LinkTab
  label: string
  icon: typeof Building2
  blurb: string
  /* The one line this group gets in the phone's section list, and the
     subtitle over it once you are inside.

     Separate from `blurb` because the two answer different questions. `blurb`
     is read with the rows already on screen and only has to say what they have
     in common. `note` is read with nothing on screen but the row itself, so it
     also has to say WHERE the change lands -- the dialog used to promise, over
     every page, that a change is "remembered on this device", which is true of
     a typeface and a lie about who the school may message. Every line in the
     list now carries its own answer to that, and no line carries somebody
     else's. */
  note: string
  rows: LinkSpec[]
  /* Rendered even when the catalogue resolves none of its rows.

     True of exactly one group, Account, and only because two of its rows are
     not catalogue features: /account and /logout exist for every person who
     can sign in at all, whatever their role and whatever their school has
     bought. Every other group stays silent when it has nothing, which is the
     rule this file was built on and which the resolver below still enforces
     row by row -- `always` buys the group a heading, never a row. */
  always?: boolean
}

type LinkTab = 'school' | 'messaging' | 'account' | 'security'

/* Grouped by what somebody came here to change, not by which workspace the
   catalogue happens to file the screen under. Sender identity lives under
   institution_admin and login audit under super_admin, and nobody deciding
   "how do families see mail from us" cares which. */
const LINK_GROUPS: LinkGroup[] = [
  {
    id: 'school',
    note: 'The school year, its setup, and the transport policy. Shared by everybody at the school.',
    label: 'School',
    icon: Building2,
    blurb: 'The school itself: the year it is running, and everything that hangs off it.',
    rows: [
      {
        at: ['getting_started', 'school_setup'],
        note: 'The sixteen steps of setting the school up, in order, with what is done and what is left.',
      },
      /* The tracking policy is a genuine settings screen wearing a hardware
         name. The catalogue calls it GPS hardware integration and describes
         IMEI mapping, but there is no hardware: what the screen actually
         holds is whether parents may watch the bus at all, how often a
         driver's phone reports, and how long the trail is kept. Those are
         school policy, so the row is here as well as in Transport, and it is
         described by what it does rather than by what the catalogue calls
         it. */
      {
        at: ['transport', 'driver_phone_tracker'],
        note: 'Whether parents may watch the bus live, how often a driver phone reports, and how long the trail is kept.',
      },
      {
        at: ['payments_devices', 'gps_hardware_integration'],
        note: 'Whether parents may watch the bus live, how often a driver phone reports, and how long the trail is kept.',
      },
    ],
  },
  {
    id: 'messaging',
    note: 'How messages leave the school, and who may receive one. Shared by everybody at the school.',
    label: 'Messaging',
    icon: MessageSquare,
    blurb: 'How a message leaves this school, and who is allowed to receive one.',
    rows: [
      {
        at: ['channel_setup', 'message_channels'],
        note: 'The email, SMS and WhatsApp accounts messages actually go out through. Testable from the screen.',
      },
      {
        at: ['channel_setup', 'sender_identity'],
        note: 'The name, address and reply-to a family sees, and the SMS sender ID the operator approved.',
      },
      {
        at: ['channel_setup', 'quiet_hours_sending_limits'],
        note: 'The hours the school will not message a family, and the monthly ceiling on what it spends.',
      },
      {
        at: ['channel_setup', 'who_we_may_message'],
        note: 'Everybody, or a named list while the school is still testing. Held-back messages are logged.',
      },
    ],
  },
  {
    id: 'account',
    note: 'Your profile, your language, and signing out. Yours alone, on whatever device you use.',
    label: 'Account',
    icon: UserCircle,
    blurb: 'Your own record, which is separate from anything the school-wide settings do.',
    always: true,
    rows: [
      /* THE TWO ROWS THAT USED TO BE IN THE FOOTER.

         My profile and Sign out sat in a strip along the bottom of the dialog,
         repeated under every page, because when the settings popover collapsed
         into this window they had nowhere else to go. A strip under Colour
         offering to sign you out is not a category of anything; it is two
         account doors filed beside a colour wheel because the colour wheel got
         there first.

         They are account actions, so they live in Account, which is the row
         somebody opens when they want their own record. That is also why the
         group is `always` above: the footer was reachable from everywhere, and
         moving these into a group the catalogue could suppress would have
         taken the only sign-out in the product away from a school still in
         first-run setup. Neither row asks the catalogue anything, so neither
         can be suppressed.

         Sign out is last in the group and last in the dialog, which is the
         same reason it used to be pushed to the far end of the footer. */
      {
        href: '/account',
        name: 'My profile',
        note: 'Your name, your password and how the school reaches you. Everybody has one, whatever their role.',
      },
      {
        at: ['my_profile', 'leave_self_service'],
        note: 'Apply for your own leave and see where the application has got to.',
      },
      {
        at: ['my_profile', 'my_pay'],
        note: 'Your payslips month by month, the days you were marked present, and the leave you have left.',
      },
      /* The parent app's own language switch. Filed here rather than in
         Appearance because it changes the words a person reads and not the
         way the page looks, and because it is the one preference in this
         dialog that is stored on the server rather than in this browser. */
      {
        at: ['profile', 'language'],
        note: 'Read the app in English or Telugu. Yours alone; it changes nothing anybody else sees.',
      },
      {
        href: '/logout',
        name: 'Sign out',
        note: 'End this session on this device. Nothing you have set up is lost.',
      },
    ],
  },
  {
    id: 'security',
    note: 'Who may sign in, what they may do, and what they did. Shared by everybody at the school.',
    label: 'Security',
    icon: ShieldCheck,
    blurb: 'Who can sign in, what they may do once they are in, and what they did.',
    rows: [
      {
        at: ['access_security', 'user_directory'],
        note: 'Create, search, suspend and reset the accounts of everybody at the school.',
      },
      /* Two catalogue entries, one screen: the principal reaches roles under
         Staff and the platform admin under Access & security. Whichever of
         the two this user holds is the one that renders, and if they hold
         both the dedupe below leaves one row. */
      {
        at: ['staff', 'roles_permissions'],
        note: 'What each role may see and do, and over how much of the school. Copy a built-in role to make your own.',
      },
      {
        at: ['access_security', 'roles_permissions'],
        note: 'What each role may see and do, and over how much of the school.',
      },
      {
        at: ['access_security', 'sso_mfa'],
        note: 'Single sign-on and second-factor sign-in, for schools that are required to have them.',
      },
      {
        at: ['access_security', 'login_session_audit'],
        note: 'Who signed in, from where, and which sessions are still open right now.',
      },
    ],
  },
]

type ResolvedLink = { href: string; name: string; note: string }

/* Resolving a row against the catalogue the server sent THIS user.

   Searched across every role they hold rather than only the active one,
   because these are settings and not navigation: a head of department looking
   at a Faculty screen still wants their own payslips, and the row for those
   lives on whichever role carries my_profile. The active role is tried first
   so that a person holding several gets their own workspace's copy of a screen
   that several roles share.

   `usable` is the gate the rest of the app uses for anything that picks a
   feature on somebody's behalf -- built, and inside their data scope -- so
   this uses the same one rather than a second opinion that could drift from
   it. A catalogued-but-unbuilt entry is silently dropped, which is the point.

   Deduplicated by href, because two catalogue entries pointing at one screen
   would otherwise print the same destination twice under different words. */
function useSettingsLinks(): { group: LinkGroup; links: ResolvedLink[] }[] {
  const catalog = useCatalog()
  const active = useActiveRole()

  return useMemo(() => {
    const roles = [
      ...catalog.roles.filter((r) => r.key === active?.key),
      ...catalog.roles.filter((r) => r.key !== active?.key),
    ]

    const resolve = (spec: LinkSpec): ResolvedLink | undefined => {
      // A built-in row. No catalogue pair, so nothing to look up and nothing
      // that can take it away.
      if (!spec.at) {
        return spec.href && spec.name
          ? { href: spec.href, name: spec.name, note: spec.note }
          : undefined
      }
      const [sectionSlug, featureSlug] = spec.at
      for (const role of roles) {
        for (const section of role.sections) {
          if (section.slug !== sectionSlug) continue
          const feature = section.features.find(
            (f) => f.slug === featureSlug && usable(f),
          )
          if (feature) {
            return {
              href: featurePath(role.key, section.slug, feature.slug),
              name: feature.name,
              note: spec.note,
            }
          }
        }
      }
      return undefined
    }

    const out: { group: LinkGroup; links: ResolvedLink[] }[] = []
    for (const group of LINK_GROUPS) {
      const links: ResolvedLink[] = []
      const seen = new Set<string>()
      for (const spec of group.rows) {
        const link = resolve(spec)
        if (!link || seen.has(link.href)) continue
        seen.add(link.href)
        links.push(link)
      }
      // A group with nothing in it is not rendered as an empty group; it is
      // not rendered at all, and its tab does not appear either. The one
      // exception carries rows that are not catalogue features, so it can
      // never actually be empty -- the flag only says so out loud.
      if (links.length || group.always) out.push({ group, links })
    }
    return out
  }, [catalog, active])
}

/* One row per screen, at 44px minimum.

   This product is used on phones on a corridor, and the touch floor is 44px,
   so the row is a block link with generous padding rather than the tight
   12.5px list the rest of the dialog uses for pill controls -- a pill you miss
   costs you a second press, a settings row you miss costs you a page load and
   a way back. The name and the sentence stack at narrow widths for the same
   reason: a two-column row at 390px gives the description about eleven
   characters.

   A plain <a> and not a router push. Leaving Settings for a full screen is the
   intent every time one of these is pressed, and a hard navigation guarantees
   the dialog, the overlay and the dock's lifted state all go with it. */
function LinkRow({ link }: { link: ResolvedLink }) {
  return (
    <a
      href={link.href}
      className={cn(
        'flex min-h-[44px] items-center gap-3 px-3.5 py-3 transition-colors',
        WASH, RING, INK,
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{link.name}</span>
        <span className="mt-0.5 block text-[12px]">{link.note}</span>
      </span>
      <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
    </a>
  )
}

function LinkSection({ group, links }: { group: LinkGroup; links: ResolvedLink[] }) {
  const Icon = group.icon
  return (
    <section>
      {/* Wide only. On a phone the panel header IS this heading -- the section
          name at title size with its own line under it -- and printing the
          name a second time nine pixels below itself is the kind of repetition
          that makes a narrow screen feel full before it has said anything. */}
      <h3 className="mb-1 hidden items-center gap-2 text-[13px] font-semibold md:flex">
        <Icon className="size-4" aria-hidden="true" />
        {group.label}
      </h3>
      <p className={cn('mb-4 hidden text-[12px] md:block', INK)}>{group.blurb}</p>
      <div className={cn(
        'divide-y overflow-hidden rounded-[10px] border', EDGE,
        'divide-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]',
      )}>
        {links.map((l) => <LinkRow key={l.href} link={l} />)}
      </div>
    </section>
  )
}

/* A PHONE DOES NOT GET A TAB STRIP.

   Measured at 390px with a touch pointer, the strip was 502px of tabs in a
   360px panel. Appearance, Colour, Dock and Dashboard fitted; School and
   Account sat past the right edge behind a word cut in half, and on a fully
   granted institution admin -- eight sections rather than six -- Messaging and
   Security were out there with them. There was no arrow, no fade and no
   scrollbar, so the panel did not merely hide those sections: it stated, as
   plainly as a control can, that there were four. A principal who pressed the
   cog looking for their school's setup was told it was not in Settings.

   The strip was not a bad control chosen carelessly. It replaced tabs that
   wrapped to three lines and pushed the content below the fold, and it fixed
   that. But a tab's entire promise is that the alternatives are visible, and a
   tab you have to go looking for has stopped being a tab; it is a hidden menu
   drawn to look like a choice already offered. Scrolling sideways is also the
   one gesture a phone user is least likely to try inside a vertically
   scrolling panel, because almost nothing else on a phone answers to it.

   So at narrow widths this stops being a tabbed window and becomes what every
   settings app on every phone already is: a LIST you drill into. Every section
   is on screen at once, in one column, at a size you can hit; a row opens a
   page; the page says where you are and how to get back. Nothing is off the
   edge because nothing is beside anything.

   THIS IS NOT A REVERSAL OF WHY THE POPOVER BECAME ONE DIALOG.

   It is worth being explicit, because it looks like one. The argument this
   file makes twice over is that the settings cog used to open a small menu
   whose every substantive row opened a SECOND window -- two surfaces where one
   was wanted, the first of them a waiting room. The list below is not that. It
   opens nothing: it is a page of this same dialog, and the section it drills
   into is another page of this same dialog, on the same surface, under the
   same header, one press away and one press back. The popover's sin was a
   second WINDOW, not a second page; the window that dialog opened was modal,
   covered the first, and could not be gone back from without dismissing
   everything. Wide viewports keep the tab strip precisely because there the
   sections genuinely do all fit, and where they fit, showing them all at once
   is still better than making somebody choose from a list first.

   The other argument is that appearance is changed while looking at the thing
   it changes, and that stands untouched. The dialog still floats over the live
   page, the dock is still lifted clear of it, and every axis still writes
   through on the way to the page behind. Drilling into Colour on a phone puts
   the wheel over the same page the wheel repaints; it does not send anybody to
   a settings route to judge a palette on the wrong screen.

   767px is the line because that is where it was measured to stop hurting: at
   768 the six tabs this tenant renders occupy 724px in a 724px strip with
   nothing clipped, and the panel has room for a page beside its own chrome. */
function useNarrow() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}

/* The four pages this file draws itself, said the way the list has to say
   them.

   Each line has to survive being read on its own, with none of the controls
   visible, which is a harder test than the headings inside the pages ever had
   to pass. It names what is inside and then where the change lands, and for
   these four the answer really is this device -- the old blanket subtitle was
   only ever wrong about the sections it did not draw. */
const DISPLAY_META = {
  appearance: {
    icon: Type,
    note: 'Typeface, text size, density and the frame. Remembered on this device.',
  },
  colour: {
    icon: Palette,
    note: 'The palette everything here is painted in. Remembered on this device.',
  },
  dock: {
    icon: LayoutGrid,
    note: 'How big the dock is and what it carries. Remembered on this device.',
  },
  dashboard: {
    icon: Sliders,
    note: 'Which cards sit on this dashboard, and where. Remembered on this device.',
  },
} as const

type ListItem = { id: string; label: string; icon: typeof Building2; note: string }

/* THE LIST, AND WHY IT LOOKS LIKE NOTHING.

   The instruction was alignment rather than colour, so there is no colour here
   and nothing that is only pattern. Every row is the same height, every row
   has the same three parts in the same three places, and the two lines of text
   share ONE left edge -- the icon sits in a fixed gutter ahead of that edge
   rather than in the text column, so the names form a single vertical line
   down the list and the descriptions form a second one directly under them
   rather than each name being indented by however wide its own icon drew.

   The chevron is the only thing on the right, and it is the affordance: it is
   the one mark in the row that says this is a door and not a heading. Rows are
   separated by the hairline the rest of the dialog already uses rather than by
   cards or shadows, because fourteen boxes stacked vertically is fourteen
   boundaries to read on a screen that has room for six.

   `min-h-[56px]` rather than the 44px floor: 44 is the smallest a target may
   be, not the size a two-line row wants, and at 44 the description crowds the
   name badly enough that the pair stops reading as one thing. `text-left` is
   explicit because a <button> centres its text and every one of these is a
   sentence. */
function SectionList({ items, onOpen }: { items: ListItem[]; onOpen: (id: string) => void }) {
  return (
    <div
      data-settings-list=""
      className={cn(
        'divide-y', 'divide-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]',
      )}
    >
      {items.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpen(item.id)}
            className={cn(
              'flex min-h-[56px] w-full items-start gap-3 rounded-[8px] px-2 py-3 text-left',
              'transition-colors', INK, WASH, RING,
            )}
          >
            {/* Both marks sit on the NAME's line, not in the middle of the
                row. Centred against a two-line block they float between the
                two sentences and belong to neither, and the second line then
                starts further left than the first thing above it. Pinned to
                the top the whole row has one horizontal band -- icon, name,
                chevron -- with the description hanging beneath it, so the
                names read down the list as one column and the descriptions as
                a second directly under them. The 2px is optical: a 16px glyph
                against a 13.5px line sits a shade high without it. */}
            <Icon className="mt-[2px] size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium">{item.label}</span>
              <span className="mt-0.5 block text-[12px]">{item.note}</span>
            </span>
            <ChevronRight className="mt-[2px] size-4 shrink-0" aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}

export function AppearanceDialog({
  open,
  onClose,
  initialTab = 'appearance',
}: {
  open: boolean
  onClose: () => void
  initialTab?: 'appearance' | 'dock' | 'dashboard'
}) {
  const { appearance, set } = useAppearance()
  const { skin, setSkin } = useSkin()
  const { layout: frame, setLayout: setFrame } = useFrameLayout()
  const [picking, setPicking] = useState(false)
  const onPickingChange = useCallback((v: boolean) => setPicking(v), [])
  const t = useT()
  /* One page at a time, not one long scroll.

     Everything lived on a single 76vh scroller: typeface specimens, seven
     appearance axes, the colour wheel, dock sizing and widget controls. Finding
     the dock's icon size meant scrolling past fifteen font previews, and the
     panel was tall enough that centring it pushed its own header off the top of
     the screen.

     The menu items that open this dialog already say which part somebody
     wanted, so that choice seeds the page rather than being thrown away and
     replaced with a scroll-into-view. */
  /* The four display pages, and then whatever the catalogue grants.

     The display tabs are a fixed union because this file implements them. The
     link tabs are not: they exist only when the signed-in user has something
     usable behind them, so the type is the union of both and the nav is built
     from a list rather than written out. On a school still in setup the nav is
     five tabs; on a fully granted institution admin it is eight. */
  type Tab = 'appearance' | 'colour' | 'dock' | 'dashboard' | LinkTab
  const sections = useSettingsLinks()
  const narrow = useNarrow()

  /* null is a page too, and on a phone it is the FIRST page.

     `null` means the list of sections rather than any section. On a wide
     viewport it never holds -- the strip is showing every section anyway, so
     landing on a menu of things already on screen would be a press charged for
     nothing -- and the effect below puts Appearance back if the window is
     dragged wide while the list is up. */
  const [tab, setTab] = useState<Tab | null>(null)

  /* What the dialog opens on, which is not the same question at both widths.

     `initialTab` is 'dock' or 'dashboard' only when somebody ASKED for that
     page: the tab menu offering to add a widget to the board they
     right-clicked. That is a request and it is honoured at every width. The
     cog, which is how almost everybody arrives, always sends 'appearance' --
     that is a default and not a request, and answering a default by dropping
     somebody inside one of eight sections is exactly how the other seven came
     to be invisible. So on a phone the plain cog opens the list. */
  useEffect(() => {
    if (!open) return
    if (initialTab === 'dock') setTab('dock')
    else if (initialTab === 'dashboard') setTab('dashboard')
    else setTab(narrow ? null : 'appearance')
  }, [open, initialTab, narrow])

  useEffect(() => {
    if (!narrow && tab === null) setTab('appearance')
  }, [narrow, tab])

  /* BACK IS ALSO THE PHONE'S OWN BACK, AND IT WAS CHEAP.

     A drill-in that only a button in the corner can undo is a drill-in half
     the people using it will try to leave with the system gesture, and on
     Android that gesture would have closed the tab or left the app entirely --
     from a settings dialog, having changed something, with no way to tell that
     is what happened.

     One `pushState` on the way in buys it. The entry is this dialog's own, it
     carries no URL change so nothing about routing moves, and `popstate` puts
     the list back. The in-dialog back button calls `history.back()` rather
     than setting state directly, so there is exactly one path out of a section
     and the history stack cannot drift out of step with what is drawn. Closing
     the dialog from inside a section unwinds whatever it pushed, so the
     gesture does not later walk backwards through pages of a window that is
     no longer open.

     `owned` counts what this dialog pushed rather than trusting the state
     object, because another entry can arrive between ours and the pop. */
  const owned = useRef(0)
  const openSection = useCallback((id: string) => {
    setTab(id as Tab)
    if (typeof window !== 'undefined') {
      window.history.pushState({ bentoSettings: id }, '')
      owned.current += 1
    }
  }, [])
  const backToList = useCallback(() => {
    if (owned.current > 0) window.history.back()
    else setTab(null)
  }, [])
  useEffect(() => {
    if (!open || !narrow) return
    const onPop = () => {
      owned.current = Math.max(0, owned.current - 1)
      setTab(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [open, narrow])

  /* The list, in the order the sections are asked for: what this window looks
     like first, then what it is for. The catalogue decides which of the second
     four exist, and a section with nothing reachable behind it contributes no
     row at all -- the same rule the tab strip has always obeyed. */
  const listItems = useMemo<ListItem[]>(() => [
    { id: 'appearance', label: t('bento.appearance.title'), ...DISPLAY_META.appearance },
    /* 'Colour' and not `bento.colour.title`, which is "Colour settings" --
       inside a window called Settings, under a heading called Settings, the
       second word is the one thing on the row that says nothing. */
    { id: 'colour', label: 'Colour', ...DISPLAY_META.colour },
    { id: 'dock', label: 'Dock', ...DISPLAY_META.dock },
    { id: 'dashboard', label: 'Dashboard', ...DISPLAY_META.dashboard },
    ...sections.map(({ group }) => ({
      id: group.id, label: group.label, icon: group.icon, note: group.note,
    })),
  ], [t, sections])

  const current = listItems.find((i) => i.id === tab)

  /* If a grant goes away while the dialog is open -- a role change, a
     catalogue refetch -- the tab that was selected can stop existing. Falling
     back to Appearance is better than rendering a blank page under a tab
     header that is still highlighted. */
  useEffect(() => {
    const isLink = LINK_GROUPS.some((g) => g.id === tab)
    if (isLink && !sections.some((s) => s.group.id === tab)) setTab(narrow ? null : 'appearance')
  }, [sections, tab, narrow])

  const dockRef = useRef<HTMLElement>(null)
  const dashRef = useRef<HTMLElement>(null)

  /* Every face is fetched when the picker opens, not when the app loads.

     Fifteen families is roughly two megabytes; paying that on every visit so a
     dialog most people never open can draw its specimens would be the whole
     cost of this feature landing on the wrong person. */
  useEffect(() => {
    if (open) ensureAllFonts()
  }, [open])

  /* Scroll to the requested section when the dialog opens */
  /* While this is open, the dock is lifted above it and the panel keeps clear
     of the bottom of the screen.

     Dock Settings changes the dock, and the dialog was drawn over the top of
     it — so the one control you were adjusting was the one thing you could not
     see change. Marking the root rather than passing a prop keeps the dock
     ignorant of this dialog's existence. */
  useEffect(() => {
    if (!open) {
      delete document.documentElement.dataset.appearanceOpen
      return
    }
    document.documentElement.dataset.appearanceOpen = 'true'
    return () => {
      delete document.documentElement.dataset.appearanceOpen
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const el = initialTab === 'dock' ? dockRef.current : initialTab === 'dashboard' ? dashRef.current : null
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
  }, [open, initialTab])

  const handleClose = () => {
    if (typeof document !== 'undefined' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    }
    /* Hand back the history entries the drill-in borrowed. Without this the
       phone's back gesture spends the next press or two walking through pages
       of a dialog that has already gone, which reads to the person doing it
       as a back button that does nothing. */
    if (owned.current > 0 && typeof window !== 'undefined') {
      const n = owned.current
      owned.current = 0
      window.history.go(-n)
    }
    onClose()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // The crosshair swallows the first Escape; the dialog takes the second.
      if (e.key !== 'Escape' || picking) return
      /* Escape unwinds the same way the back button does, one level at a
         time. Inside a section on a phone, Escape means "out of here", and
         out of here is the list -- closing the whole window instead would
         throw away the one press that got you in. */
      if (narrow && tab !== null) backToList()
      else handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, picking, narrow, tab, backToList])

  if (!open) return null

  return createPortal(
    <div
      /* While the crosshair is armed the whole dialog stops intercepting, so a
         click reaches the region underneath instead of the backdrop. Fading
         rather than closing: closing would lose the channel and colour already
         chosen, and the point of aiming is to come back and keep working. */
      className={cn(
        'appearance-overlay fixed inset-0 z-[70] grid place-items-center overflow-y-auto p-4 sm:p-6',
        picking ? 'pointer-events-none bg-transparent' : 'bg-black/40',
      )}
      onClick={picking ? undefined : handleClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('bento.settings.label')}
    >
      <div
        data-appearance-dialog=""
        /* The panel states its own pair, and its edge is a boundary rather
           than a seam.

           `bg-popover` with no ink beside it left the words inheriting from
           <body>; the outer `border` was `--bento-line` at 1.38:1, which is
           not enough to separate a floating dialog from the page behind it. */
        className={cn(
          /* A HEIGHT, not a maximum, and `max-h-full` under it.

             Two things came out of `max-h`. The dialog resized every time
             somebody moved between its four pages — Colour is a wheel and two
             sliders, Dashboard is a list — so the tabs moved under the cursor
             and the whole panel jumped on each switch. And the panel was 88vh
             plus the dock's 132px of clearance, which is taller than the
             window: a centred grid item that overflows its container overflows
             it at BOTH ends, so the top of the dialog, its title and its tabs
             went off the top of the screen with no way to scroll back up.

             Fixed height fixes the first. `max-h-full` fixes the second by
             letting the panel give way to the clearance, which the overlay now
             carries as padding rather than the panel as a margin. */
          `appearance-panel pop-down flex h-[min(88vh,760px)] max-h-full w-full max-w-[980px]
           flex-col overflow-hidden rounded-[16px] border
           shadow-[var(--lift-float)]`,
          SURFACE, EDGE,
          // Still clickable while aiming, so the dialog can be used to cancel.
          picking && 'pointer-events-auto opacity-25',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={cn('flex items-start justify-between gap-4 border-b px-5 py-4 sm:px-7 sm:py-5', SEAM)}>
          {/* THE WINDOW IS CALLED SETTINGS AGAIN.

              It was headed Appearance, under a subtitle promising the choices
              are "remembered on this device", which was true of everything it
              held while everything it held was a font and a palette. It is not
              true of school setup or of who the school may message: those are
              the school's, they are on the server, and they are the same for
              everybody. Leaving the old heading over the new sections would
              have been a window telling somebody their change is local while
              it changes the school. So the panel takes the name the cog has
              always had, and the device promise moves down to the pages it
              still describes. */}
          {/* WHERE YOU ARE, AND THE WAY BACK, IN THAT ORDER.

              On a phone inside a section the header stops being the window's
              title and becomes the page's: the back control first, then the
              section's own name at the size the window's name used to be, then
              that section's own line. The name of the window is not lost --
              it is the label ON the back control, which is where a name you
              are returning to belongs. Everywhere else the header is what it
              was.

              The subtitle is now the same sentence the list row carried, for
              whichever page is open, rather than one blanket promise for all
              of them. That promise said a change is "remembered on this
              device", which was true of a typeface and false of who the school
              may message -- a window telling somebody their change is local
              while it changes the school for everyone. */}
          <div className="min-w-0">
            {narrow && tab !== null && (
              <button
                type="button"
                onClick={backToList}
                className={cn(
                  'group -ml-2 mb-1 flex min-h-[44px] items-center gap-1 rounded-[8px] pl-1.5 pr-2.5',
                  'text-[13px] transition-colors', INK, WASH, RING,
                )}
              >
                <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
                {t('bento.settings.label')}
              </button>
            )}
            <h2 className={cn('text-[21px] font-semibold', INK)}>
              {narrow && current ? current.label : t('bento.settings.label')}
            </h2>
            <p className={cn('mt-0.5 text-[13px]', INK)}>
              {current
                ? current.note
                : 'Everything you can change from here, and where each change lands.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label={t('bento.launcher.close')}
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-[8px] transition-colors',
              INK, WASH, RING,
            )}
          >
            <X className="size-4" />
          </button>
        </header>

          {/* The pages, named. A dialog that opens on one of them with no way
              to see the others is a dialog people think is broken.

              THE ROW SCROLLS SIDEWAYS RATHER THAN WRAPPING.

              It was four tabs and could afford `flex`; it is up to eight now,
              and at 390px eight of them wrapped to three lines, which pushed
              the panel's content below the fold before it had drawn anything
              and moved every tab under the finger each time one was pressed.
              A single scrolling line keeps the header a fixed height and keeps
              the tab you just pressed where you pressed it. `px-7` stays as
              scroll padding at the ends so the first and last tabs are not
              flush against the panel edge.

              Each tab is 44px tall, which is the touch floor, and `shrink-0`
              so they keep their labels rather than compressing into ellipses
              when the row is wider than the panel. */}
          <nav
            /* Wide viewports only. Below 768px this is the control that was
               the whole defect -- see useNarrow above -- and the list replaces
               it rather than sitting beside it, because two navigations for
               one set of pages is how the popover era went wrong. */
            className={cn('scroll-x hidden shrink-0 gap-1 overflow-x-auto border-b px-7 pt-3 md:flex', SEAM)}
            aria-label="Settings sections"
          >
            {/* Driven by the same list the phone's rows are, so the two
                navigations cannot come to disagree about which sections exist
                or what they are called -- they were two hand-written lists,
                which is how the strip's "Colour" and the panel's "Colour
                settings" ended up being the same page under two names. */}
            {listItems.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id as Tab)}
                aria-current={tab === id}
                className={cn(
                  'min-h-[44px] shrink-0 whitespace-nowrap rounded-t-[8px] border-b-2 px-3 py-2 text-[13px] transition-colors',
                  tab === id
                    ? 'border-primary font-medium text-foreground'
                    : cn('border-transparent', INK, WASH),
                )}
              >
                {label}
              </button>
            ))}
          </nav>

        {/* `.scroll-y` draws the bar rather than waiting for the platform to
            fade one in. A dialog with four pages behind its tabs — one of them
            fifteen typeface cards — has to say on its first paint that there is
            more below the fold. See index.css. */}
        <div className="scroll-y min-h-0 flex-1 px-5 py-5 sm:px-7 sm:py-6">
          {tab === null && <SectionList items={listItems} onOpen={openSection} />}
          {tab === 'appearance' && (<div>
          {/* LAYOUT FIRST, ABOVE THE TYPEFACE CARDS.

              It sat at the foot of the axis stack, below fifteen typeface
              specimens and five scales -- past the fold on most windows, for
              the one control here that changes the shape of the whole screen
              rather than its finish. Everything else on this page is a matter
              of degree; this is the frame they are all applied to, so it is
              asked first and the rest follows. */}
          <div className={cn('mb-6 border-b pb-2', SEAM)}>
            <Choice<Layout>
              label={t('bento.settings.layout')}
              value={frame}
              options={LAYOUTS}
              onPick={setFrame}
              name={(v) => t(`bento.settings.layout.${v}`)}
            />
          </div>

          <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
            <Type className="size-4" aria-hidden="true" />
            {t('bento.settings.typeface')}
          </h3>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {TYPEFACES.map((face) => {
              const on = appearance.typeface === face.id
              return (
                <button
                  key={face.id}
                  type="button"
                  onClick={() => set('typeface', face.id)}
                  aria-pressed={on}
                  /* CHOSEN IS AN OUTLINE HERE, NOT A FILL.

                     The card's whole job is to show a face set in itself, so
                     it cannot be inverted the way the other chosen states in
                     these dialogs are — the specimen has to stay on the paper
                     it will be read on. So the ink does the marking from the
                     edge instead.

                     It was `border-primary ring-primary`, which the stylesheet
                     resolves to the mint accent: 1.29:1 against the card, so
                     the one card in fifteen that is selected was marked with a
                     boundary you cannot see. The ink is 21:1 in every palette,
                     and the check beside the name says the same thing a second
                     way for anybody who cannot use the outline. */
                  className={cn(
                    'rounded-[12px] border p-4 text-left transition-colors',
                    RING, INK,
                    on
                      ? '!border-[var(--bento-ink)] ring-1 ring-[var(--bento-ink)]'
                      : cn(EDGE, WASH),
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium">{face.name}</span>
                    {on && <Check className="size-4 shrink-0" aria-hidden="true" />}
                  </span>
                  {/* The specimen, set in the face it is offering. font-feature
                      settings are left alone: a face's default figures are the
                      ones somebody will actually get. */}
                  <span
                    className="mt-1 block text-[19px] leading-snug"
                    style={{ fontFamily: face.stack }}
                  >
                    {SPECIMEN}
                  </span>
                  <span className={cn('mt-1.5 block text-[12px]', INK)}>
                    {face.note}
                  </span>
                </button>
              )
            })}
          </div>

          <p className={cn('mt-5 text-[12px]', INK)}>
            {t('bento.appearance.font_note', {
              name: typefaceById(appearance.typeface).name,
            })}
          </p>

          <div className={cn('mt-7 divide-y border-t pt-1', SEAM, 'divide-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]')}>
            <Scale axis="text" label={t('bento.settings.text')} />
            <Scale axis="density" label={t('bento.settings.density')} />
            <Scale axis="corners" label={t('bento.settings.corners')} />
            <Scale axis="borders" label={t('bento.settings.borders')} />
            <Scale axis="shadow" label={t('bento.settings.shadow')} />
            <Axis<Contrast>
              label={t('bento.settings.contrast')}
              value={appearance.contrast}
              options={CONTRASTS}
              onPick={(v) => set('contrast', v)}
              name={(v) => t(`bento.settings.contrast.${v}`)}
            />
            {/* The frame, which used to be a pane of its own behind the
                settings menu.

                It was the only thing left in that pane once the theme rows
                went, so the menu carried a row called Appearance that led to a
                single choice — and a second row, also called Appearance, that
                led here. Two identical labels going to different places is not
                a hierarchy, it is a coin toss. Whether the screen is framed or
                bare is an answer to the same question the axes above answer,
                so it is asked in the same place. */}
            {/* Frame is two states as well -- premium or focus -- so it takes
                the toggle for the same reason layout did. Contrast above it
                stays an axis: normal, medium, high is a scale, and "a bit
                more" is exactly what somebody adjusting it means. */}
            <Choice<Skin>
              label={t('bento.settings.frame')}
              value={skin}
              options={SKINS}
              onPick={setSkin}
              name={(v) => t(`bento.settings.skin.${v}`)}
            />
          </div>

          <AppearanceActions onClose={onClose} />

          {/* Colour, in the same dialog rather than behind a second door.

              Typeface, density and colour are three answers to one question —
              how should this look — and splitting them across two windows made
              somebody close one to reach the other. */}
          </div>)}
          {tab === 'colour' && (
          <section>
            <h3 className="mb-3 hidden md:flex items-center gap-2 text-[13px] font-semibold">
              <Palette className="size-4" aria-hidden="true" />
              {t('bento.colour.title')}
            </h3>
            <ColourPanel onPickingChange={onPickingChange} />
          </section>
          )}
          {tab === 'dock' && (
          <section ref={dockRef}>
            <h3 className="mb-4 hidden items-center gap-2 text-[13px] font-semibold md:flex">
              <LayoutGrid className="size-4" aria-hidden="true" />
              Dock
            </h3>
            <div className={cn(
              'divide-y border-t', SEAM,
              'divide-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]',
            )}>
              <Axis<DockSize>
                label="Bar size"
                value={appearance.dockSize}
                options={DOCK_SIZES}
                onPick={(v) => set('dockSize', v)}
                name={(v) => ({ compact: 'Compact', default: 'Default', large: 'Large' }[v])}
              />
              <Axis<IconSize>
                label="Icon size"
                value={appearance.iconSize}
                options={ICON_SIZES}
                onPick={(v) => set('iconSize', v)}
                name={(v) => ({ small: 'Small', default: 'Default', large: 'Large' }[v])}
              />
            </div>
            <DockItemsToggle />
          </section>
          )}
          {tab === 'dashboard' && (
          <section ref={dashRef}>
            <h3 className="mb-1 hidden items-center gap-2 text-[13px] font-semibold md:flex">
              <Sliders className="size-4" aria-hidden="true" />
              Dashboard Widgets
            </h3>
            <p className={cn('mb-4 text-[12px]', INK)}>
              Add, remove, resize and reorder the cards on this dashboard.
            </p>
            <DashboardWidgets onArrange={onClose} />
          </section>
          )}

          {/* The catalogue-driven pages.

              One section per tab rather than all of them on one scroller: the
              reason the display settings were split into pages in the first
              place applies here too, and School is one row while Security is
              four. Nothing renders for a group the user has no grant in, and
              its tab was never drawn either, so there is no state in which
              this pane is empty. */}
          {sections.map(({ group, links }) => tab === group.id && (
            <div key={group.id}>
              <LinkSection group={group} links={links} />
            </div>
          ))}
        </div>

      </div>
    </div>,
    document.body,
  )
}

/* THE FOOTER IS GONE, AND ITS FOUR ACTIONS WENT WHERE THEY BELONG.

   When the settings popover collapsed into this window, the four rows it still
   had -- full screen, reset appearance, my profile, sign out -- were put in a
   strip along the bottom, and the reasoning given was that a footer is
   reachable from every tab. That was true and it was still the wrong home for
   them, because reachable from everywhere means repeated under everything: a
   strip under the Colour wheel offering to sign you out, a strip under School
   setup offering to reset your typeface. Four unrelated actions shown eight
   times is not availability, it is noise with a fixed 44px of the panel's
   height spent on it -- height a phone does not have to give.

   So each one moved to the single place where it is the obvious next thing.

   Full screen and Reset appearance are appearance. Reset appearance undoes
   precisely the axes on this page and nothing else in the dialog, so offered
   anywhere else it is a button whose scope you have to guess. Full screen is
   less obvious, because a bigger window is not literally a preference stored
   with the others -- but it is a change to how much of this product you are
   looking at and it is remembered by nothing, which puts it with the display
   choices and not with the school's settings. Both are at the FOOT of the
   appearance page rather than the head of it: they are what you reach for
   having tried the axes, and reset in particular is a door you want to have to
   arrive at rather than one you can brush past.

   My profile and Sign out are the account, and Account is a section of this
   dialog. They are rows in it now, which is also what makes them honest -- as
   footer buttons they were two words each, and as rows they say what they do
   and what they cost. That section is marked `always` so that moving them
   there cannot make them disappear on a school whose catalogue grants nothing:
   neither row asks the catalogue anything.

   What is left here is the pair that stayed with the page they act on. */
function AppearanceActions({ onClose }: { onClose: () => void }) {
  const t = useT()

  /* Full screen, tracked rather than assumed.

     The control has to say which way it goes, and the state can change without
     it -- Escape and F11 both leave full screen without touching this dialog --
     so it listens rather than remembering what it last asked for. */
  const [full, setFull] = useState(
    () => typeof document !== 'undefined' && !!document.fullscreenElement,
  )
  useEffect(() => {
    const onChange = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFull = () => {
    /* Both calls reject rather than throw -- a browser may refuse full screen
       when the gesture is not trusted -- so the rejection is swallowed and the
       listener above keeps the label truthful either way.

       The dialog closes on the way in: going full screen to look at the
       dashboard and finding a settings window over it is not what anybody
       meant by the button. */
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
      onClose()
    } else {
      void document.documentElement.requestFullscreen().catch(() => {})
      onClose()
    }
  }

  /* A border now, where the footer's buttons had none.

     In the strip they were the only things on a bar of their own and read as
     controls by position. On a page, below a stack of sliders and pills, an
     unbordered label is just more text, so they take the same hairline edge
     every other pressable thing in this dialog wears. `min-h-[44px]` because
     they are on a phone page now rather than in desktop chrome. */
  const ACTION = cn(
    'flex min-h-[44px] items-center gap-2 rounded-[10px] border px-3.5 py-2 text-[12.5px]',
    'transition-colors', EDGE, INK, WASH, RING,
  )

  return (
    <div className={cn('mt-6 flex flex-wrap items-center gap-2 border-t pt-4', SEAM)}>
      <button type="button" onClick={toggleFull} className={ACTION}>
        {full
          ? <Minimize2 className="size-4 shrink-0" aria-hidden="true" />
          : <Maximize2 className="size-4 shrink-0" aria-hidden="true" />}
        {t(full ? 'bento.settings.fullscreen.exit' : 'bento.settings.fullscreen')}
      </button>

      {/* A way back. Enough axes live in this dialog at once that somebody
          ends up somewhere they cannot retrace, and a settings window with no
          exit from itself is a trap. */}
      <button type="button" onClick={() => resetAppearance()} className={ACTION}>
        <RotateCcw className="size-4 shrink-0" aria-hidden="true" />
        {t('bento.settings.reset')}
      </button>
    </div>
  )
}

/* Settings' half of the arranger.

   The board itself is where sizing and dragging happen — you size a card by
   looking at it. What belongs HERE is everything you cannot do from the board
   once a card is gone from it: seeing the full roster of what this dashboard
   can show, putting something back, and starting over.

   It reads the board the layer publishes rather than importing any dashboard,
   so it stays correct for the six dashboards that have widgets and honest on
   the screens that do not. */
function DashboardWidgets({ onArrange }: { onArrange: () => void }) {
  const { dashboard, widgets, setArranging } = useBoard()
  const { layout, place, remove, reset } = useLayout(dashboard ?? 'none')

  if (!dashboard || widgets.length === 0) {
    return (
      <div className={cn('rounded-[10px] border border-dashed p-4 text-[12.5px]', EDGE, INK)}>
        This screen has no arrangeable dashboard. Open one of the dashboards — the
        principal, finance, faculty, parent or student home — and these controls
        will list its cards.
      </div>
    )
  }

  const arranged = layout.placed.length > 0 || layout.removed.length > 0

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setArranging(true)
            // The board is the thing being arranged, so the dialog covering it
            // gets out of the way rather than asking to be dismissed.
            onArrange()
          }}
          /* The accent on its own tint, which is the pairing that does not
             work. `text-primary` resolves to the mint darkened toward the ink
             and `bg-primary-soft` to the mint's own tint — and under the
             default palette those are the same lime, so the label measured
             2.76:1 on its own button. Inverted instead, the way every other
             chosen state in these dialogs is: ink on card, 21:1 in every
             palette, and no coloured word left on the surface. */
          className={cn(
            'rounded-full border px-3 py-1.5 text-[12.5px] transition-colors',
            CHOSEN, RING,
          )}
        >
          Arrange on the dashboard
        </button>
        {arranged && (
          <button
            type="button"
            onClick={reset}
            className={cn(
              'rounded-full border px-3 py-1.5 text-[12.5px] transition-colors',
              EDGE, WASH, RING, INK,
            )}
          >
            Reset to default
          </button>
        )}
      </div>

      <ul className={cn(
        'divide-y rounded-[10px] border', EDGE,
        'divide-[color-mix(in_srgb,var(--bento-ink)_20%,transparent)]',
      )}>
        {widgets.map((w) => {
          const off = isRemoved(layout, w.id)
          return (
            <li key={w.id} className="flex items-center gap-3 px-3 py-2">
              {/* "Off the board" is carried by the strike-through, which does
                  not cost the label any contrast. It used to also drop to the
                  muted tone, and a second, weaker signal for a state the first
                  one already states is a row that is harder to read for
                  nothing. */}
              <span className={cn('flex-1 truncate text-[12.5px]', INK, off && 'line-through')}>
                {w.label}
              </span>
              <span className={cn('shrink-0 text-[11px] tabular-nums', INK)}>
                {off ? '—' : `${w.w}×${w.h}`}
              </span>
              <button
                type="button"
                onClick={() => (off ? place(w.id, DIMS[w.size].w, DIMS[w.size].h) : remove(w.id))}
                className={cn(
                  'shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                  EDGE, WASH, RING, INK,
                )}
              >
                {off ? 'Add' : 'Remove'}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
