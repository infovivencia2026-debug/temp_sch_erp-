import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Building2, ChevronLeft, LayoutGrid, MessageSquare,
  Palette, ShieldCheck, Sliders, Type, UserCircle, X,
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
  INK, EDGE, WASH, RING, SEAM, SURFACE,
} from './ColourDialog'
import { cn } from '@/lib/utils'
import { Rows, Row, NavRow, SegmentRow, SelectRow, SliderRow, SwitchRow } from './SettingsRows'
import { featurePath, useActiveRole, useCatalog, usable, allRolesOn } from '@/lib/catalog'
import { useSkin, SKINS, type Skin } from '@/lib/skin'
import { usePersonality, PERSONALITIES, type Personality } from '@/lib/personality'
import { useFullScreen } from '@/lib/fullscreen'
// Aliased: '@/lib/widgets' exports a useLayout of its own, about where the
// dashboard cards sit. This one is the frame -- sidebar or focus.
import { useLayout as useFrameLayout, LAYOUTS, type Layout } from '@/lib/layout'
import { useBoard, useLayout, isRemoved, DIMS, requestArrange } from '@/lib/widgets'
import { useNavigate } from 'react-router-dom'
import { useOverlayHistory } from '@/lib/overlay-history'

/* Choosing a typeface by looking at it.

   A list of font names is a list of words in the wrong font. The only way to
   pick a face is to see it set, so every card renders the same specimen in the
   face it offers — letters, a grouped figure and a rupee amount, because this
   is a product where most of the type on screen is money and roll numbers, and
   a face that handles Aa beautifully can still put a comma in an ugly place.

   The specimen is the same string in every card on purpose. Comparison needs a
   constant; fifteen different sample sentences would be fifteen different
   questions. */

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

function Scale({ axis, label }: { axis: keyof Scales; label: string }) {
  const { appearance, setScale } = useAppearance()
  const r = SCALE_RANGE[axis]
  return (
    <SliderRow
      label={label}
      value={appearance.scales[axis]}
      min={r.min}
      max={r.max}
      step={r.step}
      onChange={(v) => setScale(axis, v)}
    />
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
function Choice<T extends string>(props: {
  label: string
  value: T
  options: readonly T[]
  onPick: (v: T) => void
  name: (v: T) => string
  helper?: React.ReactNode
}) {
  // Was a SelectRow, under a comment arguing at length for a toggle. The
  // argument was right and the code did not do it.
  return <SegmentRow {...props} />
}

function Axis<T extends string>(props: {
  label: string
  value: T
  options: readonly T[]
  onPick: (v: T) => void
  name: (v: T) => string
  helper?: React.ReactNode
}) {
  return <SelectRow {...props} />
}

/** Toggle panel: lets the user hide individual dock category icons. */
function DockItemsToggle() {
  const role = useActiveRole()
  const { appearance, set } = useAppearance()
  const workspaces: string[] = []
  for (const s of role?.sections ?? []) {
    if (!workspaces.includes(s.workspace || 'Other')) workspaces.push(s.workspace || 'Other')
  }
  if (!workspaces.length) return null
  const hidden = new Set(
    (appearance.hiddenDockItems ?? '').split(',').map((x) => x.trim()).filter(Boolean),
  )
  const toggle = (name: string) => {
    const next = new Set(hidden)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    set('hiddenDockItems', [...next].join(','))
  }
  /* One switch per category, as rows: on means the category has a place in
     the dock. A row of pills with a tick glyph in the label was a control
     you had to decode. */
  return (
    <>
      <p className="px-[16px] pt-[18px] pb-[4px] text-[12.5px] text-[var(--bento-ink)]">In the dock</p>
      {workspaces.map((name) => (
        <SwitchRow key={name} label={name} on={!hidden.has(name)} onToggle={() => toggle(name)} />
      ))}
    </>
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
  /** Show `note` under the row. Only where the catalogue's own name does not
      say what the screen is for. */
  explain?: boolean
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

type LinkTab = 'school' | 'messaging' | 'account' | 'roles' | 'security'

/* THE NAME OF A PAGE, SAID ONCE FOR BOTH SURFACES.

   This union used to be declared inside AppearanceDialog, which was fine while
   the dialog was the only thing that drew these pages. It is not any more: on
   a phone the same eight pages are a route, and a page name that two files
   each spell for themselves is a page name the two will eventually spell
   differently. So it lives at module scope and both surfaces import it.

   The four display pages are a fixed union because this file implements them.
   The link pages are not: they exist only when the signed-in user has
   something usable behind them, which is why the nav and the list are built
   from a list rather than written out. */
export type SettingsTab = 'appearance' | 'colour' | 'dock' | 'dashboard' | LinkTab

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
        explain: true,
        note: 'Whether parents may watch the bus live, how often a driver phone reports, and how long the trail is kept.',
      },
      {
        at: ['payments_devices', 'gps_hardware_integration'],
        explain: true,
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
    id: 'roles',
    note: 'The workspaces this account holds. Changing one changes every menu, board and screen in the product.',
    label: 'Role switch',
    icon: UserCircle,
    blurb: 'Which office you are working in. Everything else follows from it.',
    /* Never empty -- the rows are the roles on the account, which are not
       catalogue features and so cannot resolve to nothing. */
    always: true,
    rows: [],
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

type ResolvedLink = { href: string; name: string; note: string
  explain?: boolean
}

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
              explain: spec.explain,
            }
          }
        }
      }
      return undefined
    }

    /* WHO IS OFFERED A WORKSPACE TO SWITCH TO.

       The tab was shown to everybody, on the reasoning that somebody who
       later gains a second office would already recognise the control. That
       is wrong for the people who will never gain one: a parent holds a
       single workspace and can hold no other, so the row named it back to
       them and the tab beside Account asked a question with one answer.

       Offered where there is a choice to make -- the principal, who may look
       into every office in the building, and anybody whose account carries
       more than one workspace. A parent has neither and does not see it. */
    const mayChangeWorkspace =
      allRolesOn() ||
      (catalog.roles ?? []).length > 1 ||
      (catalog.roles ?? []).some((r) => r.key === 'institution_admin')

    const out: { group: LinkGroup; links: ResolvedLink[] }[] = []
    for (const group of LINK_GROUPS) {
      if (group.id === 'roles' && !mayChangeWorkspace) continue
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
  return <NavRow label={link.name} helper={link.explain ? link.note : undefined} href={link.href} />
}

/* THE WORKSPACE SWITCH, WHICH FOCUS HAD TAKEN AWAY.

   On its own tab rather than under Account. Account is the rows about your own
   record -- your profile, your leave, your pay, the door out -- and which
   office you are working in is not one of those: it is the setting every other
   screen in the product is drawn from. Filed beside them it read as a fifth
   personal detail.

   Switching role is the sidebar button at the top of the classic shell, and
   Focus hides the sidebar. The dock's own source says the header is where
   sign-out and the role switch live and that a Focus with no door is a bug --
   and then only half of it was moved: My profile and Sign out came here, the
   role switch did not. So somebody working in Focus could reach every office
   in the building from the address bar and from nowhere on the screen.

   It belongs in Account, beside the other two doors that came out of the same
   header, and it renders for everybody: a person with one workspace sees the
   one they are in and learns what the row is for, which is better than a
   control that appears one day without explanation.

   A hard navigation, like every other row here. A role is the first segment
   of the address and the whole shell -- sidebar, dock, catalogue, home board
   -- is built from it, so a router push would leave half the app describing
   the workspace somebody just left. */
function WorkspaceRows() {
  const catalog = useCatalog()
  const active = useActiveRole()
  const roles = catalog.roles ?? []
  if (roles.length === 0) return null
  return (
    <Rows>
      {roles.map((r) => {
        const here = r.key === active?.key
        /* Its own first section and feature, not a fixed path: a workspace
           does not necessarily have a dashboard, and sending somebody to one
           that does not exist is a role switch that lands on a blank page. */
        const first = r.sections?.[0]
        const feature = first?.features?.[0]
        const href = first && feature
          ? featurePath(r.key, first.slug, feature.slug)
          : `/${r.key}`
        return (
          <NavRow
            key={r.key}
            label={r.name}
            /* `current` is this component's own word for where you are: a
               wash and no chevron, because it opens nothing. */
            current={here}
            href={here ? undefined : href}
          />
        )
      })}
    </Rows>
  )
}

function LinkSection({ group, links }: { group: LinkGroup; links: ResolvedLink[] }) {
  return (
    <>
      {group.id === 'roles' && <WorkspaceRows />}
      <Rows>
        {links.map((l) => <LinkRow key={l.href} link={l} />)}
      </Rows>
    </>
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

export type ListItem = { id: string; label: string; icon: typeof Building2; note: string }

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
/* `bleed` is the phone sheet asking for its rules back.

   On a full-bleed sheet the list sits inside the sheet's single 16px inset,
   and a divider that respects that inset stops 16px short of the glass at
   both ends. Two short rules floating in a column of text do not read as the
   structure of a list; they read as an accident, and they draw attention to
   exactly the inset that was just reduced. Every settings list on every phone
   answers this the same way: the RULE runs to the edge and the TEXT is inset,
   which is one gesture rather than two competing ones.

   So the caller says whether it is drawing on a sheet, and when it is, the
   list cancels the sheet's inset with a negative margin of the same 16px and
   each row pays it back as its own padding. The rows' contents stay exactly
   where they were; only the rules and the pressed wash grow to the full
   width, which is also what makes a row look like something you can hit
   anywhere along.

   16px in pixels, not in rem. The root font is 14px here, so the `-mx-4` that
   reads as the same number computes to 14px and would leave a 2px ledge of
   card down either side of every rule: a misalignment that is hard to see and
   impossible to unsee. Anything that has to line up with a device edge or a
   sibling's edge is written in px in this codebase, and forgetting that has
   now caused five separate bugs here. */
export function SettingsSectionList({ items, onOpen, values, current }: {
  items: ListItem[]
  onOpen: (id: string) => void
  /** Kept for the dialog, which still passes it; rows carry their own inset now. */
  bleed?: boolean
  /** The current value a section row shows on a phone -- the row IS the
      explanation: "Appearance  Focus", "Dock  Default". */
  values?: Partial<Record<string, string>>
  /** The section on screen, when the list is a desktop nav. */
  current?: string | null
}) {
  return (
    <Rows>
      {items.map((item) => {
        const Icon = item.icon
        return (
          <NavRow
            key={item.id}
            label={item.label}
            value={values?.[item.id]}
            current={current === item.id}
            icon={<Icon className="size-4" aria-hidden="true" />}
            onClick={() => onOpen(item.id)}
          />
        )
      })}
    </Rows>
  )
}

/** What each section row says at a glance. Only where one value sums the
    section up honestly; a section with several equal choices says nothing. */
export function useSettingsValues(): Partial<Record<string, string>> {
  const t = useT()
  const { appearance } = useAppearance()
  const { layout: frame } = useFrameLayout()
  return {
    appearance: t(`bento.settings.layout.${frame}`),
    dock: ({ compact: 'Compact', default: 'Default', large: 'Large' }[appearance.dockSize]),
  }
}

/* THE LIST OF PAGES, OWNED BY NEITHER SURFACE.

   It is the same list twice over already -- the phone's rows and the wide
   strip's tabs are both built from it, precisely so the two cannot come to
   disagree about which sections exist or what they are called. Now that the
   phone's settings are a route rather than an overlay there is a third reader,
   and the rule has to hold across files as well as within one: a second
   hand-written copy of these eight rows is how "Colour" and "Colour settings"
   became two names for one page the last time.

   The catalogue decides which of the link sections exist. A group with nothing
   reachable behind it contributes no row and no tab, on the page exactly as in
   the dialog, because that gate lives in useSettingsLinks and both surfaces
   ask it the same question.

   In the order the sections are asked for: what this window looks like first,
   then what it is for. */
export function useSettingsItems(): ListItem[] {
  const t = useT()
  const sections = useSettingsLinks()
  return useMemo<ListItem[]>(() => [
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
}

/* THE WIDE-VIEWPORT NAV, LIFTED OUT SO THE ROUTE CAN DRAW IT TOO.

   Unchanged in every respect that shows: same tabs, same list behind them,
   same 44px touch floor, same `shrink-0` so a tab keeps its label rather than
   compressing to an ellipsis. It is a component rather than a block of JSX
   inside the dialog only because there are two surfaces now, and the strip
   above a settings PAGE has to be the same strip as the one above the settings
   dialog or the product has two settings navigations that drift.

   Still `md:flex`, so it is invisible below 768px. Below that width the list
   replaces it rather than sitting beside it, because two navigations for one
   set of pages is how the popover era went wrong. */
export function SettingsNav({
  items, tab, onPick,
}: {
  items: ListItem[]
  tab: SettingsTab | null
  onPick: (id: SettingsTab) => void
}) {
  return (
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
            {items.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => onPick(id as SettingsTab)}
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
  )
}

/* THE PAGES THEMSELVES, WHICH ARE NOW RENDERED IN TWO PLACES.

   WHAT WAS WRONG BEFORE. Settings was a dialog and only a dialog. On a phone
   that dialog was a full-bleed fixed overlay with role="dialog" sitting at
   z-70 over whatever screen you happened to be on, opened from a dock item
   that reads, to anybody looking at it, as the fourth tab of a tab bar. Three
   of those four items are destinations and the fourth was a modal wearing a
   tab's clothes. Every consequence of that pretence had to be paid for by
   hand: it needed its own pushState so the back gesture would not leave the
   app, the dock could not draw it as the current tab because there was no
   location saying it was current, and it left the screen by a mechanism
   nothing else on the phone uses. A route gets all three from the router.

   WHY THIS IS A COMPONENT AND NOT A SECOND COPY. Eight settings sections
   copied into a page component is eight sections that drift: one of them
   grows an axis, the other does not, and the difference is invisible until
   somebody changes their font on a phone and cannot find the control they
   used yesterday on a laptop. So the pages live here once, and the dialog and
   the page are two frames around the same content. The dialog keeps its
   header, its backdrop and its close button; the page keeps the shell's. What
   is inside is the same component with the same props.

   `onClose` is what the surface does when a page says it is finished --
   Arrange, on the dashboard page, wants the settings surface out of the way
   so somebody can see the board they are arranging. In the dialog that closes
   the window. On the route it navigates back to where the person came from,
   which is the same intent expressed in the idiom of a destination.

   The refs are optional because only the dialog has anything to scroll: it
   opens on a requested page and scrolls that page's heading to the top. The
   route opens ON the page, so there is nothing to scroll to. */
export function SettingsPane({
  tab, onClose, onPickingChange, dockRef, dashRef,
}: {
  tab: SettingsTab | null
  onClose: () => void
  onPickingChange?: (v: boolean) => void
  dockRef?: React.Ref<HTMLElement>
  dashRef?: React.Ref<HTMLElement>
}) {
  const { appearance, set } = useAppearance()
  const { skin, setSkin } = useSkin()
  const { personality, setPersonality } = usePersonality()
  const { layout: frame, setLayout: setFrame } = useFrameLayout()
  const sections = useSettingsLinks()
  const t = useT()
  const face = typefaceById(appearance.typeface)
  return (
    <>
      {tab === 'appearance' && (
        /* ROWS, IN THE ORDER SOMEBODY DECIDES THEM. The frame first, because
           it changes the shape of the screen the rest is applied to; then the
           typeface, whose value is set in the face itself so no specimen
           cards are needed; then the five continuous axes; then the three
           named choices; then the two actions. No heading over any of it --
           the page's own title says Appearance -- and no paragraph: the only
           helper is on Contrast, whose name does not say what it trades. */
        <Rows>
          <Choice<Layout>
            label={t('bento.settings.layout')}
            value={frame}
            options={LAYOUTS}
            onPick={setFrame}
            name={(v) => t(`bento.settings.layout.${v}`)}
          />
          <SelectRow
            label={t('bento.settings.typeface')}
            value={appearance.typeface}
            options={TYPEFACES.map((f) => f.id)}
            name={(id) => typefaceById(id).name}
            onPick={(id) => set('typeface', id)}
            valueStyle={{ fontFamily: face.stack }}
          />
          <Scale axis="text" label={t('bento.settings.text')} />
          <Scale axis="density" label={t('bento.settings.density')} />
          <Scale axis="corners" label={t('bento.settings.corners')} />
          {/* BORDERS AND SHADOW ARE GONE FROM THIS PANEL.

              Both were sliders over a value the board no longer varies. The
              cards are solid colours now, so a hairline between a card and the
              page is drawing a line between two things that already differ,
              and the board is one ruled sheet, which is a contradiction with a
              shadow under every cell of it. What the two axes actually did in
              practice was let somebody set a combination nobody wants: a 5x
              border on a solid ground, or a lift under a tile that is flush
              with its neighbours.

              The tokens stay and keep their defaults, so nothing in the
              stylesheet has to change and a value stored by somebody who moved
              these sliders before today is still read and still honoured. Only
              the controls are withdrawn. */}
          <Axis<Contrast>
            label={t('bento.settings.contrast')}
            value={appearance.contrast}
            options={CONTRASTS}
            onPick={(v) => set('contrast', v)}
            name={(v) => t(`bento.settings.contrast.${v}`)}
            helper="Higher makes text darker and rules heavier."
          />
          <Axis<Personality>
            label={t('bento.settings.personality')}
            value={personality}
            options={PERSONALITIES}
            onPick={setPersonality}
            name={(v) => t(`bento.settings.personality.${v}`)}
          />
          <Choice<Skin>
            label={t('bento.settings.frame')}
            value={skin}
            options={SKINS}
            onPick={setSkin}
            name={(v) => t(`bento.settings.skin.${v}`)}
          />
          <AppearanceActions onClose={onClose} />
        </Rows>
      )}
      {tab === 'colour' && (
        <section>
          <ColourPanel onPickingChange={onPickingChange} />
        </section>
      )}
      {tab === 'dock' && (
        <section ref={dockRef}>
          <Rows>
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
            <DockItemsToggle />
          </Rows>
        </section>
      )}
      {tab === 'dashboard' && (
        <section ref={dashRef}>
          <Rows>
            <Scale axis="boardText" label={t('bento.settings.board_text')} />
            <DashboardWidgets onArrange={onClose} />
          </Rows>
        </section>
      )}
      {sections.map(({ group, links }) => tab === group.id && (
        <div key={group.id}>
          <LinkSection group={group} links={links} />
        </div>
      ))}
    </>
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
  // The phone's Back closes this, like every overlay: see overlay-history.ts.
  useOverlayHistory(open, onClose)
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
  type Tab = SettingsTab
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

  const listItems = useSettingsItems()

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
        /* NO PADDING ON A PHONE: the panel is the screen there. See the note
           on the panel's own height. */
        'appearance-overlay fixed inset-0 z-[70] grid place-items-center overflow-y-auto p-0 sm:p-6',
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
          /* AND A FULL SHEET ON A PHONE, WHICH IS WHAT ITS SIBLING IS.

             88vh centred in an 844px window is a 743px card with fifty pixels
             of dashboard above and below it and the dock showing through
             underneath, and the last row of the section list cut through the
             middle at the bottom edge. Its sibling surface, the notification
             drawer, is a full sheet on a phone. Two panels the same dock opens,
             two different shapes, is the thing that reads as unfinished rather
             than either shape on its own.

             The centred dialog is kept from the small breakpoint up, where a
             window has room to show what is behind it and the panel reads as
             floating over the work rather than replacing it. */
          `appearance-panel pop-down flex h-full sm:h-[min(88vh,760px)] max-h-full w-full max-w-[980px]
           flex-col overflow-hidden rounded-none sm:rounded-[16px] border
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
          <SettingsNav items={listItems} tab={tab} onPick={(id) => setTab(id)} />

        {/* `.scroll-y` draws the bar rather than waiting for the platform to
            fade one in. A dialog with four pages behind its tabs — one of them
            fifteen typeface cards — has to say on its first paint that there is
            more below the fold. See index.css. */}
        <div className="scroll-y min-h-0 flex-1 px-5 py-5 sm:px-7 sm:py-6">
          {tab === null && <SettingsSectionList items={listItems} onOpen={openSection} />}
          <SettingsPane
            tab={tab}
            onClose={onClose}
            onPickingChange={onPickingChange}
            dockRef={dockRef}
            dashRef={dashRef}
          />
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
  const { supported, active: full, enter, exit } = useFullScreen()
  const toggleFull = () => {
    if (full) {
      exit()
      onClose()
    } else {
      void enter().then((ok) => { if (ok) onClose() })
    }
  }
  return (
    <>
      {(supported || full) && (
        <NavRow
          label={t('bento.settings.fullscreen')}
          value={full ? 'On' : 'Off'}
          onClick={toggleFull}
        />
      )}
      <NavRow label={t('bento.settings.reset')} onClick={() => resetAppearance()} />
    </>
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
  const navigate = useNavigate()
  const role = useActiveRole()
  const t = useT()
  /* THE DOOR WORKS FROM ANYWHERE.

     On a phone, Settings is a route and the board is unmounted underneath
     it, so "Arrange" had nothing to arrange and this section said "open a
     dashboard first" — from the one screen a person goes to looking for the
     control. Edit home now goes to the home screen and parks the intent,
     which the board picks up the moment it publishes (requestArrange). With
     the board already mounted, in the desktop dialog, it simply switches on. */
  const home = (() => {
    if (!role) return null
    const h = role.sections.find((s) => s.slug === 'home')
    const f = h?.features.find(usable)
    return h && f ? featurePath(role.key, h.slug, f.slug) : null
  })()
  const editHome = (
    <NavRow
      label={t('bento.widgets.edit_home')}
      onClick={() => {
        if (dashboard) {
          setArranging(true)
          onArrange()
        } else {
          // Leaving for the home screen IS the way out of settings here;
          // `onArrange` would step back into it.
          if (home) navigate(home)
          requestArrange()
        }
      }}
    />
  )
  if (!dashboard || widgets.length === 0) {
    return (
      <>
        {home && editHome}
        <Row label="Cards" helper="Open a dashboard first; its cards are listed here." />
      </>
    )
  }
  const arranged = layout.placed.length > 0 || layout.removed.length > 0
  return (
    <>
      {editHome}
      {arranged && <NavRow label="Reset layout" onClick={reset} />}
      {widgets.map((w) => {
        const off = isRemoved(layout, w.id)
        return (
          <SwitchRow
            key={w.id}
            label={w.label}
            on={!off}
            onToggle={() => (off ? place(w.id, DIMS[w.size].w, DIMS[w.size].h) : remove(w.id))}
          />
        )
      })}
    </>
  )
}
