import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/* WHAT THE PRODUCT DOES WHILE IT IS WAITING.
 *
 * Before this file there were two answers to that question and 419 places
 * that chose between them. 409 of them rendered `Loading`, which is the word
 * "Loading…" centred in 96px of nothing; 10 rendered `Skeleton`, which is
 * five identical 36px grey bars whatever is actually coming. Both are the
 * wrong shape by construction, so the layout moves when the data lands: a
 * screen measured on a phone went from 844px of content to 2559px, and the
 * first line of real content landed 35px from where the loading line had
 * been. Somebody reading the sentence that was there is now reading a
 * different one, and somebody reaching for a row taps whatever slid under
 * their thumb.
 *
 * Two ideas run through everything below.
 *
 * The first is SHAPE. A placeholder earns its place only by occupying the
 * space the real thing will occupy. A grey box of the wrong size is worse
 * than showing nothing at all, because then the jump is guaranteed rather
 * than merely likely. So these are not one skeleton with a row count; they
 * are a table that has a header and a column rhythm, a form that has field
 * labels and inputs, a page that has a breadcrumb and a title where the
 * breadcrumb and the title will be.
 *
 * The second is DELAY. Most queries in this product answer from a warm cache
 * in well under a tenth of a second. A skeleton that appears for 80ms and
 * vanishes is not communication, it is a flinch, and a screen that flinches
 * on every visit is the thing that reads as cheap. Everything here waits
 * before it shows itself, so a fast answer is simply the answer, arriving.
 */

/**
 * True only once `active` has been true for longer than a person notices.
 *
 * 220ms is chosen rather than guessed. Below roughly 100ms a wait is not
 * perceived as a wait at all, and up to about a quarter of a second it reads
 * as the screen responding rather than the screen loading; Apple's own
 * guidance and every good implementation of this sit in the 200-500ms band.
 * At the low end of that band because this is used on phones on Indian
 * mobile data, where the honest answer is usually "this will take a moment"
 * and saying so early is kinder than a blank pause.
 *
 * Deliberately no minimum display time. Holding a skeleton on screen after
 * the data has arrived, so it does not "flash", means deliberately showing
 * somebody a fake version of a page they could already be reading. The
 * flicker it prevents is smaller than the delay it introduces.
 */
export function useDelayed(active: boolean, ms = 220): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!active) {
      setShown(false)
      return
    }
    const t = setTimeout(() => setShown(true), ms)
    return () => clearTimeout(t)
  }, [active, ms])
  return shown
}

/* One grey bar.
 *
 * `animate-pulse` is Tailwind's two-second breath and nothing more elaborate
 * than that on purpose: a shimmer that sweeps is an animation competing with
 * the content it is standing in for, and the reduced-motion block in
 * index.css already stops this one dead for anybody who asked for less
 * movement -- at which point the bar still says "not loaded yet" by being a
 * grey block, which was always the whole message.
 *
 * `bg-muted` rather than a hardcoded grey because both palettes exist: in
 * dark mode a fixed light grey is a row of glowing bars, which is the exact
 * opposite of the recessive thing a placeholder is meant to be. */
function Bar({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('animate-pulse rounded-sm bg-muted', className)} style={style} aria-hidden />
}

/**
 * The original: n rows of one bar each.
 *
 * Kept with its exact previous signature and its exact previous look, because
 * ten screens already call it and a placeholder that changes height is the
 * bug this file exists to fix. What it gains is the delay, so the screens
 * whose data is already cached no longer blink grey on the way in.
 */
export function Skeleton({ rows = 5, delay }: { rows?: number; delay?: number }) {
  const show = useDelayed(true, delay)
  if (!show) return null
  return (
    <div className="space-y-2 p-5" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Bar
          key={i}
          className="h-9"
          // Staggered widths so it reads as content rather than as a bar chart.
          style={{ width: `${92 - (i % 3) * 9}%`, animationDelay: `${i * 60}ms` }}
        />
      ))}
    </div>
  )
}

/**
 * A table that has not arrived yet, shaped like the table that will.
 *
 * A register is the most common thing this product makes somebody wait for,
 * and it is the one where movement costs the most: the difference between
 * marking the right child absent and the wrong one is a few pixels of
 * scroll. So this reproduces the real geometry rather than approximating it
 * -- the 41px header band with its border beneath, then rows on the same
 * pitch the real `Td` uses -- and it is bordered and rounded like the card it
 * sits in, so the frame does not appear separately from its contents.
 *
 * `columns` matters more than `rows`. Row count only has to be close, since
 * a table that is one row short scrolls; column count decides where every
 * vertical edge on the screen sits, and getting that wrong moves content
 * sideways, which is far more noticeable than moving it down.
 */
export function SkeletonTable({
  rows = 6,
  columns = 4,
  delay,
}: {
  rows?: number
  columns?: number
  delay?: number
}) {
  const show = useDelayed(true, delay)
  if (!show) return null
  // Roughly the proportions a real register runs to: a wide first column
  // holding a name, then narrower ones holding a class, a date, a number.
  const widths = ['34%', '20%', '18%', '14%', '16%', '12%']
  return (
    <div className="overflow-hidden rounded-[10px] border bg-card" aria-hidden>
      <div className="flex h-[41px] items-center gap-4 border-b px-4">
        {Array.from({ length: columns }, (_, c) => (
          <Bar key={c} className="h-2.5" style={{ width: widths[c % widths.length] }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-[45px] items-center gap-4 border-b px-4 last:border-b-0">
          {Array.from({ length: columns }, (_, c) => (
            <Bar
              key={c}
              className="h-3"
              style={{
                width: widths[c % widths.length],
                // A whole grid breathing in unison reads as one flashing
                // object. Offsetting each row by a frame or two makes it read
                // as many things, which is what it is standing in for.
                animationDelay: `${(r * columns + c) * 40}ms`,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Tiles that have not arrived yet: a dashboard's row of numbers.
 *
 * These are the worst offenders for movement because they are laid out in a
 * grid, so one tile arriving late does not push the page down, it reflows
 * every other tile sideways. Holding the grid with the same column rules the
 * real one uses keeps every tile where it is going to be.
 */
export function SkeletonTiles({ count = 4, delay }: { count?: number; delay?: number }) {
  const show = useDelayed(true, delay)
  if (!show) return null
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-[10px] border bg-card p-5">
          {/* The eyebrow, the number, the qualifier under it: the three lines
              every metric tile in this product actually has. */}
          <Bar className="h-2.5 w-20" style={{ animationDelay: `${i * 70}ms` }} />
          <Bar className="mt-3 h-6 w-24" style={{ animationDelay: `${i * 70 + 30}ms` }} />
          <Bar className="mt-3 h-2.5 w-28" style={{ animationDelay: `${i * 70 + 60}ms` }} />
        </div>
      ))}
    </div>
  )
}

/**
 * A form that has not arrived yet.
 *
 * Two columns collapsing to one on a phone, matching `FormGrid`, because a
 * form skeleton that is one column wide on a desktop hands the page a
 * different height than the form does and moves everything under it. The
 * short bar above each tall one is the field label; without it the whole
 * thing reads as a stack of buttons.
 */
export function SkeletonForm({ fields = 6, delay }: { fields?: number; delay?: number }) {
  const show = useDelayed(true, delay)
  if (!show) return null
  return (
    <div className="grid gap-5 p-5 sm:grid-cols-2" aria-hidden>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i}>
          <Bar className="mb-1.5 h-2.5 w-24" style={{ animationDelay: `${i * 60}ms` }} />
          <Bar className="h-9 w-full" style={{ animationDelay: `${i * 60 + 30}ms` }} />
        </div>
      ))}
    </div>
  )
}

/**
 * A screen whose code is still on the wire.
 *
 * This is the one that runs most often in the whole product, because it is
 * what App.tsx shows for every lazily loaded feature, which is every feature.
 * What it replaced was the word "Loading…" alone in the content area: no
 * breadcrumb, no title, no card. So every navigation played the same two
 * frames -- an empty page with one grey word near the top, then a full page
 * with a breadcrumb and a title in roughly, but not exactly, the same place.
 * Measured on a phone the first line of content shifted 35px between those
 * frames while the page grew from 844px to 2559px.
 *
 * The header block here is the geometry of `PageHead` -- the same px-5 pt-5
 * pb-6, the same width cap, the eyebrow's 13px line and the title's 24px one
 * -- so when the real header arrives it arrives where its stand-in already
 * was, and only the card beneath it changes size.
 */
export function SkeletonPage({ delay }: { delay?: number }) {
  const show = useDelayed(true, delay)
  if (!show) return null
  return (
    <div aria-hidden>
      {/* ONE LINE, NOT TWO.
       *
       * The obvious skeleton for a page header is a small bar for the section
       * and a big one for the title beneath it. That is wrong here, and
       * measuring it is what showed why: this product's `PageHead` renders
       * the title INSIDE the breadcrumb -- "Students / Student 360" on a
       * single 23px line -- and keeps the h1 as sr-only, because the visible
       * duplicate heading was deleted from every screen. A two-line stand-in
       * would be 23px too tall and would push the first card down by that
       * much at the moment the real header replaced it.
       *
       * So: one row, 23px, holding two bars on the same line. Measured
       * against the live header on a 390px viewport, that puts the first card
       * at y=86, which is exactly where the real one lands. */}
      <div className="mx-auto w-full max-w-[1360px] px-5 pb-6 pt-5 sm:px-7">
        <div className="flex h-[23px] items-center gap-2">
          <Bar className="h-2.5 w-16" />
          <Bar className="h-2.5 w-28" style={{ animationDelay: '60ms' }} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[1360px] space-y-7 px-5 pb-10 sm:px-7">
        <SkeletonTable rows={5} columns={4} delay={0} />
      </div>
    </div>
  )
}
