import { useLayout } from '@/lib/layout'
import { useT } from '@/lib/i18n'

/* The way back out of a chrome-less layout.

   Bento hides the sidebar and the header, and the header is where the
   Classic/Bento switch lives — so without this control a person who turns
   Bento on has no way to turn it off, and no sign-out either. That is not an
   inconvenience, it is a trap: the preference persists to the account, so a
   reload returns them to the same chrome-less screen.

   Deliberately a small fixed pill rather than a bar. The instruction was no
   side or top bars, and a strip pinned to an edge is a bar whatever it is
   called. It sits bottom-right, out of the reading path of a grid that starts
   top-left, and it is reachable by keyboard like anything else. */
export function BentoEscape() {
  const { layout, setLayout } = useLayout()
  const t = useT()
  if (layout !== 'bento') return null
  return (
    <button
      type="button"
      onClick={() => setLayout('classic')}
      className="fixed bottom-4 right-4 z-50 rounded-full border bg-popover/90 px-3.5 py-2 text-[12.5px]
                 shadow-md backdrop-blur transition-colors hover:bg-accent
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {t('bento.escape.back')}
    </button>
  )
}
