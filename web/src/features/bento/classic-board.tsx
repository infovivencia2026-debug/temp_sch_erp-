import type { ComponentType } from 'react'

/* A persona board, reachable from the classic layout.

   The four small workspaces built for the exam office, IT, operations and
   the driver have one Home each, and that Home is a `PersonaPage` board —
   written once, in the card language every other board uses. A board is
   normally reached through bento-registry.ts, which the shell consults only
   when the account has chosen the Bento layout; on the classic layout the
   router falls through to registry.ts and would find nothing.

   Rather than write a second Home per role, the classic entry renders the
   same board inside an element that carries the layout attribute. Every
   token the board reads — `--bento-ink`, `--bento-card`, the six domain
   grounds — is declared on `[data-layout='bento']` in bento-theme.css, and
   that selector matches an element, not only the root. So the board gets its
   palette either way, and there is one Home per role rather than two that
   drift. */
export function inClassic(Board: ComponentType): ComponentType {
  return function ClassicBoard() {
    return (
      <div data-layout="bento" className="min-h-full">
        <Board />
      </div>
    )
  }
}
