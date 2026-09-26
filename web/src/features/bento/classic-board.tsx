import type { ComponentType } from 'react'
import { ClassicSkinContext } from '@/lib/classic-skin'

/* A persona board, reachable from the sidebar (classic) layout.

   The four small workspaces built for the exam office, IT, operations and
   the driver, and the welfare roles, have one Home each, written as a
   `PersonaPage` board. A board is normally reached through
   bento-registry.ts, which the shell consults only on the Bento layout; on
   the classic layout the router falls through to registry.ts.

   The sidebar layout draws no bento. This wrapper therefore does NOT carry
   the bento layout attribute: it turns on the classic skin
   (lib/classic-skin.ts), under which the board's page, cards and widgets
   draw as ordinary classic screens. `.classic-skin` in index.css points the
   tokens the cells' drawings read (--bento-ink, --dom-*) at the classic
   theme, so a gauge or a bar inside a classic card is in the sidebar
   layout's palette, not the board's. */
export function inClassic(Board: ComponentType): ComponentType {
  return function ClassicBoard() {
    return (
      <ClassicSkinContext.Provider value={true}>
        <div className="classic-skin min-h-full">
          <Board />
        </div>
      </ClassicSkinContext.Provider>
    )
  }
}
