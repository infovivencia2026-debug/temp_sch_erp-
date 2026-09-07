/* FOUR NAMED SIZES OVER THE STORED WIDTH AND HEIGHT.

   The board stores a width and a height per card and lets a person pick any
   of eight raw shapes (1x1 1x2 2x1 2x2 3x1 3x2 4x2 5x1). Eight is more than a
   person can hold in mind while arranging, and most of them differ by a
   column nobody would notice. iCloud's tiles are Small, Medium and Large; a
   phone home screen widget is the same three; this board is those plus Wide,
   because a five-column desktop board has a real use for a strip across it.

   NOTHING ABOUT STORAGE CHANGES. A placement still carries `w` and `h`, every
   layout ever saved still reads, and a card sitting at 4x2 stays 4x2 until
   somebody touches it. A tier is a NAME FOR what is stored, chosen by
   `tierOf`, which is a pure classifier: it is how the picker shows which
   size a card is at, and `dimsForTier` is what the picker writes when a
   different one is chosen. Between the two, the old shapes are reachable
   only through presets (`spotlight` still places a 3x2 hero, `banner` a 5x1
   band) and read back as the nearest tier — see the table on `tierOf`.

   Two boards, two tables. The desktop board is five columns by three rows;
   the phone board is two columns by two rows and draws every card at the
   full width (see `paginate` in widgets.ts), so a phone card can differ only
   in height. That leaves the phone two real sizes, and Medium and Wide are
   spelled out in its table anyway so that a tier chosen anywhere writes a
   legal shape everywhere. */

export type SizeTier = 'small' | 'medium' | 'large' | 'wide'

export const TIERS: readonly SizeTier[] = ['small', 'medium', 'large', 'wide'] as const

/** The desktop board: five columns, three rows. */
export const TIER_DIMS: Record<SizeTier, { w: number; h: number }> = {
  small: { w: 1, h: 1 },
  medium: { w: 2, h: 1 },
  large: { w: 2, h: 2 },
  wide: { w: 3, h: 1 },
}

/** The phone board: every card the full page width, one row or two.

    Small is the top half of a page and Large is a whole page. Medium and
    Wide are the same shape as Small — the phone has no width to give them —
    and `tierOf` reports either of them back as Small, so the picker on a
    phone shows two sizes and never claims a third.

    THE WIDTH HERE IS NEVER WRITTEN BY THE BOARD. `paginate` draws every
    phone card at the page width whatever is stored, and the store's
    `setTier` keeps a card's existing width when the phone picks a tier, so
    a 1x1 desk card made Small on the phone stays 1x1 and the desk still
    reads it as Small. The `w` column exists so that `dimsForTier` returns a
    whole shape for a card that has no width yet. */
export const PHONE_TIER_DIMS: Record<SizeTier, { w: number; h: number }> = {
  small: { w: 2, h: 1 },
  medium: { w: 2, h: 1 },
  large: { w: 2, h: 2 },
  wide: { w: 2, h: 1 },
}

/** The tiers a board actually offers, in picker order. A phone offers two. */
export const PHONE_TIERS: readonly SizeTier[] = ['small', 'large'] as const

/** The tier a stored width and height reads as.

    HEIGHT DECIDES FIRST, THEN WIDTH. Large is the only tier with a second
    row, so anything two or more rows tall is Large: a column that loses its
    second row loses the list it was holding, and a hero that loses it loses
    its chart, whereas either of them gaining or losing a column keeps what
    it shows. Among one-row shapes the width is the whole difference — one
    column is Small, two is Medium, three or more is Wide.

    That one rule is the same answer "nearest by area and aspect" gives for
    every shape the old picker offered, and it is a rule a person can predict:

        stored   desktop   phone     why
        1x1      small     small     exact
        1x2      large     large     the only tier with two rows
        2x1      medium    small     exact; a phone has no width to give
        2x2      large     large     exact
        3x1      wide      small     exact; a phone has no width to give
        3x2      large     large     the spotlight hero: keeps its two rows
        4x2      large     large     two rows, one column narrower
        5x1      wide      small     the banner band: one row, as wide as goes

    On a phone the width is not the card's to choose — `paginate` draws every
    card the full page width — so the only question is one row or two. */
export function tierOf(w: number, h: number, phone: boolean): SizeTier {
  const rows = Number.isFinite(h) ? h : 1
  const cols = Number.isFinite(w) ? w : 1
  if (rows >= 2) return 'large'
  if (phone) return 'small'
  if (cols >= 3) return 'wide'
  if (cols >= 2) return 'medium'
  return 'small'
}

/** The width and height to store for a tier on the given board. Always a
    shape `tierOf` reads back as the same tier — except Medium and Wide on a
    phone, which are Small by design, see PHONE_TIER_DIMS. */
export function dimsForTier(tier: SizeTier, phone: boolean): { w: number; h: number } {
  const d = (phone ? PHONE_TIER_DIMS : TIER_DIMS)[tier]
  return { w: d.w, h: d.h }
}

/** The locale key for a tier's name: `bento.size.small` and so on. Kept here
    so the picker, the sheet and the gallery cannot each spell it differently. */
export function tierLabelKey(tier: SizeTier): string {
  return `bento.size.${tier}`
}
