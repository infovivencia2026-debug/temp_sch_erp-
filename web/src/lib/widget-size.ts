import { createContext, useContext } from 'react'

/* How much room a cell has, for the cells that should change SHAPE rather than
   just shed parts.

   The CSS shedding rules cover the general case: at one column the supporting
   sentence goes, at one row the meter goes. That is the right treatment for
   text and for a bar that is either there or not.

   It is the wrong treatment for a chart. A thirty-day trend line squeezed into
   a 1x1 is not a smaller chart, it is an unreadable one — the honest small
   version is a different drawing: no axis, no labels, fewer marks, the shape of
   the thing rather than its values. That is a decision only the cell can make,
   which means it needs the numbers, not a media query.

   Deliberately its own module with no components in it. A hook exported
   alongside components makes Vite refuse Fast Refresh and fall back to
   invalidating the module, which rebuilds the context object and quietly
   detaches every consumer from its provider — a failure that looks exactly
   like the feature being broken. */

export interface WidgetSize {
  /** Columns, 1 to 5. */
  w: number
  /** Rows, 1 to 5. */
  h: number
}

/** 2x1 is the shape most cells are written for, so it is what a cell rendered
    outside any widget sees. */
const FALLBACK: WidgetSize = { w: 2, h: 1 }

export const WidgetSizeContext = createContext<WidgetSize>(FALLBACK)

/** The room this cell has. Safe to call from a cell that is not in a widget. */
export function useWidgetSize(): WidgetSize {
  return useContext(WidgetSizeContext)
}

/** How much detail the room justifies.

    Three levels rather than a number, because a cell should not be making its
    own judgements about breakpoints — that is how thirty cells end up with
    thirty different opinions about what "small" means.

      abstract  the shape only: no labels, no axis, few marks
      normal    the drawing as designed
      rich      room to spare: labels, axis, the long form */
export type Detail = 'abstract' | 'normal' | 'rich'

export function detailFor({ w, h }: WidgetSize): Detail {
  const area = w * h
  if (w <= 1 || area <= 2) return 'abstract'
  if (area >= 8) return 'rich'
  return 'normal'
}

/** Convenience for the common case. */
export function useDetail(): Detail {
  return detailFor(useWidgetSize())
}
