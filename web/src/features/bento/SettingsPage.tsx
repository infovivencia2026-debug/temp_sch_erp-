import { useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { usePhone } from '@/lib/viewport'
import { cn } from '@/lib/utils'
import { INK, EDGE, WASH, RING, SEAM } from './ColourDialog'
import {
  SettingsNav, SettingsPane, SettingsSectionList, useSettingsItems,
  type SettingsTab,
} from './AppearanceDialog'

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
  const phone = usePhone()
  const items = useSettingsItems()
  const { section } = useParams()

  /* An address naming a section that does not exist -- a stale bookmark, a
     grant that has since been taken off this account -- is not an error page.
     The catalogue gates these sections, so "gone" is a normal outcome, and the
     honest answer is the list of what IS here. On a wide viewport the list is
     not a page, so it falls to Appearance the way the dialog does. */
  const found = items.find((i) => i.id === section)
  const tab: SettingsTab | null = found
    ? (found.id as SettingsTab)
    : phone ? null : 'appearance'

  const open = useCallback((id: string) => {
    navigate(`/settings/${id}`, { replace: true })
  }, [navigate])

  const backToList = useCallback(() => {
    navigate('/settings', { replace: true })
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
    <div className="mx-auto w-full max-w-[980px] px-0 py-0 sm:px-6 sm:py-6">
      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-none border-x-0 border-t-0',
          'sm:rounded-[16px] sm:border-x sm:border-t border-b',
          'bg-[var(--bento-card,hsl(var(--card)))]',
          'text-[var(--bento-ink,hsl(var(--card-foreground)))]',
          EDGE,
        )}
      >
        <header className={cn('border-b px-5 py-4 sm:px-7 sm:py-5', SEAM)}>
          {/* WHERE YOU ARE, AND THE WAY BACK, IN THAT ORDER -- the same header
              shape the dialog uses inside a section, for the same reason: the
              name of the surface you are returning to belongs ON the control
              that returns you to it.

              44px is stated in pixels and not in rem on purpose. The root font
              here is 14px, so `min-h-11` -- 2.75rem -- computes to 38.5px and
              lands under the touch floor. That substitution has caused three
              separate bugs in this codebase; anything that has to clear a
              finger or a device edge is written in px. */}
          {phone && tab !== null && (
            <button
              type="button"
              onClick={backToList}
              className={cn(
                '-ml-2 mb-1 flex min-h-[44px] items-center gap-1 rounded-[8px] pl-1.5 pr-2.5',
                'text-[13px] transition-colors', INK, WASH, RING,
              )}
            >
              <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
              {t('bento.settings.label')}
            </button>
          )}
          <h1 className={cn('text-[21px] font-semibold', INK)}>
            {phone && found ? found.label : t('bento.settings.label')}
          </h1>
          <p className={cn('mt-0.5 text-[13px]', INK)}>
            {found
              ? found.note
              : 'Everything you can change from here, and where each change lands.'}
          </p>
        </header>

        {/* The wide strip, unchanged and shared with the dialog. It is
            `md:flex` inside SettingsNav, so on a phone it draws nothing and
            the list below is the only navigation -- two navigations for one
            set of pages is the thing this dialog already learnt not to do. */}
        <SettingsNav items={items} tab={tab} onPick={(id) => open(id)} />

        <div className="px-5 py-5 sm:px-7 sm:py-6">
          {tab === null
            ? <SettingsSectionList items={items} onOpen={open} />
            : <SettingsPane tab={tab} onClose={done} />}
        </div>
      </div>
    </div>
  )
}
