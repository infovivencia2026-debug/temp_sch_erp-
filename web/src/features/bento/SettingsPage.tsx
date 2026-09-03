import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { useViewport } from '@/lib/viewport'
import { useFullScreenInvite } from '@/lib/fullscreen'
import { cn } from '@/lib/utils'
import { INK, EDGE, WASH, RING, SEAM } from './ColourDialog'
import {
  SettingsPane, SettingsSectionList, useSettingsItems, useSettingsValues,
  type SettingsTab,
} from './AppearanceDialog'
import { Rows, NavRow } from './SettingsRows'

/* SETTINGS AS A PLACE, WHICH ON A PHONE IS WHAT IT ALWAYS LOOKED LIKE.

   WHAT WAS WRONG. The dock's four items read as a tab bar: Home, Browse,
   Alerts, Settings. Three of them are destinations with URLs, and the fourth
   opened a fixed overlay with role="dialog" at z-70 over whatever screen you
   happened to be on. Nothing about that was visible in the dock, and every
   consequence of the pretence had to be paid for by hand. The overlay pushed a
   history entry of its own so that Android's back gesture would not close the
   tab from inside a settings window somebody had just changed something in.
   The dock could not draw Settings as the current tab, because nothing in the
   location said it was current, so the one item you were looking at was the
   one item that never highlighted. And it left the screen by a mechanism no
   other tab uses. A route gets the history entry, the current-tab test and the
   back behaviour from the router, for nothing.

   WHY THE DESKTOP DIALOG STAYS. AppearanceDialog's own argument, made twice
   over in that file, is that appearance is changed WHILE LOOKING AT the thing
   whose appearance is changing, and that sending somebody to a settings page
   to pick a palette makes them judge it on the wrong screen. On a desktop the
   dialog floats over the live page and that argument holds exactly. On a
   390px phone it does not hold and never did: the panel is already a full
   sheet there, `h-full ... rounded-none`, covering every pixel of the page it
   is supposedly floating over. There is no live page behind a phone dialog to
   judge anything against. So the argument is not overturned, it is applied:
   the surface that genuinely floats keeps floating, and the surface that was
   already a full screen becomes an honest one.

   THE PATH IS /settings, AND THAT IS NOT A FREE CHOICE HERE.

   Almost every path in this product belongs to the catalogue: `/:roleKey`,
   `/:roleKey/:sectionSlug` and `/:roleKey/:sectionSlug/:featureSlug` match
   nearly anything with one, two or three segments. A single-segment route
   added carelessly either shadows a workspace or is shadowed by one. Checked
   before choosing it: the catalogue ships thirteen role keys -- seller_admin,
   super_admin, institution_admin, admissions, front_office, finance, hr, hod,
   faculty, librarian, transport_manager, parent, student -- and none of them
   is "settings", so no workspace is being taken away from anybody. In the
   other direction React Router ranks a static segment above a dynamic one, so
   /settings wins over /:roleKey whatever order the routes are written in, and
   a role called "settings" added to the catalogue later would be shadowed
   rather than shadowing. That is the safe direction for the collision to
   fall, and it is the same bet /account already made and has been fine on.

   BentoOutlet resolves the URL against the catalogue and passes anything it
   cannot resolve straight through to the classic children, exactly as it does
   for /account, so this page renders as itself under both layouts.

   THE SECTION IS IN THE PATH, AND IT IS REPLACED RATHER THAN PUSHED.

   /settings is the list; /settings/colour is a section of it. Drilling in
   navigates with `replace`, so walking through four sections leaves ONE entry
   on the stack and the back gesture leaves settings the way it leaves any
   other tab, rather than reversing through the pages of it one at a time.
   That is the whole point of the change: a tab is a place you leave, not a
   stack you unwind. The in-page back control replaces too, for the same
   reason, so the two ways out of a section agree.

   None of the overlay's own pushState machinery runs here. It is still in
   AppearanceDialog, still guarded on `narrow && open`, and the dialog is only
   mounted from the cog -- which on a phone no longer opens it. Nothing is
   double-applied because nothing on this page touches history except the
   router. */

export default function SettingsPage() {
  const t = useT()
  const navigate = useNavigate()
  /* TWO COMPOSITIONS, NOT ONE SCALED.

     Below 1024px Settings is a NAVIGATION: the list of sections, each a
     44px row carrying its current value, each opening its own screen with
     one group of choices and the way back at the top. One decision per
     screen, because a phone shows one thing at a time and a thumb needs the
     target.

     From 1024px it is a PAGE: the same section list as a nav down the left,
     the chosen section's rows on the right, everything in view without a
     drill-in, and rows at 38px because a mouse points where a thumb cannot.
     The rows are the same components; only the composition and the three
     density properties differ. */
  const wide = useViewport() === 'desktop'
  const items = useSettingsItems()
  const values = useSettingsValues()
  const { section } = useParams()

  /* An address naming a section that does not exist -- a stale bookmark, a
     grant that has since been taken off this account -- is not an error page.
     The catalogue gates these sections, so "gone" is a normal outcome, and the
     honest answer is the list of what IS here. On a wide viewport the list is
     not a page, so it falls to Appearance the way the dialog does. */
  const found = items.find((i) => i.id === section)
  /* A LIST AT EVERY WIDTH. The desktop used to land on Appearance under a
     strip of tabs; the phone drilled in. One shape now: /settings is the
     list, a section is a page with the way back at the top. Measured before
     the change, the desktop landing carried 48 controls; the list carries
     one per section. */
  const tab: SettingsTab | null = found ? (found.id as SettingsTab) : wide ? 'appearance' : null

  /* ON A PHONE, A SECTION IS A SCREEN, AND BACK LEAVES IT.

     Both of these replaced the history entry, which is right on a wide
     viewport where the sections are tabs beside a list -- Back from a tab
     should leave Settings, not walk the tabs. On a phone the list and the
     section are two screens, and replacing meant the phone's Back gesture
     from a section jumped straight out of Settings to wherever the person
     had come from. Pushed on a phone, so Back returns to the list, and the
     list's own Back leaves. */
  /* Pushed on a phone so Back returns to the list; replaced on a desktop,
     where the list is beside the page and Back should leave Settings rather
     than walk its sections. */
  const open = useCallback((id: string) => {
    navigate(`/settings/${id}`, { replace: wide })
  }, [navigate, wide])

  const backToList = useCallback(() => {
    if (window.history.length > 1) navigate(-1)
    else navigate('/settings', { replace: true })
  }, [navigate])

  /* Where a page says it is finished. The only caller is Arrange, on the
     dashboard section, which wants the settings surface out of the way so the
     board underneath can be dragged. In the dialog that closes the window; the
     same intent on a route is going back to the screen you came from. */
  const done = useCallback(() => {
    navigate(-1)
  }, [navigate])

  return (
    /* THE PAGE SITS ON A CARD, AND THAT IS A CONTRAST DECISION.

       Every control inside SettingsPane paints itself with INK, EDGE, WASH and
       SEAM, and all four are `--bento-ink` -- a token whose measured ratios
       were taken against `--bento-card` and nothing else. The work area is
       `--bento-bg`, a different colour in every palette. Rendering the pane
       straight onto the work area would be shipping eight sections of body
       text whose contrast nobody has measured, which is precisely the class of
       bug this file's neighbourhood shipped today at 1.01:1. Putting the pane
       on the card means the page's ratios ARE the dialog's ratios, by
       construction rather than by a second measurement that can drift.

       The fallbacks matter for the classic layout, where `--bento-*` is not
       declared at all: an undeclared var in a colour position is an invalid
       property, which would have left this panel transparent with inherited
       ink on it. `--card` and `--card-foreground` are the classic layout's own
       pair for the same job and are defined in both themes. */
    /* FULL BLEED ON A PHONE, A CARD FROM `sm` UP.

       The dialog this replaces was already a full sheet below 640px --
       `h-full ... rounded-none` -- because 390px has no width to spend on a
       gutter and a two-line description in a 358px column wraps a line earlier
       than the same description in a 390px one. Inset by 16px with a radius
       and a border, the page would read as a card sitting on the work area,
       which is the shape its own sibling gave up. Above `sm` there is room for
       the panel to be a panel again. */
    /* ONE INSET ON A PHONE, NOT TWO STACKED.

       Measured at 390px on the live site: the section rows were 323px wide,
       running from x=16 to x=357, so 33.5px of a 390px screen -- 17 per cent
       of everything the reader has -- went on air before a word of content.
       That was two paddings, both individually defensible and wrong together:

         - the board's page gutter, 16px, set in BentoOutlet, which is right
           for a BOARD of cards that have to read as objects floating on a
           ground and therefore must not touch the glass;
         - this card's own `px-5`, which on a 14px root computes to 17.5px and
           not the 20px it looks like.

       The reason the pair is wrong specifically here is that on a phone this
       surface is not a card on a ground. It is a full sheet: `rounded-none`,
       no side borders, occupying every pixel. A sheet that already touches
       the edge does not need a gutter holding it away from that edge, and
       then a second inset inside the gutter. So below `sm` the sheet cancels
       the board's gutter with a negative margin of exactly the same 16px and
       spends 16px of its own instead: one inset, the same number, so the two
       surfaces agree about where a line of text starts. Rows go from 323px to
       358px, which is 35px -- most of a word per line, on a page whose every
       row carries a two-line description.

       From `sm` up nothing changes at all. There the panel genuinely is a
       floating card with a radius and a border on a page with room to spare,
       and both insets are correct for the same reason they were wrong below.

       Stated in px and not in rem, twice over. `-mx-4` is 14px on this root,
       not 16, and would leave a 2px ledge of the board's gutter down each
       side of a sheet that is supposed to be flush. That substitution has
       caused five separate bugs in this codebase. */
    <div className={cn(
      /* FULL SCREEN ON A PHONE, IN ALL FOUR DIRECTIONS.
       *
       * The horizontal gutter was already cancelled here so the rows reach the
       * glass. The vertical one was not, so the sheet started 21px down and
       * stopped 21px short: a settings surface floating in a band of ground,
       * which is what a card does and not what a screen does.
       *
       * `-mt-6 -mb-6` rather than a measured `-mt-[21px]`, deliberately. The
       * padding being cancelled is `pt-6 pb-6` on the outlet, and the same
       * token cancels it exactly whatever the root font size is. Writing the
       * pixel value would be right at 14px and wrong the moment somebody
       * changes the text size — which this very screen offers. */
      '-mx-[16px] -mt-6 -mb-6 w-[calc(100%+32px)] py-0',
      'sm:mx-auto sm:mt-0 sm:mb-0 sm:w-full sm:max-w-[980px] sm:px-6 sm:py-6',
    )}>
      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-none border-x-0 border-t-0',
          'sm:rounded-[16px] sm:border-x sm:border-t border-b',
          'bg-[var(--bento-card,hsl(var(--card)))]',
          'text-[var(--bento-ink,hsl(var(--card-foreground)))]',
          EDGE,
        )}
      >
        <header className={cn('border-b px-[16px] py-[12px] sm:px-[24px]', SEAM)}>
          {/* THE NAME OF WHERE YOU ARE, AND NOTHING ELSE. The line under the
              title ("Everything you can change from here, and where each
              change lands") was a sentence about the page on the page; the
              section's note repeated the row that opened it. Inside a
              section, the way back sits above the name, labelled with the
              name of the list it returns to. 44px in pixels: `min-h-11` is
              38.5px on this 14px root. */}
          {tab !== null && !wide && (
            <button
              type="button"
              onClick={backToList}
              className={cn(
                '-ml-[8px] flex min-h-[44px] items-center gap-1 rounded-[8px] pl-[6px] pr-[10px]',
                'text-[15px] transition-colors', INK, WASH, RING,
              )}
            >
              <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
              {t('bento.settings.label')}
            </button>
          )}
          <h1 className={cn('text-[20px] font-semibold', INK)}>
            {found && !wide ? found.label : t('bento.settings.label')}
          </h1>
        </header>

        {/* The wide strip, unchanged and shared with the dialog. It is
            `md:flex` inside SettingsNav, so on a phone it draws nothing and
            the list below is the only navigation -- two navigations for one
            set of pages is the thing this dialog already learnt not to do. */}
        {/* Rows carry their own 16px inset, so the sheet adds none; on a
            wide card the rows sit 8px in so their rules stop short of the
            card's own edge. */}
        {wide ? (
          /* THE PAGE. Nav left, the section right, both in view. Density
             properties set once here, in pixels, and read by every row. */
          <div
            className="grid grid-cols-[240px_minmax(0,1fr)]"
            style={{ ['--srow-h' as string]: '38px', ['--srow-py' as string]: '6px', ['--sband-h' as string]: '32px' }}
          >
            <nav aria-label="Settings sections" className={cn('border-r py-[8px]', SEAM)}>
              <SettingsSectionList items={items} onOpen={open} current={tab} />
            </nav>
            <div className="min-w-0 px-[8px] py-[8px]">
              <h2 className={cn('px-[16px] pt-[6px] pb-[8px] text-[15px] font-semibold', INK)}>
                {found?.label ?? items[0]?.label}
              </h2>
              <SettingsPane tab={tab} onClose={done} />
            </div>
          </div>
        ) : (
          /* THE NAVIGATION. The list, or one section with the way back in
             the header; 44px rows, the defaults. */
          <div className="py-[8px]">
            {tab === null && <FullScreenOffer />}
            {tab === null
              ? <SettingsSectionList items={items} onOpen={open} values={values} />
              : <SettingsPane tab={tab} onClose={done} />}
          </div>
        )}
      </div>
    </div>
  )
}

/* THE ONE INVITATION, AND WHY IT IS AN OFFER RATHER THAN A TOAST.

   WHAT IT IS FOR. Measured on a real Samsung handset in Chrome 151:
   window.innerHeight is 725 against a screen height of 832. The browser keeps
   107px -- thirteen per cent of the glass -- for a URL bar nobody asked for.
   On most sites that is a scroll away and costs nothing. This product's home
   screen is a fixed, non-scrolling board of cards packed to a page, so the
   107px does not move down the page: it comes straight out of the last card,
   every time, on every visit. Full screen is worth asking about here in a way
   it is not worth asking about on a document.

   WHY IT IS HERE AND NOT FLOATING OVER THE BOARD. A card on the settings page
   cannot cover content, cannot cover the dock, cannot be mistaken for a system
   dialog and needs no z-index, no scrim and no dismiss-on-outside-press. It
   sits above the list, at the top of the surface the reader opened precisely
   because they were looking for how this thing is set up, one tap from every
   screen. A floating prompt over the dashboard would be seen sooner and would
   have to fight the dock for the bottom of the screen and the board for the
   middle of it; that mount belongs to BentoOutlet, which is not this file's to
   change, and it can be added later by rendering this same component there.

   THE FOUR CONDITIONS ARE ALL IN lib/fullscreen, AND EVERY ONE OF THEM WAS
   MEASURED RATHER THAN ASSUMED. Touch pointer, not desktop. A document the
   browser will actually let go full screen, which is false in the parent app's
   WebView and absent on iOS. Not an installed web app, which has no browser
   chrome left to hide. And not already answered: entering counts as an answer
   and so does declining, the answer is kept on the device under
   `erp.fullscreen.invite`, and the card never returns.

   TWO WAYS OUT AND BOTH ARE ONE TAP. Declining is a real control with a real
   name, not a corner cross, because a person who does not want this should not
   have to aim. Both are 44px tall STATED IN PIXELS: `min-h-11` is 2.75rem,
   which on this 14px root is 38.5px and under the floor. */
function FullScreenOffer() {
  const { show, accept, dismiss } = useFullScreenInvite()
  if (!show) return null
  /* Two rows, not a card with a paragraph: the offer and the way to decline
     it, each a 44px target, each saying what it does in its own words. */
  return (
    <Rows className={cn('mb-[8px] border-b', SEAM)}>
      <NavRow
        label="Use the whole screen"
        helper="The browser keeps about an eighth of the screen for its bar."
        onClick={accept}
      />
      <NavRow label="Not now" onClick={dismiss} />
    </Rows>
  )
}
