import { createContext, useContext } from 'react'

/* THE SIDEBAR LAYOUT DRAWS NO BENTO.

   Some roles have only one Home, written as a persona board: the four small
   workspaces (exam office, IT, operations, driver) and the welfare roles.
   On the sidebar layout those boards used to be served inside an element
   carrying the bento palette, so the sidebar layout showed bento cells. It
   no longer does: classic-board.tsx sets this flag instead, and the board's
   three building blocks -- PersonaPage, PersonaCard and Widget -- read it and
   draw the classic page head, classic cards and a plain grid, with no
   arranger. The figures and the queries are the same ones either way; only
   the drawing changes.

   Its own module with no components in it, for the same Fast Refresh reason
   as widget-size.ts. */
export const ClassicSkinContext = createContext(false)

export function useClassicSkin(): boolean {
  return useContext(ClassicSkinContext)
}
