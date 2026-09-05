import { Fragment, createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useWidgetSize } from '@/lib/widget-size'
/* The editorial card vocabulary — see docs/BENTO_CARD_PATTERNS.md.
   Twelve drawings, one card shell, and a single colour rule: every mark is
   `currentColor`. The cell has already resolved its own ink — black on a pale
   tint, white on a dark one — so a drawing that inherits is correct on all
   twelve domain grounds, both default themes and all four shipped palettes
   without a branch anywhere in here. Nothing in this file names a colour.
   Tracks, grounds and the quiet end of a ramp are that same ink at low alpha,
   which is why they stay legible when the ink flips.
   `big` from the reference is deliberately not built: it is the figure at a
   larger size, and the figure already has a row of its own. Every drawing here
   has to add something the number does not. */
/** Ink at a given strength. The only colour expression in this file. */
const ink = (pct: number) => `color-mix(in srgb, currentColor ${pct}%, transparent)`
/** A finite number, or the fallback. Guards every drawing against NaN and
    Infinity, which arrive whenever an API field is null and something does
    arithmetic on it. Unguarded, `Math.max(0, Math.min(100, Math.round(NaN)))`
    is NaN — a clamp does not clamp a non-number — and that reached the DOM as
    the literal string "NaN%". */
const num = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
/** Does this series carry any signal at all? An all-zero series is not a small
    series: `Math.max(...values) || 1` turns it into a denominator of 1, and the
    per-mark minimum heights then draw a visible mark for every zero — a month
    with no activity reading as a month of small activity. */
const hasSignal = (values: number[]) =>
  values.some((v) => Number.isFinite(v) && v !== 0)
/* Is this string safe to set as a tracked, uppercased micro-label?

   The label treatment -- monospace, uppercase, 0.22em of letter-spacing -- is
   what gives the card its engineered look, and it is a Latin-script idea.
   Telugu is caseless, so `text-transform: uppercase` does nothing at all, and
   letter-spacing is actively destructive: it pulls apart the conjunct clusters
   that Telugu builds its consonants from, turning readable words into loose
   glyphs. The monospace stacks in this product carry no Telugu coverage
   either, so the browser would fall back mid-string and the label would come
   out in two different faces.

   So the treatment is applied only where it is correct. Anything with a
   character outside Latin-1 keeps proportional type at a size chosen to match
   optically -- which is the same label, set properly for its script. */
const LATIN_ONLY = /^[ -ɏ‐-›]*$/
const isLatin = (s: string) => LATIN_ONLY.test(s)

/* THE MARK IS INK AT REDUCED WEIGHT, NOT A SLAB.

   At 88% every rail on a busy board was a near-black bar 18px thick on a
   grey track — measured on the busy fixture: "Billed", "Grade 6", "On roll",
   "Covered", four saturated slabs per screen, and thirty fat columns under
   the attendance figure. A single-series mark is the card's ink at reduced
   weight; 60% on the light card is 5.0:1 and on the dark card 6.1:1, well
   over the 3:1 a graphical mark needs, and plainly quieter than the figure.
   The track is a lighter step of the SAME ink — one hue, two weights — not a
   grey against a black. `QUIET` is the muted column beside the current one. */
const MARK = ink(60)
const TRACK = ink(12)
const QUIET = ink(30)
/** The one full-weight mark a drawing may carry: the current period, the
    column the reader is looking at. Everything else is `MARK` or quieter. */
const NOW = ink(92)
/** THE SENTENCE THE CARD HAS ALREADY SAID.

    Carries the card's change note down to whatever is drawn in the drawing
    row, so a zero state can tell that the words it was about to print are
    already on the card an inch above it. Null when there is no note, or when
    the note is not a plain string and so cannot be compared - a drawing that
    cannot be sure says its own sentence, which is the safe way round.

    Context rather than a prop because the drawing is passed in as `children`
    by twenty-odd call sites: a prop would have to be threaded through every
    one of them, and the ones that forgot would be exactly the ones that
    duplicate. */
const CardNote = createContext<string | null>(null)

/** Is this sentence already printed as the card's change note?

    Kept because it states the rule, but note what it could and could not see.
    It compares two strings for equality, and equality is a much narrower test
    than the one the card actually needs. On the empty board the Collected card
    printed "Receipts banked in this period, whatever year's bill they settle"
    as its note and "No fee has been invoiced or collected yet" as its zero
    sentence: two different strings, so nothing here fired, and the reader got
    two lines that say the same thing in different words. Students did the same
    with "0 sections, 0 staff" over "No student is on the roll yet". A string
    comparison cannot catch a paraphrase, and no amount of tightening it will.

    So the duplication is settled structurally instead, by ONE_SENTENCE below:
    a card at zero has one sentence, and it is the one written for the zero
    case. This stays for the exact-match case and for callers outside the
    shell. */
export function useNoteAlreadySaid(text: ReactNode) {
  const note = useContext(CardNote)
  return typeof text === 'string' && note !== null && note === text
}

/* ── ONE SENTENCE, AND IT IS THE ONE WRITTEN FOR THE ZERO CASE ──────────

   The card shell writes its change note before it renders the drawing, and
   the drawing is passed in as opaque `children`, so the shell has no way of
   knowing that the thing below it is about to say the same sentence in other
   words. That is why the equality test above never fired on the cards that
   duplicated worst.

   The drawing therefore reports upward. `Nil` -- the only drawing that stands
   for "there is nothing here" -- announces itself and hands up the sentence it
   would have printed, and the shell prints that sentence INSTEAD of its own
   note and drops the drawing row entirely.

   Which sentence survives is a judgement, and it is the zero sentence every
   time. "No student is on the roll yet" tells a reader on their first morning
   what state the school is in; "0 sections, 0 staff" restates a zero they have
   already read in 51px type an inch above. The note is written for a school
   with data in it and the zero sentence is written for a school without, and
   the empty board is the one being read here.

   Rejected: doing this at the call sites. There are twenty-odd of them across
   five boards, the ones that would be missed are exactly the ones that already
   duplicate, and the next card somebody adds would duplicate again. A rule the
   shell enforces cannot be forgotten.

   Rejected: comparing the two sentences more cleverly -- shared prefixes,
   normalised words, a similarity score. Every version of that is a guess about
   English that gets a card wrong in a language nobody on the team reads, and
   this product ships in Telugu. */
/** `false` withdraws the report -- the drawing has data again, or unmounted.
    A string or `null` is a live report: quiet, with or without a sentence. */
type ZeroReport = (said: string | null | false) => void
const CardZero = createContext<ZeroReport | null>(null)

/** Tell the enclosing card that this drawing has nothing to draw, and what it
    would have said. Reports on mount and whenever the sentence changes; the
    shell holds it in state, so the card re-renders once into its quiet form. */
function useReportNothing(text: ReactNode) {
  const report = useContext(CardZero)
  const said = typeof text === 'string' ? text : null
  useEffect(() => {
    if (!report) return
    report(said)
    return () => report(false)
  }, [report, said])
}

/* ── the shell ─────────────────────────────────────────────────────────── */
/** The three-row card: header, figure, drawing.
    The drawing row is `minmax(0,1fr)` so it takes whatever is left rather than
    a fixed height — that is what stops a large cell being a small cell with
    dead space under it. `min-h-0` on the row is load-bearing: without it a
    grid child refuses to shrink below its content and the drawing pushes the
    card out of shape. */
export function CardShell({
  title, sub, action, value, change, delta, deltaNote, children, className,
}: {
  title: string
  sub?: string
  /** Accepted and ignored: the decorative corner glyph is no longer drawn.
      Kept so the twenty-odd call sites do not all have to change at once. */
  glyph?: ReactNode
  /** The thing this card opens. Sits at the foot of the card, on the left. */
  action?: { label: string; onActivate?: () => void }
  value: ReactNode
  change?: ReactNode
  /* THE MOVEMENT, BESIDE THE FIGURE RATHER THAN UNDER IT.

     Every card said its change in a sentence below the number: "100% of
     Rs 8,667 billed", "0% of 91 on roll". That reads, and it makes the card a
     paragraph with a heading. A board of eighteen of them is eighteen
     paragraphs, and a board is read by scanning, where the two things scanned
     for are the figure and whether it moved.

     So a delta is a short signed value on the figure's own line, hard right,
     with a caption under it naming what the comparison is against. Both
     optional: a card with nothing to compare keeps its sentence, which is the
     honest thing to show when there is no previous period. */
  delta?: string
  deltaNote?: string
  children?: ReactNode
  className?: string
}) {
  /* THE TRACKS ARE COUNTED, NOT ASSUMED.

     The template was written as three tracks - header, figure, drawing - while
     the shell has always rendered four things into it: the header, the figure
     row, the change sentence and the drawing. The fourth child therefore fell
     into an IMPLICIT track, which is sized `auto`, and `auto` after an `1fr`
     gets nothing left to size against. Measured on a 390px phone, the
     "Attendance today" cell resolved to `42.64px 19.61px 26px 15px`: the
     sentence took the drawing's floor and the chart got fifteen pixels. Every
     sparkline, bar row and empty measure on the phone board was a sliver, and
     it was not a chart bug - the charts were drawing correctly into a track
     that was never meant for them.

     So the tracks are built from what is actually rendered. The sentence and
     the drawing are each conditional, so the template is too, and the four
     combinations of (sentence present/absent) x (drawing present/absent) each
     get exactly as many tracks as there are children. That is also why the
     old bare `<span />` placeholder is gone: it kept the COUNT stable at the
     cost of a real track and a real 6px gap for a row with nothing in it, and
     a template that matches the children needs no placeholder to stay
     deterministic.

     The drawing keeps the only fraction and the only floor, so it is still the
     row that takes whatever height is left and still the row that gives way
     first. Where there is no drawing at all there is no fraction, and the card
     sits to its natural height rather than reserving 26px for nothing. */
  /* WHAT THE DRAWING REPORTED. `false` while no drawing has said anything,
     which is every card with real data on it: those take the branch they
     always took and nothing below this changes for them. */
  const [zero, setZero] = useState<string | null | false>(false)
  const quiet = zero !== false
  /* The sentence the card prints. The zero sentence wins where there is one --
     see ONE SENTENCE above -- and where the drawing reported nothing to say,
     the card's own note carries on. */
  const said = quiet && zero !== null ? zero : change
  const note = said && !delta
  /* THE SENTENCE IS NOT ALLOWED TO SHRINK, AND THE DRAWING NO LONGER HAS A
     FLOOR IT CANNOT GIVE UP.

     Measured on a live phone board: the cell is 119px, and header 43 plus
     figure 20 plus sentence 19 plus a 26px drawing floor plus three 6px gaps
     comes to 126. Seven pixels short. An `auto` track is allowed to shrink
     below its content when the grid is over-constrained, and the sentence is
     what shrank: 15px of box around 19px of text, so every card's last line
     was cut through the middle of its own letters.

     `min-content` refuses that. The drawing takes `minmax(0,1fr)` instead of a
     26px minimum, so it is the row that gives way, which is what the note
     above this one has always said should happen and what the floor quietly
     prevented. A chart squeezed to nothing on a very short cell is a chart
     nobody was reading at 26px either; a sentence cut in half is a card that
     looks broken. Above phone height the fraction is generous and both fit,
     so this changes nothing where nothing was wrong. */
  /* A QUIET CARD HAS NO DRAWING ROW AT ALL.

     `Nil` used to fill this row with a rule of grey slots standing for a
     measure at nought. Screenshotted on an empty school it does not read as a
     measure at nought: it reads as a chart that failed to render, or as a
     placeholder somebody forgot to replace, and it was the single loudest
     unfinished-looking thing on the board. The idea behind it was sound -- the
     reader learns the shape the card takes when there IS something -- but a
     row of empty compartments teaches nobody that, and it costs the card its
     credibility on the one morning the reader has no other evidence.

     So a card with nothing to show shows nothing, and says one sentence about
     what will appear here. No drawing row, no fraction, and therefore no
     stretched-open gap where a chart is implied and never arrives.

     The drawing stays MOUNTED, hidden, rather than being dropped: it is what
     reports, and unmounting it would withdraw the report and bring it back on
     the next render forever. A `display: none` grid item is not a grid item at
     all, so it takes no track and generates no gap, which is why the track
     list can leave the fraction out without a child falling into an implicit
     row -- the failure this template already has a long comment about. */
  const t = useT()
  /* THE EMPTY ROW IS DRAWN, NOT DROPPED.

     A card whose drawing reported nothing used to lose its drawing row and
     sit at its natural height. On a phone that is fine; on a board of fixed
     cells it is a title, a figure and a sentence over two thirds of a card
     of air, and a board with three such cards was called empty and unfinished
     by the person paying for it. The earlier answer, a rule of grey slots
     standing for a measure, was rejected for reading as a chart that failed;
     the sentence-only card was the reaction, and it over-corrected.

     So the row stays, and holds an empty-state plate: a dashed frame with
     one small line saying nothing has been charted yet. It is plainly not a
     chart and plainly not a failure; it is the shape a designed empty state
     takes in every app the reader already uses. It takes the fraction the
     drawing would have, so the card fills its cell, and it is hidden by the
     theme on a board where EVERY card is quiet, which keeps the compact form
     a brand-new school sees. */
  const plate = quiet
  const rows = [
    'auto',
    'auto',
    ...(note ? ['min-content'] : []),
    ...(children && !quiet ? ['minmax(0,1fr)'] : []),
    ...(plate ? ['minmax(0,1fr)'] : []),
  ].join(' ')
  return (
    /* FOUR rows: header, figure, drawing, action.
       The action was in the top-right corner. It is at the foot of the card
       now, on the left, and it has a row of its own rather than sitting over
       the drawing — text and buttons never overlap the stats, and a button
       floating on top of a chart is exactly that.
       The drawing row is still the only fraction, so it keeps taking whatever
       height is left; the action row is `auto` and costs only what it needs. */
    <div
      className={cn(
        /* The drawing row has a FLOOR now. Adding the action row left it 28px on a
           one-row cell — measured — and a two-line breakdown needs 31, so every
           mini-chart on the board was sliced by `overflow: hidden` into the
           half-rendered ghosts that look worse than no chart at all. The floor
           is container-relative so it grows with the cell, and it is well under
           what a 1x1 can spare: 33 + 57 + 46 + 26 = 162 of 185. */
        /* The drawing yields, not the button. A control has to be readable at
           every size, and the figure has to be legible — so on a short cell the
           chart is what shrinks. Its floor is 30px: enough for two compressed
           rows, and below that a drawing is a ghost anyway and says less than
           the sentence it displaced. */
        /* CLIPPED, and with a real gap between the rows.

           The rows were separated by margins on the children — mt-1.5 here,
           mt-1 there — which a grid track does not count when it decides how
           tall it needs to be. So a card whose figure, two-line sentence and
           drawing floor together exceeded the cell simply overflowed, and the
           spill painted straight over the action button underneath: the number
           touching the sentence, the sentence touching the drawing, the drawing
           touching the button.

           `gap-y` is part of the track sizing, so the grid now accounts for its
           own separation, and `overflow-hidden` means anything that still does
           not fit is cut off cleanly at the card's edge rather than landing on
           top of a control. The drawing row is the only fraction and is the
           one that gives way, which is the rule this shell has always stated
           and could not previously keep. */
        /* The action no longer holds a band of its own — see below — so the
           drawing gets that height back. `relative` is what the corner mark is
           positioned against. The track list itself is built above, from the
           rows this card actually renders, because a hard-coded count and a
           conditional child list is what put the chart in a 15px implicit row
           in the first place. */
        'group/cell relative grid h-full min-h-0 gap-y-1.5 overflow-hidden',
        /* NO VERTICAL CENTRING, AND THIS WAS TRIED AND SCREENSHOTTED.

           The reasoning was that a three-line card in a tall cell leaves one
           large rectangle of nothing beneath it, and that centring turns that
           hole into margin above and below a composed block. On the board it
           does the opposite. Most cells on a collapsed board are exactly as
           tall as their contents, so centring moves nothing at all; the only
           cards it moves are the two-row spans, and it moves their titles into
           the middle of the cell while every neighbouring title sits on the
           top line. One card's name floating half way down the tile is a worse
           fault than the slack it was spent to hide, because a board is read
           along its top edges.

           The slack is dealt with where it comes from instead -- the board
           collapses its rows when every card is quiet, see bento-theme.css --
           and the card keeps one alignment at every height.

           `content-start` is what enforces that, and it is not the same as
           doing nothing. A grid whose tracks are all `auto` defaults to
           `align-content: stretch`, and the auto tracks then absorb the free
           space -- so on the one card that spans two rows the header row grew
           and the figure and its sentence were pushed to the FOOT of the tile,
           measured at 390px down a 281px cell. Top-aligned, every card on the
           board starts on the same line. */
        quiet && 'content-start',
        className,
      )}
      /* Read by the board: a sheet on which every card is quiet is an empty
         board, and it collapses rather than filling the screen with empty
         rectangles. See bento-theme.css. */
      data-card=""
      data-quiet={quiet ? '' : undefined}
      style={{ gridTemplateRows: rows }}
    >
      {/* THE RESERVE MUST EXCEED THE MARK, not equal it after subtracting the
          padding.

          The action is absolutely positioned at the card's top right and is
          outside this grid entirely, so nothing here would otherwise stop a
          long title running underneath it. The reserve is the button's 32px
          less the card's own padding. */}
      <div className={cn(
        'flex min-w-0 items-start justify-between gap-2',
        'pr-11',
      )}>
        <div className="min-w-0">
          {/* NOT BOLD. Only the figure is.

              A card holds one number and everything else on it is there to say
              what that number is. When the title is bold too, the eye has two
              things to land on and picks the one at the top — so a board of
              twelve cards reads as twelve headings with numbers under them,
              rather than as twelve numbers with names on them.

              Regular, not medium. It was medium while the type scale was
              tight and the title needed weight to separate from the eyebrow
              beneath it. With the figure at 96 and the title at 18 the size
              does that work, and the weight is free to come down with
              everything else that is not the number. */}
          {/* TWO LINES ON A PHONE, NOT AN ELLIPSIS.

              A half-width phone cell is 182px and the title is the widest
              thing on it, so "Pending approvals" arrived as "Pending approv…"
              -- the card lost its name to save 20px of a 151px-tall card that
              had vertical room to spare. Truncation is right where the space
              is horizontal and scarce; here it is vertical and plentiful.

              Kept to two lines. A three-line title on a four-row phone page
              pushes the figure off the bottom of the cell, which trades a
              readable name for an unreadable number. */}
          <p className="line-clamp-2 font-normal leading-tight text-[length:var(--card-title,13px)]">
            {title}
          </p>
          {/* THE MICRO-LABEL. Monospace, uppercase, widely tracked and dim --
              the quiet voice that the figure below is loud against. The whole
              card reads as measured because these two are set as far apart as
              they can be: 0.22em of tracking here, negative tracking there.
              Set at 0.92em of the supporting size, because a tracked
              uppercase run occupies noticeably more width than the same
              string set proportionally and would otherwise truncate first. */}
          {sub && (
            <p
              className={cn(
                /* ONE font-size declaration, not two.

                   This carried `text-[length:var(--card-sub)]` AND
                   `[font-size:0.92em]`. Both set font-size, the arbitrary
                   property came later in the class list, and it won — so the
                   eyebrow ignored the card's own scale entirely and resolved
                   0.92em against its PARENT instead. Measured on the live
                   board: 12.88px on a 622x513 cell, 12.88px on a 308x253 cell
                   and 12.88px on a 182x175 phone card, where the title beside
                   it is 11. The one line on the card that is meant to be the
                   quietest was the largest, at every size, on every board.

                   The 0.92 is inside the token now. A tracked uppercase run
                   still occupies more width than the same string set
                   proportionally, so it still wants to be a shade smaller than
                   the supporting size — that was never the wrong idea, only
                   the wrong way to express it.

                   TRACKING IS 0.04em, down from 0.22 and then 0.1. The wide
                   setting was borrowed from a reference whose labels are set
                   at 10px on a 210px-tall card; these run from 6.4px on a
                   phone, and at that size a tenth of an em is a visible gap
                   between every pair of letters — the word comes apart. Just
                   enough to keep the capitals from touching, and no more. */
                /* OPACITY 0.60, NOT 0.55, AND IT IS A CONTRAST FIX.

                   Measured on the default palettes: the eyebrow is the card's
                   ink at 55%, which on the light theme is #545456-ish on white
                   -- 4.36:1, under the 4.5 floor, at around eleven pixels. It
                   is a short uppercase run and not a paragraph, but "NOW" and
                   "LAST 30 DAYS" are the only thing on the card that says what
                   period the figure covers, and a figure whose period cannot
                   be read is a figure that cannot be trusted. 0.60 measures
                   5.18:1 light and 7.19:1 dark and is still plainly the
                   quietest line on the card, which is all the treatment was
                   ever asking for. */
                /* SENTENCE CASE. This micro-label was set uppercase, mono and
                   tracked — the "quiet voice" the card leaned on to look
                   measured. Uppercase tracking is not quiet; it is the second
                   styled thing on a card whose only job is to carry one figure.
                   Plain small muted text says the same period ("Now", "Last 30
                   days") without a typographic costume, and the figure is then
                   the only thing on the card wearing one. The 0.92 shrink was a
                   compensation for the width uppercase tracking adds, so it goes
                   with them. */
                'mt-1 truncate opacity-60 font-normal leading-tight text-[length:var(--card-sub,10px)]',
              )}
            >
              {sub}
            </p>
          )}
        </div>
        {/* The corner glyph is gone. It was one character — %, Rs, #, !, +, / —
            that named the card's domain, which the title already does, and it
            linked nowhere. `/` and `+` meant nothing at all. The prop stays in
            the signature so no caller breaks; it simply is not drawn. */}
      </div>
      <div className="flex min-w-0 items-end justify-between gap-2">
        {/* A placeholder is not a figure. When there is no number the cell
            passes an em dash, and at the figure's own size that renders as a
            wide white bar — which reads as a broken chart rather than as "no
            data". It is set down to the supporting size and muted, so the
            sentence beneath it becomes the thing you read. */}
        <p
          className={cn(
            /* THE FIGURE, WITH WEIGHT.

               It was thinned to 350 on the argument that a light number reads
               as a measurement rather than as a heading. That argument holds
               in print at 60px; it does not hold here. This figure clamps down
               to 26px on a one-by-one cell, and at that size a light weight on
               a coloured ground loses its stems -- the number stops being the
               loudest thing on the card, which is the one job it has.

               650 rather than the old semibold 600: the negative tracking
               stays, and pulling the letters together while the strokes are
               heavy is what gives a figure density instead of just size.
               Inter is variable here, so 650 is a real weight, not synthesised
               from two. */
            /* `card-fig`: the hook the lead/supporting weight rules in bento-theme.css key on. */
            'card-fig truncate pb-[0.06em] tracking-[-0.035em] tabular-nums [font-weight:650]',
            /* A QUIET CARD DOES NOT SHOUT ITS ZERO.

               An empty school renders "0" and "₹0", and at the figure's own
               40px each one is a headline announcing nothing — the loudest
               thing on a home that has no news. `quiet` is already set on
               exactly these cards (the drawing reported it has nothing to
               draw), so a zero is dropped to the supporting size and muted, the
               same treatment the em-dash placeholder gets. The number is still
               there and still legible for anyone who wants it; it simply stops
               being the thing the eye lands on when there is nothing to report.
               A card with real news keeps its big figure untouched.

               NO OPACITY, AND IT IS A CONTRAST FIX. Measured on the live
               board: the em-dash at 0.45 was 3.14:1 on light, and a zero given
               the same fade took the rupee unit inside it — which stacks its own
               0.7 — to 2.12:1; at 0.70 the unit still only reached 3.57:1. Quiet
               is done by SIZE here: at 13px the figure is a supporting line, and
               the unit's own 0.7 is the only fade, which measures 4.53:1 or
               better on both themes on the real board. */
            /* 22px, NOT 13. At 13 the zero read as a footnote and the card as
               vacant — three short lines and 70% blank. 22 is a supporting
               figure: below the 26-50px headline scale, clearly above the
               sentence, and the card reads as calm rather than as empty. */
            value === '—' || quiet
              ? 'leading-tight text-[length:min(22px,var(--card-fig,30px))]'
              : 'leading-[0.95] text-[length:var(--card-fig,30px)]',
          )}
        >
          {typeof value === 'string' ? <Figure text={value} /> : value}
        </p>

        {/* Signed, and never both. A card that carries a delta does not also
            need the sentence repeating it. */}
        {delta && (
          <p className="shrink-0 text-right leading-tight">
            <span className="block tabular-nums [font-weight:650]
                             text-[length:var(--card-change,11px)]">
              {delta}
            </span>
            {deltaNote && (
              <span className="mt-0.5 block whitespace-nowrap font-normal
                               leading-tight opacity-60
                               text-[length:calc(var(--card-sub,10px)*var(--card-sub-mult,0.9))]">
                {deltaNote}
              </span>
            )}
          </p>
        )}
      </div>
      {/* Two lines, not an ellipsis. This is the sentence that carries the
          reading — "12% of billed, owed by 30 students" — and truncating it
          cut the half that says who.

          THIN. A description set at the same weight as the thing it describes
          stops being subordinate to it. 300 against the figure's 650 is the
          widest gap this typeface offers, and it is what leaves the number the
          only bold thing on the card. */}
      {note && (
        /* ON A QUIET CARD THE SENTENCE CARRIES THE WEIGHT. "No register marked
           today" is the card's actual content when there is no number worth
           a headline, so it is set at 13px regular instead of 11px light —
           the reading, not a caption under nothing. */
        <p className={cn(
          'card-note line-clamp-2 leading-tight opacity-70',
          quiet
            ? 'font-normal text-[length:max(13px,var(--card-change,11px))]'
            : 'font-light text-[length:var(--card-change,11px)]',
        )}>
          {said}
        </p>
      )}
      {children && (
        /* The sentence this row must not repeat.

           A zero state is drawn by `Say`, which puts the card's own sentence
           above an empty measure - and the cards that have a zero state
           overwhelmingly pass that same sentence as `change` as well, because
           both slots are asking the same question. The result was a card that
           said "No register marked today" twice, once in each row, with the
           second copy pushing the measure it was meant to introduce out of
           sight. Handing the note down means the drawing can see that it has
           already been said and draw the measure alone. */
        <CardNote.Provider value={note && typeof said === 'string' ? said : null}>
          <CardZero.Provider value={setZero}>
            {/* `card-drawing`: on the phone pager this row measures itself
                and sheds its contents — a list row at a time, then the whole
                drawing — before any of it is cut through the middle of a
                glyph. See DRAWINGS GIVE WAY WHOLE in bento-theme.css. */}
            <div className={cn('card-drawing min-h-0 min-w-0 overflow-hidden', quiet && 'hidden')}>
              {children}
            </div>
          </CardZero.Provider>
        </CardNote.Provider>
      )}
      {plate && (
        /* See THE EMPTY ROW IS DRAWN, NOT DROPPED above. aria-hidden: the
           sentence has already said it; this is the shape, not a second
           statement. */
        <div
          aria-hidden="true"
          className="card-nothing flex min-h-0 min-w-0 items-center justify-center self-stretch overflow-hidden rounded-[10px] border border-dashed border-current/25"
        >
          <span className="px-2 text-center text-[10px] font-medium uppercase tracking-[0.08em] opacity-45">
            {t('bento.common.nothing_yet')}
          </span>
        </div>
      )}
      {action && (
        /* THE SAME CORNER SQUARE THE CUE USES.

           This was a full-width chip along the bottom edge — the second of the
           two bottom-left buttons on this board, and the one that survived
           when the cue moved, because it is rendered here rather than by
           `Cue`. Two different components drawing the same affordance two
           different ways is how that happened, and it is why half the cards
           changed and half did not.

           Its callers wrap the WHOLE card in a link, so this was never
           interactive: a span with a border, costing a card's fourth row to
           say "this opens". As a corner mark it says the same thing, costs
           nothing, and matches the cue exactly — one affordance, one shape,
           wherever it comes from.

           `aria-hidden`, because the enclosing link already carries the label.
           A second announcement of the same name is noise to a screen reader,
           not help. */
        <CornerMark />
      )}
    </div>
  )
}

/** THE CORNER MARK — one definition, every board.

    There were three of these and they did not match. `Cue` in bento-kit drew a
    lucide arrow inside a Link; `CardShell` drew a text "↗" inside a span, which
    is a different glyph at a different weight in whatever font the card
    inherits; and the four persona boards drew nothing at all, because the whole
    card is the link there and nobody added a visible affordance. So a person
    moving between the principal's board and the student's saw a button, a
    slightly different button, and no button — for the same act of opening
    something.

    That is what "the buttons are not consistent" means, and it cannot be fixed
    by editing three places to agree: they would drift again on the next change.
    One component, three callers, no way to disagree.

    `as` decides the element, because the callers genuinely differ. Where the
    cell itself is the link the mark must NOT be another link — a link inside a
    link is invalid HTML and the browser closes the outer one early, which
    silently breaks the card. There it is a span, aria-hidden, because the
    enclosing link already carries the name. */

/* THE UNIT IS NOT PART OF THE NUMBER.

   "4.92%" set at the figure size gives the percent sign the same weight and
   the same 38 pixels as the digits, and on a small cell the sign is a third of
   the width of the thing you are trying to read. The same goes for "184 ms",
   "248K" and a leading rupee mark.

   So the trailing unit, and a leading currency mark, are drawn smaller and
   lighter and tucked against the digits. The number keeps the card, and the
   unit stays legible without competing for it.

   Split with a regex rather than by asking every call site to pass two fields:
   there are twenty-odd cards and the shapes they already produce are regular
   enough to read. Anything the pattern does not recognise is drawn exactly as
   it arrives, which is the safe direction to fail in.
*/
const FIGURE = /^(\p{Sc}?)\s*([\d.,+\-]+)\s*([%\p{L}]{0,3})$/u

function Figure({ text }: { text: string }) {
  const m = FIGURE.exec(text.trim())
  if (!m || (!m[1] && !m[3])) return <>{text}</>
  const [, mark, digits, unit] = m
  /* THE CURRENCY MARK WAS BEING READ AS A SUBSCRIPT, and it was the first
     thing the eye landed on on half the board.

     It was set at max(0.42em, 10px) and aligned to the baseline. Baseline is
     the typographically correct alignment for a unit sitting beside a number
     and it is the wrong LOOK here, because of how far apart the two sizes had
     got: a 21px rupee against a 51px zero, sharing a baseline, puts the whole
     glyph inside the bottom two fifths of the numeral's height, and a small
     mark tucked into the bottom of a big one is the exact shape of a
     subscript. Measured on the live board, the mark's cap reached 15px of the
     numeral's 37px cap. It looked like a footnote attached to the zero.

     Two changes, and they only work together.

     SIZE. Up to max(0.58em, 12px). Look at how a large figure is actually set
     with a currency mark on it: Apple's pricing, Stripe's dashboard and
     Monzo's balance all run the mark at somewhere between half and two thirds
     of the numeral, never at two fifths. Below about half the mark stops
     reading as part of the same word and starts reading as an annotation on
     it. The 12px floor is the product's own minimum legible size and it binds
     on the phone board, where the figure is 34px.

     ALIGNMENT. Cap-aligned, not baseline-aligned. The mark is lifted so its
     top sits level with the top of the digits, which is what all three of
     those references do and what makes the mark read as the first character
     of the amount rather than as something hanging off it. The lift is
     0.42em OF THE MARK'S OWN em -- vertical-align resolves against the
     element's own font-size -- which at 0.58em of the figure is 0.24em of the
     figure, and 0.24 plus the mark's own 0.42em cap lands within a hair of the
     digits' 0.72em cap at every size in the clamp. Expressed in em rather
     than pixels so it holds from the 34px phone figure to the 96px ceiling
     without a breakpoint.

     THE TRAILING UNIT KEEPS ITS BASELINE. "%" and "ms" follow the number and
     are read after it, and a trailing mark lifted to the cap line reads as an
     exponent -- "4.92%" would look like four point nine two to the percent.
     Its only change is the size floor, from 10px to 11px, which is the
     smallest type this product allows anywhere. */
  const small = '[font-weight:500] opacity-70'
  return (
    <>
      {mark && (
        <span
          className={cn(small, 'mr-[0.08em] text-[length:max(0.58em,12px)]')}
          style={{ verticalAlign: '0.42em' }}
        >
          {mark}
        </span>
      )}
      {digits}
      {unit && (
        <span className={cn(small, 'ml-[0.08em] align-baseline text-[length:max(0.5em,11px)]')}>
          {unit}
        </span>
      )}
    </>
  )
}

export function CornerControl({
  as: Tag = 'button',
  insetLeft = false,
  className,
  children,
  ...props
}: {
  as?: any
  insetLeft?: boolean
  className?: string
  children: ReactNode
  type?: 'button' | 'submit' | 'reset'
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      {...props}
      className={cn(
        'bento-cue absolute top-0 z-10 grid size-10 place-items-center',
        insetLeft ? 'right-10' : 'right-0',
        className,
      )}
    >
      {children}
    </Tag>
  )
}

/** THE CORNER MARK — one definition, every board.
    ...
*/
export function CornerMark({
  label,
  as = 'span',
}: {
  label?: string
  as?: 'span' | 'div'
}) {
  return (
    <CornerControl
      as={as}
      aria-hidden={label ? undefined : 'true'}
      aria-label={label}
      title={label}
    >
      <ArrowUpRight className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
    </CornerControl>
  )
}

/* ── drawings ──────────────────────────────────────────────────────────── */
/* SQUARE CORNERS THROUGHOUT, and it is not a style preference.

   Every measure in here is a length the reader compares against another
   length. A 3px radius on a track 5 to 10 pixels tall rounds a meaningful
   fraction of that length into a curve, and the eye reads the curve as part of
   the bar -- so two values that differ by a few percent draw as though they
   differ by more, and the shortest bar in any set rounds into a dot that says
   nothing about its own size. Rectangles are comparable; lozenges are not.

   The strokes are hairlines -- 1.4 and non-scaling -- for the matching reason.
   A 2.5 stroke that scales with the cell is a rope on a 2x2 board and covers
   the very wiggles it is drawn to show. */
function svgPath(points: number[], h = 150, w = 400) {
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const range = hi - lo || 1
  return points
    .map((v, i) => {
      const x = (i * w) / (points.length - 1 || 1)
      const y = h - 5 - ((v - lo) / range) * (h - 20)
      return `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}
/** The last point's coordinates, for the terminal dot.

    Mirrors svgPath's arithmetic exactly rather than re-deriving it, because two
    expressions that are meant to agree about where a line ends will not stay
    in agreement through the next edit to either. */
function lastPoint(points: number[], h = 150, w = 400) {
  const lo = Math.min(...points)
  const hi = Math.max(...points)
  const range = hi - lo || 1
  const v = points[points.length - 1]
  return { x: w, y: h - 5 - ((v - lo) / range) * (h - 20) }
}
/** Trend. An open path, nothing under it.

    THREE CHANGES that together make this read as an instrument rather than a
    sketch. The stroke is 1.4 rather than 2.5, and non-scaling, so it is a
    drawn hairline at every cell size instead of a rope that thickens as the
    card grows. A baseline sits under it, because a line with nothing beneath
    it floats and the eye has no datum to read height against. And the final
    point carries a filled dot: the value everybody actually wants off a trend
    is the latest one, and until now it was the end of a stroke like any
    other.

    The baseline is drawn at the foot of the viewBox rather than at zero. This
    series is scaled to its own min and max -- svgPath does that deliberately,
    so a flat-ish series still shows its shape -- which means zero is usually
    off the bottom of the picture. A rule labelled as an axis where zero is not
    would be a lie; this one is a floor, and reads as one. */
export function Line({ points, srLabel }: { points: number[]; srLabel: string }) {
  if (points.length < 2 || !hasSignal(points)) return null
  const end = lastPoint(points)
  return (
    <svg viewBox="0 0 400 150" preserveAspectRatio="none" className="h-full w-full"
         role="img" aria-label={srLabel}>
      <line x1="0" y1="149" x2="400" y2="149" stroke={ink(22)} strokeWidth={1}
            vectorEffect="non-scaling-stroke" />
      <path d={svgPath(points)} fill="none" stroke={MARK} strokeWidth={3.4}
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {/* preserveAspectRatio="none" stretches the viewBox, so a circle would
          come out an ellipse -- wide on a 2x1, tall on a 1x2. The dot is drawn
          as a rect sized in the stretched space it lands in, which is the only
          way to get a square mark out of a non-uniform scale without a second
          SVG. */}
      <rect x={end.x - 8} y={end.y - 3} width={8} height={6} fill={MARK} />
    </svg>
  )
}
/** Magnitude and trend: the same line with the ground filled beneath it. */
export function Area({ points, srLabel }: { points: number[]; srLabel: string }) {
  /* The gradient id must be UNIQUE PER INSTANCE, and getting this wrong is
     subtle enough to be worth the paragraph.

     A fixed id looked like sharing one definition between every Area on the
     board. It is not sharing: each instance emits its own <defs> with the same
     literal id into one document, and `url(#id)` resolves by getElementById --
     the FIRST match in document order. So every Area on the board was filled
     from the first Area's gradient. That would be invisible if the stops were
     a fixed colour, but they are `currentColor`, which in SVG resolves against
     the <stop>'s own inherited colour rather than against the path referencing
     it. Cards on this board have different ink -- black on a pale domain tint,
     white on a dark one -- so the second Area on a differently-inked card was
     washed in the first card's ink, and on an inverted cell that is a pale
     smear on a dark ground.

     useId is React's answer for exactly this: stable across the server and
     client renders of the same element, unique per instance. */
  const gradientID = `bento-area-${useId().replace(/:/g, '')}`
  if (points.length < 2 || !hasSignal(points)) return null
  const d = svgPath(points)
  return (
    <svg viewBox="0 0 400 150" preserveAspectRatio="none" className="h-full w-full"
         role="img" aria-label={srLabel}>
      {/* A flat wash under a line says "there is area here" and nothing more.
          A gradient that fades to nothing at the floor says where the mass
          is, and it is what stops the fill competing with the stroke for
          attention -- the stroke is the reading, the fill is its weight. */}
      <defs>
        <linearGradient id={gradientID} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" y1="149" x2="400" y2="149" stroke={ink(22)} strokeWidth={1}
            vectorEffect="non-scaling-stroke" />
      <path d={`${d} L 400 150 L 0 150 Z`} fill={`url(#${gradientID})`} stroke="none" />
      <path d={d} fill="none" stroke={MARK} strokeWidth={3.4}
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
/** Period comparison. Bottom-aligned, rounded tops. */
export function Bars({ values, activeIndex, srLabel }: {
  values: number[]; activeIndex?: number; srLabel: string
}) {
  if (!values.length || !hasSignal(values)) return null
  const hi = Math.max(...values) || 1
  return (
    /* Square tops and a hairline floor.

       The rounded cap was 3px of radius on a bar that is often 4px wide, which
       rounds most of the mark away and makes a short bar read as a dot. Square
       also lets adjacent bars form a silhouette the eye can follow across the
       series, which is the whole point of putting them next to each other.

       The gap is 2px rather than 4: bars are a distribution, and a distribution
       reads as one shape with gaps in it, not as a row of separate objects. */
    /* SLIM COLUMNS, NOT A WALL. Thirty periods across a 553px cell drew as
       thirty 16px blocks touching at a 2px seam — a grey wall with one black
       brick at the end. Each column is capped at 6px and the row spreads
       them, so the series reads as thirty marks over a hairline baseline;
       the top is rounded 2px (the data end) and the foot is square. The
       current period is the one full-weight mark; the rest are muted. */
    <div
      className="flex h-full items-end justify-between gap-[2px] border-b"
      style={{ borderColor: ink(14) }}
      role="img"
      aria-label={srLabel}
    >
      {values.map((v, i) => (
        <span key={i} className="min-w-0 flex-1 max-w-[6px] rounded-t-[2px]"
              style={{
                height: `${Math.max(3, (v / hi) * 100)}%`,
                background: activeIndex === undefined ? MARK : i === activeIndex ? NOW : QUIET,
              }} />
      ))}
    </div>
  )
}
/** Ranked composition: label, track, figure. The bars share one scale. */
export function Rows({ items, srLabel, formatValue }: {
  items: { label: string; value: number }[]
  srLabel: string
  formatValue?: (n: number) => string
}) {
  const { h } = useWidgetSize()
  if (!items.length || !hasSignal(items.map((i) => i.value))) return null
  /* FEWER ROWS ON A SHORT CELL, not all of them squeezed.
     Four rows in a one-row cell gave each about seven pixels: the labels
     collided with their own values and the whole thing read as a smear. A
     drawing that cannot be read is not a smaller drawing, it is a worse one —
     so a short cell shows the top two and a tall one shows five. The rows are
     already ranked, so what survives is what matters most, and the tail is
     gathered by the caller rather than silently dropped here. */
  const room = h >= 2 ? 5 : 2
  const shown = items.slice(0, room)
  const hi = Math.max(...items.map((i) => i.value)) || 1
  const fmt = formatValue ?? ((n: number) => String(n))
  return (
    /* The rows SHARE the height rather than each taking a fixed 12px and the
       first one falling off the top. Three fixed rows need ~54px and the
       drawing row can be 46, so the top row was silently cut — which is the
       white rule that appeared to slice through the card's own sentence.
       `flex-1 min-h-0` on each row makes them compress evenly instead. */
    /* ONE grid for every row, not one grid per row.
       Each row was its own three-column grid, so minmax(38px, auto) resolved
       against that row's OWN label: "Documents pending" made a 111px column
       and "Offered" a 43px one, which moved where each track started and how
       long it ran. Two bars both at 50% rendered 236px and 270px. Equal
       values drawn unequal is the one thing a bar chart must not do, and it
       is what made this read as ragged rather than as data.
       A single grid resolves the label column once, against the widest label,
       so every track begins at the same x and runs the same length. */
    <div
      /* SPREAD, NOT PILED AT THE FOOT.

         content-end pushed every row to the bottom edge, so a card with two
         series drew two hairlines in the last twelve pixels of a two hundred
         pixel cell and left the rest black. That is the emptiness the board
         was accused of: the space was allocated to the drawing and the drawing
         declined to use it.

         The rows are already explicit 1fr tracks, so removing the packing lets
         them share the height they were given. */
      className="grid h-full min-h-0 grid-cols-[minmax(38px,auto)_minmax(0,1fr)_auto]
                 items-center gap-x-1.5 gap-y-1"
      style={{ gridTemplateRows: `repeat(${shown.length}, minmax(0, 1fr))` }}
      role="img"
      aria-label={srLabel}
    >
      {shown.map((it) => (
        <Fragment key={it.label}>
          {/* Same micro-label treatment as the card's own, and gated the same
              way -- a Telugu subject name here would be pulled apart by the
              tracking exactly as it would in the header. */}
          <span
            className={cn(
              'truncate text-[length:min(9px,var(--card-note,9px))] leading-none opacity-70',
              isLatin(it.label)
                ? 'font-normal uppercase tracking-[0.07em]'
                : 'font-normal',
            )}
          >
            {it.label}
          </span>
          {/* Square. A 3px radius on a 5px-tall track rounds the ends into
              lozenges, and two lozenges of different lengths are harder to
              compare than two rectangles -- the eye reads the curve as part of
              the length. Thinner too: at 10px this was a bar chart competing
              with the figure above it, and it is meant to be a measure. */}
          {/* The bar grows with its row. Fixed at 6px it stayed a hairline
              however tall the cell got, which is what made a 2x2 card look
              like a 1x1 with more black around it. Capped so a card with two
              rows does not draw two slabs. */}
          {/* 6px, NOT min(18px, 55%). A rail that grew with its row became an
              18px slab on every 2x1 card of a busy board — the thing the
              board was accused of. A measure is a rail: 6px, square where it
              starts at the label, rounded 3px at the data end, on a track
              that is the same ink two steps lighter. */}
          <span className="h-[9px] overflow-hidden rounded-r-[3px]" style={{ background: TRACK }}>
            <span className="block h-full rounded-r-[3px]"
                  style={{ width: `${Math.min(100, (it.value / hi) * 100)}%`, background: MARK }} />
          </span>
          <b className="text-[length:min(10px,var(--card-note,10px))] leading-none
                        tabular-nums [font-weight:650]">{fmt(it.value)}</b>
          </Fragment>
      ))}
    </div>
  )
}
/** One proportion, as a stroked arc. Needs a real total.
    Drawn as an SVG stroke rather than a conic-gradient with a disc punched out
    of the middle. The punched version had to paint that disc SOME colour, and
    it painted `--bento-card` — correct on a paper cell and wrong on every
    other one. On a domain-tinted card it showed a paper-coloured hole; on an
    inverted cell a pale disc on a dark ground. A stroke has no hole to fill,
    so the ground shows through whatever the ground happens to be.
    The arc opens at twelve o'clock and runs clockwise. `pathLength` is set to
    100 so the dash array is literally the percentage — no circumference
    arithmetic to get wrong when the radius changes. */
export function Gauge({ value, total, srLabel }: { value: number; total: number; srLabel: string }) {
  const t = num(total)
  if (t <= 0) return null
  const pct = Math.max(0, Math.min(100, Math.round((num(value) / t) * 100)))
  return (
    <div className="grid h-full place-items-center" role="img" aria-label={srLabel}>
      {/* Sized by the row's HEIGHT, not its width. A drawing row on a 1x1 is
          about 69px tall while the card is 264px wide, so a ring measured
          against the width overflowed the row and had its bottom sliced off by
          the cell's `overflow: hidden`. `h-full` with a square aspect makes the
          height the binding constraint, which is the one that is short. */}
      <div className="relative grid aspect-square h-full max-h-[104px] place-items-center">
        <svg viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90">
          {/* Thinner, and cut square at both ends.

              An 11-unit stroke on a 42 radius is a quarter of the ring's own
              width -- a doughnut, not a dial. At 6 it reads as an arc drawn
              round the number, which is what leaves the number the loudest
              thing in the cell.

              The round cap went with it, and for a reason beyond taste: a
              round cap adds half the stroke width past the true end of the
              arc, so 2% drew as roughly 6% and 0.5% still drew a visible
              lozenge. A butt cap ends where the value ends. */}
          <circle cx="50" cy="50" r="43" fill="none" stroke={TRACK} strokeWidth={8} />
          {pct > 0 && (
            <circle
              cx="50" cy="50" r="43" fill="none"
              stroke={MARK} strokeWidth={8} strokeLinecap="butt"
              pathLength={100}
              strokeDasharray={`${pct} ${100 - pct}`}
            />
          )}
        </svg>
        <span className="relative text-[15px] tabular-nums tracking-[-0.03em] [font-weight:650]">
          {pct}
          <span className="ml-[1px] align-baseline text-[0.55em] opacity-60
                           [font-family:var(--bento-mono)]">%</span>
        </span>
      </div>
    </div>
  )
}
/** Composition over periods: columns split into segments. */
export function Stack({ columns, srLabel }: {
  columns: { total: number; parts: number[] }[]; srLabel: string
}) {
  if (!columns.length || !hasSignal(columns.map((c) => c.total))) return null
  const hi = Math.max(...columns.map((c) => c.total)) || 1
  return (
    <div className="flex h-full items-end justify-between gap-[2px]" role="img" aria-label={srLabel}>
      {columns.map((c, i) => (
        // Slim columns, 2px of surface between the parts of each (a stack
        // whose parts touch reads as one bar with stripes on it), the top
        // part rounded 2px at the data end, the foot square.
        <span key={i} className="flex min-w-0 flex-1 max-w-[6px] flex-col gap-[2px] overflow-hidden rounded-t-[2px]"
              style={{ height: `${Math.max(4, (c.total / hi) * 100)}%` }}>
          {c.parts.map((p, j) => (
            <span key={j} style={{
              height: `${(p / (c.total || 1)) * 100}%`,
              background: ink(Math.max(18, 60 - j * 20)),
            }} />
          ))}
        </span>
      ))}
    </div>
  )
}
/** Spread. Bars whose heights describe a curve rather than a ranking. */
export function Distribution({ values, srLabel }: { values: number[]; srLabel: string }) {
  if (!values.length || !hasSignal(values)) return null
  const hi = Math.max(...values) || 1
  return (
    <div className="flex h-full items-end justify-between gap-[2px]" role="img" aria-label={srLabel}>
      {values.map((v, i) => (
        <span key={i} className="min-w-0 flex-1 max-w-[6px] rounded-t-[2px]"
              style={{ height: `${Math.max(3, (v / hi) * 100)}%`, background: MARK }} />
      ))}
    </div>
  )
}
/** Two labelled tracks against one scale — plan over actual. */
export function Compare({ rows, srLabel, formatValue }: {
  rows: { label: string; value: number }[]
  srLabel: string
  formatValue?: (n: number) => string
}) {
  if (rows.length < 2 || !hasSignal(rows.map((r) => r.value))) return null
  const hi = Math.max(...rows.map((r) => r.value)) || 1
  const fmt = formatValue ?? ((n: number) => String(n))
  return (
    /* One grid, for the same reason as Rows: a grid PER ROW sizes its label
       column against that row's own label, so the tracks start and end in
       different places and two equal values draw as unequal bars. */
    <div
      className="grid h-full grid-cols-[minmax(34px,auto)_minmax(0,1fr)_auto]
                 content-center items-center gap-x-1.5 gap-y-2"
      role="img"
      aria-label={srLabel}
    >
      {rows.map((r) => (
        <Fragment key={r.label}>
          <span className="truncate text-[8px] font-medium uppercase tracking-[0.06em] opacity-70">
            {r.label}
          </span>
          <span className="h-[9px] overflow-hidden rounded-r-[3px]" style={{ background: TRACK }}>
            <span className="block h-full rounded-r-[3px]"
                  style={{ width: `${(r.value / hi) * 100}%`, background: MARK }} />
          </span>
          <b className="text-[9px] font-bold tabular-nums">{fmt(r.value)}</b>
        </Fragment>
      ))}
    </div>
  )
}
/** A part inside its whole: one track, not two bars.
    Collected is a SUBSET of billed, and Compare drew them as two independent
    tracks against a shared maximum. That is arithmetically honest and visually
    useless: at 87.7% collected the two bars differ by an eighth of their length,
    so a principal sees two near-identical lines and learns nothing the two
    numbers beside them had not already said.
    A part of a whole is one bar. The fill is what came in, the remainder is what
    has not — and the remainder is the thing somebody is actually looking for,
    because it is the money still outside the building. It is drawn, labelled and
    given its own figure rather than left as the absence of ink. */
export function PartOf({ part, whole, partLabel, wholeLabel, gapLabel, formatValue, srLabel }: {
  part: number
  whole: number
  partLabel: string
  wholeLabel: string
  gapLabel: string
  formatValue?: (n: number) => string
  srLabel: string
}) {
  const w = num(whole)
  if (w <= 0) return null
  const p = Math.max(0, Math.min(num(part), w))
  const pct = Math.round((p / w) * 100)
  const fmt = formatValue ?? ((n: number) => String(n))
  const gap = w - p
  return (
    <div className="flex h-full flex-col justify-center gap-1.5" role="img" aria-label={srLabel}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[8px] font-medium uppercase tracking-[0.06em] opacity-70">
          {partLabel}
        </span>
        <b className="text-[9px] font-bold tabular-nums">{fmt(p)}</b>
      </div>
      <span className="relative block h-[9px] overflow-hidden rounded-r-[3px]" style={{ background: TRACK }}>
        <span className="block h-full rounded-r-[3px]" style={{ width: `${pct}%`, background: MARK }} />
      </span>
      {/* The shortfall, named. Without this the empty end of the track is just
          empty, and the one number a principal came for is the one nobody
          printed. */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[8px] font-medium uppercase tracking-[0.06em] opacity-70">
          {gap > 0 ? gapLabel : wholeLabel}
        </span>
        <b className="text-[9px] font-bold tabular-nums opacity-80">
          {gap > 0 ? fmt(gap) : fmt(w)}
        </b>
      </div>
    </div>
  )
}
/** Facts: the numbers around the headline figure, set as a list.
    This replaces the dot field, and replacing it with another PICTURE was the
    wrong instinct. Nearly every cell that used it passed
    `Array.from({length: n}, () => 1)` — every mark identical — so the drawing
    had no variation in it and could only restate the count already printed
    above. Dots, blocks and a segmented rail were all faithful renderings of
    nothing, which is why each one in turn read as uninformative.
    A cell whose data is one number does not have a chart in it. What it has is
    context: the figures beside the headline that say what the number is made
    of, or what it is a part of. Those are real, they are already fetched, and
    set as a list they fill the row with something worth reading.
    Right-aligned values on a tabular figure so a column of them lines up. */
export function Facts({ items, srLabel }: {
  items: { label: string; value: string }[]
  srLabel: string
}) {
  if (!items.length) return null
  return (
    /* The rows SHARE the row's height rather than stacking at the bottom of
       it. Pinned to the end, one fact left the whole drawing row empty above
       it — the dead space this component exists to remove. `flex-1` on each
       line means one fact fills the row and four split it. */
    <dl className="flex h-full flex-col gap-1" role="img" aria-label={srLabel}>
      {items.map((f) => (
        <div key={f.label}
             className="flex flex-1 items-center justify-between gap-2 border-t pt-1"
             style={{ borderColor: TRACK }}>
          <dt className="truncate text-[8.5px] font-medium uppercase tracking-[0.07em] opacity-65">
            {f.label}
          </dt>
          <dd className="shrink-0 text-[11px] font-bold tabular-nums">{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}
/** Pipeline. Bars narrowing downward, each labelled beside its own bar.
    The label sits OUTSIDE the bar. Inside, it had to be drawn in the cell's
    background colour to read against the fill, and the only token available
    for that was `--bento-card` — paper. Correct on a paper cell, wrong on a
    domain-tinted one and wrong on an inverted one, which is the same mistake
    the punched gauge made. Outside the bar the label is ordinary ink and needs
    to know nothing about the ground. */
export function Funnel({ stages, srLabel, formatValue }: {
  stages: { label: string; value: number }[]
  srLabel: string
  formatValue?: (n: number) => string
}) {
  if (!stages.length || !hasSignal(stages.map((s) => s.value))) return null
  const hi = Math.max(...stages.map((s) => s.value)) || 1
  const fmt = formatValue ?? ((n: number) => String(n))
  return (
    <div className="flex h-full flex-col justify-end gap-1" role="img" aria-label={srLabel}>
      {stages.map((s) => (
        <div key={s.label} className="flex items-center gap-1.5">
          <span className="h-[9px] min-w-0 flex-1">
            <span className="block h-full rounded-r-[3px]"
                  style={{ width: `${Math.max(6, (s.value / hi) * 100)}%`, background: MARK }} />
          </span>
          <b className="shrink-0 text-[9px] font-bold tabular-nums">{fmt(s.value)}</b>
        </div>
      ))}
    </div>
  )
}
/** One value placed in its range: a hairline with a single dot on it. */
export function Scale({ value, min, max, srLabel }: {
  value: number; min: number; max: number; srLabel: string
}) {
  const lo = num(min), hi = num(max)
  if (hi <= lo || !Number.isFinite(value)) return null
  const pct = Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100))
  return (
    <div className="flex h-full items-center" role="img" aria-label={srLabel}>
      <span className="relative block h-px w-full" style={{ background: ink(45) }}>
        <span className="absolute top-1/2 h-[14px] w-[2px] -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${pct}%`, background: MARK }} />
      </span>
    </div>
  )
}
/** Movement between states: short dashes, each row indented from the last. */
export function Flow({ rows, srLabel }: { rows: number[]; srLabel: string }) {
  if (!rows.length) return null
  return (
    <div className="flex h-full flex-col justify-center gap-2" role="img" aria-label={srLabel}>
      {rows.map((n, i) => (
        /* Capped. This built one span per unit with no ceiling, so a paise
           amount handed to it by mistake threw `RangeError: Invalid array
           length` and took the whole dashboard down with it — and well short
           of throwing, 100k rendered 100k DOM nodes. */
        <div key={i} className="flex gap-1" style={{ paddingLeft: `${i * 16}px` }}>
          {Array.from({ length: Math.min(24, Math.max(0, Math.floor(num(n)))) }, (_, j) => (
            <span key={j} className="h-1 w-3" style={{ background: MARK }} />
          ))}
        </div>
      ))}
    </div>
  )
}
/* ── THE REFERENCE VOCABULARY ────────────────────────────────────────────
   Eleven more drawings, taken from the brutalist bento reference. Same two
   rules as everything above: every mark is `currentColor` at some strength,
   and every measure is a rectangle rather than a lozenge, because the reader
   is comparing lengths and a rounded cap eats a meaningful part of a short
   one.

   What they add over the thirteen already here is SHAPE OF DATA. A gauge says
   one proportion; a heatmap says which weeks were bad. A bar row says how much;
   a waterfall says what added and what took away. Every one of these answers a
   question the number above it cannot.

   The reference's own greyscale is deliberately not carried over: the twelve
   domains in this product mean something, and a monochrome board makes them
   indistinguishable. What is carried over is the construction — hairline
   gridlines, a stated axis, a dashed rule where a forecast begins, a legend
   that names its shares. */

/** How dense a mark set can be before it stops being readable at this size. */
function densityFor(w: number, h: number, base: number) {
  const area = Math.max(1, w * h)
  return Math.max(4, Math.round(base * Math.min(2, Math.sqrt(area / 2))))
}

/** CALENDAR OR COHORT DENSITY. Which weeks were bad, not how bad on average.

    Rows are the series, columns are the periods. Cells carry ink in proportion
    to their value — a five-step ramp rather than a continuous one, because the
    eye cannot rank a continuous ramp and five steps it can. An absent value is
    the track, and reads as "nothing happened" rather than as zero. */
export function Heat({ rows, srLabel }: { rows: (number | null)[][]; srLabel: string }) {
  const flat = rows.flat().filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!rows.length || !flat.length || !hasSignal(flat)) return null
  const hi = Math.max(...flat) || 1
  const cols = Math.max(...rows.map((r) => r.length))
  return (
    <div
      className="grid h-full w-full gap-[2px]"
      style={{
        gridTemplateRows: `repeat(${rows.length}, minmax(0,1fr))`,
        gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`,
      }}
      role="img"
      aria-label={srLabel}
    >
      {rows.flatMap((row, r) =>
        Array.from({ length: cols }, (_, c) => {
          const v = row[c]
          const step =
            typeof v === 'number' && Number.isFinite(v)
              ? Math.min(4, Math.floor((v / hi) * 4.999))
              : -1
          return (
            <span
              key={`${r}-${c}`}
              style={{ background: step < 0 ? TRACK : ink(14 + step * 19) }}
            />
          )
        }),
      )}
    </div>
  )
}

/** ONE WHOLE, SPLIT. A single bar carrying every share end to end.

    Use when the parts sum to something meaningful and there are few enough to
    tell apart — four or five. Beyond that the slivers are unreadable and a
    ranked list says more. Shares under 2% are dropped rather than drawn as a
    hairline that cannot be seen but still shifts everything after it. */
export function Segments({
  parts,
  srLabel,
}: {
  parts: { label: string; value: number }[]
  srLabel: string
}) {
  const total = parts.reduce((a, p) => a + num(p.value), 0)
  if (!parts.length || total <= 0) return null
  const shown = parts.filter((p) => num(p.value) / total >= 0.02)
  if (!shown.length) return null
  const sum = shown.reduce((a, p) => a + num(p.value), 0)
  return (
    <div className="flex h-full min-h-0 flex-col justify-center gap-2" role="img" aria-label={srLabel}>
      <div className="flex h-3 w-full overflow-hidden" style={{ border: `1px solid ${ink(26)}` }}>
        {shown.map((p, i) => (
          <span
            key={p.label}
            style={{
              width: `${(num(p.value) / sum) * 100}%`,
              background: ink(88 - i * 20),
            }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[length:min(9px,var(--card-note,9px))] leading-none opacity-70">
        {shown.map((p, i) => (
          <li key={p.label} className="flex items-center gap-1">
            <span className="h-2 w-2 shrink-0" style={{ background: ink(88 - i * 20) }} />
            <span className="truncate font-light">{p.label}</span>
            <b className="tabular-nums [font-weight:650]">
              {Math.round((num(p.value) / sum) * 100)}%
            </b>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A NARROWING. Each stage as a width, each width a share of the first.

    Different from `Funnel` above, which draws stages as rows of a table. This
    is the shape — the eye reads the taper without reading a single number, and
    a stage that loses most of its intake is visible as a step rather than as a
    percentage somebody has to compute. */
export function Ladder({
  stages,
  srLabel,
}: {
  stages: { label: string; value: number }[]
  srLabel: string
}) {
  if (!stages.length || !hasSignal(stages.map((s) => s.value))) return null
  const hi = Math.max(...stages.map((s) => num(s.value))) || 1
  return (
    <div
      className="grid h-full min-h-0 content-center gap-[3px]"
      style={{ gridTemplateRows: `repeat(${stages.length}, minmax(0,1fr))` }}
      role="img"
      aria-label={srLabel}
    >
      {stages.map((s, i) => (
        <div key={s.label} className="flex min-h-0 items-center gap-1.5">
          <span
            className="h-[min(9px,100%)] shrink-0"
            style={{
              width: `${Math.max(2, (num(s.value) / hi) * 100)}%`,
              background: ink(88 - i * 14),
            }}
          />
          <span className="truncate font-light text-[length:min(8.5px,var(--card-note,8.5px))] leading-none opacity-60">
            {s.label}
          </span>
        </div>
      ))}
    </div>
  )
}

/** WHAT ADDED AND WHAT TOOK AWAY, in order, against a running total.

    A net figure of +12,700 hides that something removed 3,500 on the way. Each
    bar floats at the running total it started from, so the drawing is the
    arithmetic. Additions carry full ink, subtractions the quiet end — they are
    the same measure, not two series, so they must not be two colours. */
export function Waterfall({
  steps,
  srLabel,
}: {
  steps: { label: string; delta: number }[]
  srLabel: string
}) {
  const deltas = steps.map((s) => num(s.delta))
  if (!steps.length || !hasSignal(deltas)) return null
  let run = 0
  const spans = deltas.map((d) => {
    const from = run
    run += d
    return { from: Math.min(from, run), to: Math.max(from, run), up: d >= 0 }
  })
  const lo = Math.min(0, ...spans.map((s) => s.from))
  const hi = Math.max(0, ...spans.map((s) => s.to))
  const range = hi - lo || 1
  const zero = ((hi - 0) / range) * 100
  return (
    <div className="relative h-full min-h-0" role="img" aria-label={srLabel}>
      {/* The zero line, because a waterfall without one is a row of floating
          rectangles and the reader cannot tell which way any of them went. */}
      <span
        className="absolute left-0 right-0 h-px"
        style={{ top: `${zero}%`, background: ink(24) }}
      />
      <div className="flex h-full items-stretch gap-[2px]">
        {spans.map((s, i) => (
          <span key={i} className="relative min-w-0 flex-1">
            <span
              className="absolute left-0 right-0"
              style={{
                top: `${((hi - s.to) / range) * 100}%`,
                height: `${Math.max(1.5, ((s.to - s.from) / range) * 100)}%`,
                background: s.up ? MARK : QUIET,
              }}
            />
          </span>
        ))}
      </div>
    </div>
  )
}

/** A RUN OF PERIODS, one stripe each. Uptime, streaks, days open.

    Not a bar chart: every stripe is the same height, and only its ink varies.
    That is the right drawing when the question is "how many, and were they
    consecutive" rather than "how much" — a run of pale stripes in the middle
    of a dark band is a bad week, and no bar chart shows a run as clearly. */
export function Stripes({ values, srLabel }: { values: number[]; srLabel: string }) {
  // Before the early return: a hook cannot be called conditionally, and this
  // drawing returns null for a series with no signal.
  const { w, h } = useWidgetSize()
  if (!values.length || !hasSignal(values)) return null
  const cap = densityFor(w, h, 24)
  const shown = values.slice(-cap)
  const hi = Math.max(...shown) || 1
  return (
    <div className="flex h-full items-stretch gap-[1.5px]" role="img" aria-label={srLabel}>
      {shown.map((v, i) => (
        <span
          key={i}
          className="min-w-0 flex-1"
          style={{ background: ink(10 + (num(v) / hi) * 78) }}
        />
      ))}
    </div>
  )
}

/** THE TOP FEW, as columns with their rank set large.

    The rank is the figure here, not the value — "01" at display size with the
    name under it, and the bar only calibrating how far ahead first is. Reads
    at a glance from across a room, which a table of four numbers does not. */
export function Ranked({
  items,
  srLabel,
}: {
  items: { label: string; value: number }[]
  srLabel: string
}) {
  // Before the early return, for the same reason as every other hook here.
  const { w } = useWidgetSize()
  if (!items.length || !hasSignal(items.map((i) => i.value))) return null
  const shown = items.slice(0, w >= 3 ? 4 : w >= 2 ? 3 : 2)
  const hi = Math.max(...shown.map((i) => num(i.value))) || 1
  return (
    <div className="flex h-full items-end gap-2" role="img" aria-label={srLabel}>
      {shown.map((it, i) => (
        <div key={it.label} className="min-w-0 flex-1">
          <b className="block leading-none tracking-[-0.04em] tabular-nums
                        text-[length:min(var(--card-fig,22px),22px)] [font-weight:650]">
            {String(i + 1).padStart(2, '0')}
          </b>
          <span className="mt-0.5 block truncate font-light text-[length:min(8px,var(--card-note,8px))]
                           uppercase leading-none tracking-[0.07em] opacity-60">
            {it.label}
          </span>
          <span className="mt-1.5 block h-[4px]" style={{ background: TRACK }}>
            <span
              className="block h-full"
              style={{ width: `${(num(it.value) / hi) * 100}%`, background: MARK }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

/** NESTED PROPORTIONS. Concentric arcs, outermost first.

    For two to four shares of DIFFERENT wholes — enrolled of applied, paid of
    billed, present of enrolled — which a single stacked bar would imply are
    parts of one thing. Each ring is its own denominator, and the label says
    which. Thin strokes and butt caps for the reason the gauge uses them: a
    round cap paints past the true end of a short arc. */
export function Rings({
  arcs,
  srLabel,
}: {
  arcs: { label: string; value: number; total: number }[]
  srLabel: string
}) {
  const usable = arcs.filter((a) => num(a.total) > 0).slice(0, 4)
  if (!usable.length) return null
  return (
    <div className="grid h-full place-items-center" role="img" aria-label={srLabel}>
      <div className="relative grid aspect-square h-full max-h-[112px] place-items-center">
        <svg viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90">
          {usable.map((a, i) => {
            const r = 45 - i * 13
            const pct = Math.max(0, Math.min(100, (num(a.value) / num(a.total)) * 100))
            return (
              <Fragment key={a.label}>
                <circle cx="50" cy="50" r={r} fill="none" stroke={TRACK} strokeWidth={5} />
                {pct > 0 && (
                  <circle
                    cx="50" cy="50" r={r} fill="none"
                    stroke={ink(88 - i * 18)} strokeWidth={5} strokeLinecap="butt"
                    pathLength={100} strokeDasharray={`${pct} ${100 - pct}`}
                  />
                )}
              </Fragment>
            )
          })}
        </svg>
        <span className="relative text-[13px] tabular-nums tracking-[-0.03em] [font-weight:650]">
          {Math.round((num(usable[0].value) / num(usable[0].total)) * 100)}
          <span className="ml-px align-baseline text-[0.55em] opacity-60
                           [font-family:var(--bento-mono)]">%</span>
        </span>
      </div>
    </div>
  )
}

/** WHAT HAPPENED, AND WHAT IS ONLY PROJECTED — with the join marked.

    The dashed rule is the whole point and the reason this is a drawing of its
    own rather than a `Line` with extra points: everything left of it was
    measured and everything right of it was computed, and a single unbroken
    line asserts the same confidence in both. The projected part is drawn in
    the quiet ink inside a band, so its width says how uncertain it is. */
export function Forecast({
  actual,
  projected,
  spread = 0.12,
  srLabel,
}: {
  actual: number[]
  projected: number[]
  /** Half-width of the uncertainty band as a fraction of each value. */
  spread?: number
  srLabel: string
}) {
  const all = [...actual, ...projected]
  if (actual.length < 2 || !projected.length || !hasSignal(all)) return null
  const w = 400
  const h = 150
  const lo = Math.min(...all, ...projected.map((v) => v * (1 - spread)))
  const hi = Math.max(...all, ...projected.map((v) => v * (1 + spread)))
  const range = hi - lo || 1
  const x = (i: number) => (i * w) / (all.length - 1 || 1)
  const y = (v: number) => h - 5 - ((v - lo) / range) * (h - 20)
  const path = (vs: number[], from: number) =>
    vs.map((v, i) => `${i ? 'L' : 'M'} ${x(from + i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const joinIndex = actual.length - 1
  // The band is drawn from the join so it starts at the last measured value
  // rather than opening abruptly one step later.
  const band = [actual[joinIndex], ...projected]
  const upper = band.map((v, i) => `${i ? 'L' : 'M'} ${x(joinIndex + i).toFixed(1)} ${y(v * (1 + spread)).toFixed(1)}`).join(' ')
  const lower = [...band].reverse().map((v, i) =>
    `L ${x(joinIndex + band.length - 1 - i).toFixed(1)} ${y(v * (1 - spread)).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full"
         role="img" aria-label={srLabel}>
      <line x1="0" y1={h - 1} x2={w} y2={h - 1} stroke={ink(22)} strokeWidth={1}
            vectorEffect="non-scaling-stroke" />
      <path d={`${upper} ${lower} Z`} fill={ink(12)} stroke="none" />
      <path d={path(actual, 0)} fill="none" stroke={MARK} strokeWidth={3.4}
            strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <path d={path(band, joinIndex)} fill="none" stroke={QUIET} strokeWidth={3.4}
            strokeDasharray="5 4" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {/* Where measurement stops. */}
      <line x1={x(joinIndex)} y1="4" x2={x(joinIndex)} y2={h - 1} stroke={ink(34)}
            strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** ABOVE OR BELOW, period by period. Bars off a centre axis.

    For anything that can go either way — variance against target, net joiners,
    a balance that moves. Drawing these as ordinary bottom-aligned bars forces
    the reader to check a sign on every one; here the direction is the shape.
    Both directions carry the SAME ink at different strengths, because a red/
    green split would claim that below is bad, and for net transfers it is not. */
export function Diverging({ values, srLabel }: { values: number[]; srLabel: string }) {
  if (!values.length || !hasSignal(values)) return null
  const mag = Math.max(...values.map((v) => Math.abs(num(v)))) || 1
  return (
    <div className="relative h-full min-h-0" role="img" aria-label={srLabel}>
      <span className="absolute left-0 right-0 top-1/2 h-px" style={{ background: ink(24) }} />
      <div className="flex h-full items-center gap-[2px]">
        {values.map((raw, i) => {
          const v = num(raw)
          const pct = (Math.abs(v) / mag) * 50
          return (
            <span key={i} className="relative h-full min-w-0 flex-1">
              <span
                className="absolute left-0 right-0"
                style={{
                  height: `${Math.max(1.5, pct)}%`,
                  top: v >= 0 ? `${50 - Math.max(1.5, pct)}%` : '50%',
                  background: v >= 0 ? MARK : QUIET,
                }}
              />
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** SEVERAL MEASURES AT ONCE, on one shape. A radar.

    Honest about its limits, which are real: the area a radar encloses depends
    on the ORDER of its axes, so it can only be read as a silhouette against
    the same axes in the same order — never as an area compared with another
    card's. Use it where the axes are fixed and familiar (the six subjects, the
    five SQAA domains) and never where they are a top-N that changes. */
export function Radar({
  axes,
  srLabel,
}: {
  axes: { label: string; value: number; max?: number }[]
  srLabel: string
}) {
  if (axes.length < 3 || !hasSignal(axes.map((a) => a.value))) return null
  const n = axes.length
  const cx = 50
  const cy = 50
  const R = 40
  const at = (i: number, r: number) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r] as const
  }
  const poly = axes
    .map((a, i) => {
      const max = num(a.max, 100) || 100
      const r = Math.max(0, Math.min(1, num(a.value) / max)) * R
      const [x, y] = at(i, r)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <div className="grid h-full place-items-center" role="img" aria-label={srLabel}>
      <svg viewBox="0 0 100 100" className="h-full max-h-full" style={{ aspectRatio: '1' }}>
        {[0.5, 1].map((f) => (
          <polygon
            key={f}
            points={axes.map((_, i) => at(i, R * f).map((v) => v.toFixed(1)).join(',')).join(' ')}
            fill="none" stroke={ink(16)} strokeWidth={0.6}
          />
        ))}
        {axes.map((_, i) => {
          const [x, y] = at(i, R)
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={ink(12)} strokeWidth={0.6} />
        })}
        <polygon points={poly} fill={ink(14)} stroke={MARK} strokeWidth={1.6}
                 vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

/** A COHORT GRID. Rows are intakes, columns are how long since.

    The retention shape: read across a row for one cohort's decay, down a
    column to compare cohorts at the same age. A triangle, because a cohort
    that started in June has no twelfth month yet — the empty corner is
    information, not a gap to fill. */
export function Matrix({
  rows,
  srLabel,
}: {
  rows: { label: string; values: (number | null)[] }[]
  srLabel: string
}) {
  const flat = rows.flatMap((r) => r.values).filter((v): v is number => typeof v === 'number')
  if (!rows.length || !flat.length || !hasSignal(flat)) return null
  const hi = Math.max(...flat) || 1
  const cols = Math.max(...rows.map((r) => r.values.length))
  return (
    <div className="grid h-full min-h-0 gap-[2px]"
         style={{
           gridTemplateRows: `repeat(${rows.length}, minmax(0,1fr))`,
           gridTemplateColumns: `minmax(0,auto) repeat(${cols}, minmax(0,1fr))`,
         }}
         role="img" aria-label={srLabel}>
      {rows.flatMap((row) => [
        <span key={`${row.label}-l`}
              className="self-center truncate pr-1 text-[length:min(8px,var(--card-note,8px))]
                         leading-none opacity-55">
          {row.label}
        </span>,
        ...Array.from({ length: cols }, (_, c) => {
          const v = row.values[c]
          return (
            <span
              key={`${row.label}-${c}`}
              style={{
                background:
                  typeof v === 'number' && Number.isFinite(v)
                    ? ink(12 + (v / hi) * 76)
                    : 'transparent',
                outline: typeof v === 'number' ? undefined : `1px solid ${ink(7)}`,
                outlineOffset: '-1px',
              }}
            />
          )
        }),
      ])}
    </div>
  )
}

/** NOTHING TO SHOW, AND SO NOTHING SHOWN.

    This used to draw an empty track with its slots marked, on the argument
    that a blank box reads as a card that failed to load while a row of empty
    compartments says "this is a measure, and it is genuinely at nought". The
    argument is good and the drawing did not carry it. Screenshotted at 1440
    and at 390, in both schemes, on a school with no data in it: twelve grey
    compartments under a hairline read as an unstyled placeholder or as a chart
    that errored out, and nine of them on one screen were the main reason the
    board was called a prototype. A shape that has to be explained to be read
    is not doing the reading.

    What replaces it is nothing at all, plus one sentence, which the card
    prints in its own note row rather than here. That is a real design
    position, not an omission:

      - The card stops implying data it does not have. An empty measure is a
        promise that a chart lives here; a sentence is a fact.
      - The card gets short. Losing the drawing row loses the fraction, so
        header, figure and sentence sit as one centred block and the cell is
        composed instead of top-heavy.
      - The card says its thing once. The shell prints the zero sentence in
        place of its own note, so "0" and "No student is on the roll yet" are
        the whole card, where before there were two sentences competing.

    Rejected: a call to action here ("Add your first student"). Every one of
    these cards is already wrapped in a link to the place it opens and draws a
    corner arrow saying so. A second, differently-shaped navigation affordance
    inside the card would be two ways to do one thing, which is the same
    mistake the three separate corner marks were.

    Rejected: keeping the slots and merely quietening them. They were already
    at 10% ink. Below that they are invisible, above it they are a broken
    chart; there is no strength at which a fake measure becomes honest.

    Still a component, still called at every site that called it, still taking
    the same children. It renders no DOM and instead tells the shell what it
    would have said. `slots` is accepted and ignored so no caller breaks. */
export function Nil({ children }: { children?: ReactNode; slots?: number }) {
  useReportNothing(children)
  return null
}

