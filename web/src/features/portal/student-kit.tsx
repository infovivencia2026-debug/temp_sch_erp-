import { ProgressRing } from '../../components/ProgressRing'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { BookOpen, CalendarClock, Home, Menu, NotebookPen, RefreshCw } from 'lucide-react'
import { useFeatureHref } from '@/features/bento/bento-kit'
import { cn } from '@/lib/utils'
import { SlidingIndicator } from '@/components/SlidingIndicator'
import { openLauncher } from '@/features/bento/launcher-open'
import './student.css'

/* THE STUDENT'S SMALL KIT.

   The pieces the student's own screens share: the due chip, the check that
   draws itself, the confetti burst, the live clock, pull-to-refresh, the
   phone tab bar and the "where I left off" memory. Nothing here is used by a
   staff or parent screen, and nothing here pulls in a library: the confetti
   is two dozen spans animated with the Web Animations API and removed after a
   second, and all motion stands down under prefers-reduced-motion. */

export function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return true }
}

/* ─── Dates, in the words a child uses ─────────────────────────────────── */

export function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** Whole days from today to a yyyy-mm-dd; negative is late. */
export function daysFrom(iso: string) {
  return Math.round((new Date(iso.slice(0, 10) + 'T00:00:00').getTime() - new Date().setHours(0, 0, 0, 0)) / 86400000)
}
export function shortDate(iso: string) {
  return new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}

const CHIP = {
  late: 'bg-[hsl(var(--sys-danger)/0.12)] text-[hsl(var(--sys-danger-ink))]',
  today: 'bg-[hsl(var(--sys-warning)/0.16)] text-[hsl(var(--sys-warning-ink))]',
  tomorrow: 'bg-[hsl(var(--sys-blue)/0.12)] text-[hsl(var(--sys-blue-ink))]',
  later: 'bg-muted text-muted-foreground',
  done: 'bg-[hsl(var(--sys-success)/0.14)] text-[hsl(var(--sys-success-ink))]',
}
/** Today / Tomorrow / Late, as a small coloured chip. */
export function DueChip({ due, done, className }: { due?: string | null; done?: boolean; className?: string }) {
  let tone: keyof typeof CHIP = 'later'
  let text = 'No due date'
  if (done) { tone = 'done'; text = 'Handed in' }
  else if (due) {
    const n = daysFrom(due)
    if (n < 0) { tone = 'late'; text = n === -1 ? 'Late · 1 day' : `Late · ${-n} days` }
    else if (n === 0) { tone = 'today'; text = 'Due today' }
    else if (n === 1) { tone = 'tomorrow'; text = 'Due tomorrow' }
    else text = n < 7 ? `Due ${new Date(due + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' })}` : `Due ${shortDate(due)}`
  }
  return <span className={cn('inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-[12px] font-semibold', CHIP[tone], className)}>{text}</span>
}

/* ─── The check that draws itself ──────────────────────────────────────── */

/** A round check. `pop` animates it in once (the moment something is done). */
export function DoneCheck({ done, pop, size = 28 }: { done: boolean; pop?: boolean; size?: number }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!pop || !done || !ref.current || reducedMotion()) return
    ref.current.animate([{ transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1.15)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' })
    const path = ref.current.querySelector('path')
    path?.animate([{ strokeDashoffset: 24 }, { strokeDashoffset: 0 }], { duration: 320, delay: 120, easing: 'ease-out', fill: 'backwards' })
  }, [pop, done])
  return (
    <svg ref={ref} width={size} height={size} viewBox="0 0 28 28" aria-hidden className="shrink-0">
      <circle cx="14" cy="14" r="12.5" className={done ? 'fill-success stroke-success' : 'fill-none stroke-border'} strokeWidth="1.5" />
      {done && <path d="M8.5 14.5l3.8 3.7 7.2-8" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="24" />}
    </svg>
  )
}

/* ─── Confetti: tiny, and only for finishing something ─────────────────── */

const HUES = ['#6366f1', '#10b981', '#f59e0b', '#0ea5e9', '#f43f5e']
/** A brief burst from a point (or the middle of the screen). */
export function confetti(from?: Element | null) {
  if (typeof document === 'undefined' || reducedMotion()) return
  const r = from?.getBoundingClientRect()
  const x = r ? r.left + r.width / 2 : window.innerWidth / 2
  const y = r ? r.top + r.height / 2 : window.innerHeight / 3
  const layer = document.createElement('div')
  layer.setAttribute('aria-hidden', 'true')
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden'
  document.body.appendChild(layer)
  const n = 26
  for (let i = 0; i < n; i++) {
    const p = document.createElement('span')
    const w = 5 + Math.random() * 4
    p.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${w * 0.6}px;border-radius:1px;background:${HUES[i % HUES.length]}`
    layer.appendChild(p)
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4
    const v = 70 + Math.random() * 90
    p.animate([
      { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
      { transform: `translate(${Math.cos(a) * v}px,${Math.sin(a) * v - 30}px) rotate(${Math.random() * 360}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${Math.cos(a) * v * 1.2}px,${Math.sin(a) * v + 60}px) rotate(${Math.random() * 540}deg)`, opacity: 0 },
    ], { duration: 900 + Math.random() * 300, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' })
  }
  setTimeout(() => layer.remove(), 1400)
}

/* ─── A clock that ticks ───────────────────────────────────────────────── */

export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), everyMs); return () => clearInterval(t) }, [everyMs])
  return now
}
export function hm(s?: string | null): number | null {
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(s)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
/** "12 min", "1 h 5 min", "45 s". */
export function countdown(sec: number) {
  if (sec < 600) return `${Math.floor(Math.max(0, sec) / 60)}:${String(Math.max(0, sec) % 60).padStart(2, '0')}`
  const m = Math.ceil(sec / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

export interface Period { period: string; starts_at?: string; ends_at?: string; subject: string; teacher?: string; room?: string }
/** Which period is on now, and which comes next, from today's list. */
export function nowNext(periods: Period[], now: Date) {
  const sec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()
  let current: Period | undefined, next: Period | undefined
  for (const p of periods) {
    const a = hm(p.starts_at), b = hm(p.ends_at)
    if (a === null) continue
    if (b !== null && sec >= a * 60 && sec < b * 60) current = p
    else if (a * 60 > sec && !next) next = p
  }
  return { current, next, sec }
}

/** The now/next card, with a live countdown. Shared by home and timetable. */
export function NowNextCard({ periods, to, compact }: { periods: Period[]; to?: string; compact?: boolean }) {
  const now = useNow(1000)
  const { current, next, sec } = nowNext(periods, now)
  const body = (() => {
    if (!periods.length) return { eyebrow: 'Today', title: 'No classes today', sub: 'Enjoy the day off.', pct: null as number | null }
    if (current) {
      const a = hm(current.starts_at)! * 60, b = hm(current.ends_at)! * 60
      return {
        eyebrow: 'Now', title: current.subject,
        sub: [`ends in ${countdown(b - sec)}`, current.room, next ? `next: ${next.subject}` : 'last class today'].filter(Boolean).join(' · '),
        pct: Math.round(((sec - a) / (b - a)) * 100),
      }
    }
    if (next) return { eyebrow: 'Next class', title: next.subject, sub: [`starts in ${countdown(hm(next.starts_at)! * 60 - sec)}`, next.starts_at, next.room].filter(Boolean).join(' · '), pct: null }
    return { eyebrow: 'Today', title: 'Classes are over', sub: `You had ${periods.length} class${periods.length === 1 ? '' : 'es'} today.`, pct: null }
  })()
  const inner = (
    <>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--sys-indigo)/0.13)] text-[hsl(var(--sys-indigo-ink))]">
        <CalendarClock className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{body.eyebrow}</span>
        <span className={cn('block truncate font-semibold leading-tight', compact ? 'text-[18px]' : 'text-[20px]')}>{body.title}</span>
        <span className="block truncate text-[13px] tabular-nums text-muted-foreground">{body.sub}</span>
        {body.pct !== null && (
          <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span className="block h-full rounded-full bg-primary transition-[width] duration-1000" style={{ width: `${body.pct}%` }} />
          </span>
        )}
      </span>
    </>
  )
  const cls = 'card flex min-h-[76px] w-full items-center gap-3 px-[var(--card-pad,16px)] py-3 text-left'
  return to ? <Link to={to} className={cn(cls, 'transition active:scale-[.99]')}>{inner}</Link> : <div className={cls}>{inner}</div>
}

/* ─── Where I left off ─────────────────────────────────────────────────── */

export interface LastPlace { cs: string; day?: string | null; item?: string | null; subject?: string; title?: string; at: number }
const LAST_KEY = 'student-lms-last'
export function rememberPlace(p: Omit<LastPlace, 'at'>) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ ...p, at: Date.now() })) } catch { /* private mode */ }
}
export function lastPlace(): LastPlace | null {
  try { const r = localStorage.getItem(LAST_KEY); return r ? JSON.parse(r) as LastPlace : null } catch { return null }
}
export function placeHref(base: string, p: { cs: string; day?: string | null; item?: string | null }) {
  const q = new URLSearchParams({ cs: p.cs })
  if (p.day) q.set('day', p.day)
  if (p.item) q.set('item', p.item)
  return `${base}?${q}`
}

/* ─── Pull to refresh ──────────────────────────────────────────────────── */

/** Pull down at the top of the page to refresh. The page's own scroller
    (`[data-app-scroll]`) does the scrolling; html and body stay pinned. */
export function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<unknown>; children: ReactNode }) {
  const [pull, setPull] = useState(0)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const start = useRef<number | null>(null)
  const pullRef = useRef(0)
  const run = useCallback(async () => {
    setBusy(true)
    try { await onRefresh() } finally { setBusy(false); setPull(0); pullRef.current = 0 }
  }, [onRefresh])
  useEffect(() => {
    const el = box.current
    if (!el) return
    const scroller = el.closest('[data-app-scroll]') as HTMLElement | null
    const top = () => (scroller ? scroller.scrollTop : document.getElementById('root')?.scrollTop ?? 0) <= 0
    const onStart = (e: TouchEvent) => { start.current = top() && !busy ? e.touches[0].clientY : null }
    const onMove = (e: TouchEvent) => {
      if (start.current === null) return
      const d = e.touches[0].clientY - start.current
      if (d <= 0 || !top()) { if (pullRef.current) { pullRef.current = 0; setPull(0) } return }
      const v = Math.min(90, d * 0.45)
      pullRef.current = v
      setPull(v)
    }
    const onEnd = () => {
      if (start.current === null) return
      start.current = null
      if (pullRef.current >= 60) void run()
      else { pullRef.current = 0; setPull(0) }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd); el.removeEventListener('touchcancel', onEnd)
    }
  }, [busy, run])
  const shown = busy ? 48 : pull
  return (
    <div ref={box}>
      <div aria-live="polite" className="flex items-end justify-center overflow-hidden" style={{ height: shown, transition: start.current === null ? 'height .2s ease' : undefined }}>
        {shown > 0 && (
          <span className="mb-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
            <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} style={busy ? undefined : { transform: `rotate(${pull * 4}deg)` }} />
            {busy ? 'Refreshing…' : pull >= 60 ? 'Let go to refresh' : 'Pull to refresh'}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

/* ─── The phone tab bar ────────────────────────────────────────────────── */

/** Five tabs on a phone: Home, Timetable, Learn, Homework, More (the full
    menu). Rendered by the shell for a student on a phone, in either layout:
    in the sidebar layout More opens the drawer (`onMore`); in the Bento
    layout it opens the launcher, and the board's own dock bar is hidden so
    there is one bar, not two. */
const pickTabPill = (list: HTMLElement) => list.querySelector<HTMLElement>('[data-tab-pill]')

export function StudentTabBar({ onMore }: { onMore?: () => void }) {
  const loc = useLocation()
  const tabs = [
    { to: useFeatureHref('student.home.my_day'), label: 'Home', icon: Home },
    { to: useFeatureHref('student.timetable.timetable'), label: 'Timetable', icon: CalendarClock },
    { to: useFeatureHref('student.learning.courses_subjects'), label: 'Learn', icon: BookOpen },
    { to: useFeatureHref('student.homework.homework_assignments'), label: 'Homework', icon: NotebookPen },
  ].filter((t): t is { to: string; label: string; icon: typeof Home } => !!t.to)
  useEffect(() => {
    const root = document.documentElement
    /* The assistant orb floats above this bar (AssistantTab reads
       --orb-bottom); it sat at the bar's own height, under it, and showed
       through as a green smudge beside More. The reserve clears both, so the
       last card scrolls out from under the orb too. */
    /* Both lengths are in styles/page-foot.css now, keyed on the attribute
       below: the reserve is the pill's height plus its lift, and nothing
       else. It used to be written here with 60px added for the orb, which
       every page then showed as empty ground above the bar. */
    root.dataset.studentTabs = ''
    const style = document.createElement('style')
    style.textContent = 'html[data-student-tabs] .bento-dock{display:none!important}'
    document.head.appendChild(style)
    return () => { delete root.dataset.studentTabs; style.remove() }
  }, [])
  const barRef = useRef<HTMLDivElement>(null)
  const item = 'flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[12px] font-medium leading-none transition-colors active:scale-95'
  return (
    /* A FLOATING PILL, like the dock on a desktop: inset 12px from each side,
       lifted clear of the home indicator (--dock-lift), fully rounded, glass
       with a solid fallback (styles/page-foot.css). The page scrolls under
       it; --page-foot is what keeps the last row above it. */
    <nav aria-label="Main" className="student-tabbar fixed inset-x-[12px] bottom-[var(--dock-lift,10px)] z-40 mx-auto box-border h-[var(--tabbar-h,64px)] max-w-md rounded-full border px-[6px] py-[4px] md:hidden">
      <div ref={barRef} className="relative flex h-full items-stretch gap-1">
        {/* The tint behind the current tab's icon slides between tabs. */}
        <SlidingIndicator listRef={barRef} active={loc.pathname} pick={pickTabPill}
          className="rounded-full bg-[hsl(var(--primary)/0.12)]" />
        {tabs.map((t) => {
          const on = loc.pathname === t.to || loc.pathname.startsWith(t.to + '/')
          const Icon = t.icon
          return (
            <Link key={t.label} to={t.to} aria-current={on ? 'page' : undefined}
              className={cn(item, on ? 'text-primary' : 'text-muted-foreground')}>
              <span data-tab-pill={on ? '' : undefined} className={cn('flex h-7 w-12 items-center justify-center rounded-full transition-colors', on && 'bg-[hsl(var(--primary)/0.12)]')}>
                <Icon className="h-[22px] w-[22px]" strokeWidth={on ? 2 : 1.6} />
              </span>
              {t.label}
            </Link>
          )
        })}
        <button type="button" onClick={() => (onMore ? onMore() : openLauncher())} className={cn(item, 'text-muted-foreground')}>
          <span className="flex h-7 w-12 items-center justify-center"><Menu className="h-[22px] w-[22px]" strokeWidth={1.6} /></span>
          More
        </button>
      </div>
    </nav>
  )
}

/* ─── A skeleton the size of what it stands for ────────────────────────── */
export function Bone({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block animate-pulse rounded-md bg-muted', className)} />
}

/* ─── The pieces the redone student screens share ──────────────────────── */

/** A soft tint of one of the scheme hues, for an icon disc or a chip. */
/* The student screens' five hues are the system colours (styles/
   color-system.css): a 13% wash of the vivid value behind, the text-grade
   ink in front, the vivid value itself for an arc or a bar. They follow
   light and dark, and any palette that moves the system hues, on their own. */
export const HUE = {
  indigo: { bg: 'bg-[hsl(var(--sys-indigo)/0.13)]', fg: 'text-[hsl(var(--sys-indigo-ink))]', stroke: 'hsl(var(--sys-indigo))' },
  emerald: { bg: 'bg-[hsl(var(--sys-green)/0.14)]', fg: 'text-[hsl(var(--sys-green-ink))]', stroke: 'hsl(var(--sys-green))' },
  amber: { bg: 'bg-[hsl(var(--sys-orange)/0.15)]', fg: 'text-[hsl(var(--sys-orange-ink))]', stroke: 'hsl(var(--sys-orange))' },
  sky: { bg: 'bg-[hsl(var(--sys-blue)/0.12)]', fg: 'text-[hsl(var(--sys-blue-ink))]', stroke: 'hsl(var(--sys-blue))' },
  rose: { bg: 'bg-[hsl(var(--sys-pink)/0.11)]', fg: 'text-[hsl(var(--sys-pink-ink))]', stroke: 'hsl(var(--sys-pink))' },
  slate: { bg: 'bg-muted', fg: 'text-muted-foreground', stroke: 'hsl(var(--sys-gray))' },
} as const
export type Hue = keyof typeof HUE

/** Page title row, the same height loaded or not, so nothing under it moves. */
export function StudentHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex min-h-[56px] items-center gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-[24px] font-semibold leading-tight">{title}</h1>
        <p className="min-h-[19px] text-[13px] text-muted-foreground">{sub ?? ' '}</p>
      </div>
      {right}
    </div>
  )
}

/** The page column every redone student screen sits in. */
/** `wide`: the full width on a computer, for pages laid out in columns there. */
export function StudentPage({ children, wide }: { children: ReactNode; wide?: boolean }) {
  /* No pb on a phone: the scroller's --page-foot is the one reserve there
     (styles/page-foot.css), and pb-6 under it was a second gutter. */
  return <div className={cn('mx-auto w-full space-y-3 px-4 pt-2 md:px-6 md:pb-6 md:pt-6', /* Full width on a computer for every student page: the owner found the
     web view looked like the phone view. */
    'max-w-3xl lg:max-w-none lg:px-8', wide && '')}>{children}</div>
}

/** Fills after first paint (so the arc visibly grows), or at once with reduced motion. */
function useGrow(target: number) {
  const [v, setV] = useState(() => (reducedMotion() ? target : 0))
  useEffect(() => { const t = requestAnimationFrame(() => setV(target)); return () => cancelAnimationFrame(t) }, [target])
  return v
}

/** A big progress ring with the figure in the middle. `pct` is 0-100. */
export function Ring({ pct, size = 120, stroke = 11, hue = 'indigo', children, label }: { pct: number; size?: number; stroke?: number; hue?: Hue; children?: ReactNode; label: string }) {
  const shown = useGrow(Math.max(0, Math.min(100, pct)))
  return (
    <ProgressRing pct={shown} size={size} stroke={stroke} arcColor={HUE[hue].stroke} arcClassName="stu-ring-arc" className="relative shrink-0" label={label}>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </ProgressRing>
  )
}

/** A bar that grows to `pct` (0-100). */
export function Bar({ pct, hue = 'indigo', className }: { pct: number; hue?: Hue; className?: string }) {
  const shown = useGrow(Math.max(0, Math.min(100, pct)))
  return (
    <span className={cn('block h-2 overflow-hidden rounded-full bg-muted', className)} aria-hidden>
      <span className="stu-bar block h-full rounded-full" style={{ width: `${shown}%`, background: HUE[hue].stroke }} />
    </span>
  )
}

/** One small summary card: an icon disc, a figure and what it counts. */
export function Tile({ icon: Icon, hue, value, label, i = 0 }: { icon: typeof Home; hue: Hue; value: ReactNode; label: string; i?: number }) {
  return (
    <div className="card stu-rise flex min-h-[92px] flex-col justify-between gap-2 p-3" style={{ ['--i' as string]: i }}>
      <span className={cn('flex h-9 w-9 items-center justify-center rounded-full', HUE[hue].bg, HUE[hue].fg)}>
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </span>
      <span>
        <span className="block text-[20px] font-semibold leading-tight tabular-nums">{value}</span>
        <span className="block text-[12px] leading-tight text-muted-foreground">{label}</span>
      </span>
    </div>
  )
}

/** Two or three choices as one pill row with 44px targets. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  const listRef = useRef<HTMLDivElement>(null)
  return (
    <div role="tablist" aria-label={label} ref={listRef} className="relative flex gap-1 rounded-2xl bg-muted/70 p-1">
      <SlidingIndicator listRef={listRef} active={value} className="rounded-xl bg-[var(--color-card,white)] shadow-sm" />
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cn('min-h-[44px] flex-1 rounded-xl px-3 text-[14px] font-medium transition-colors', value === o.value ? 'bg-[var(--color-card,white)] text-foreground shadow-sm' : 'text-muted-foreground')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A small line of scores over time (0-100), with the last point marked. */
export function Trend({ points, labels, height = 96 }: { points: number[]; labels: string[]; height?: number }) {
  const w = 320, h = height, pad = 10
  const x = (i: number) => (points.length < 2 ? w / 2 : pad + (i * (w - 2 * pad)) / (points.length - 1))
  const y = (v: number) => pad + ((100 - v) * (h - 2 * pad)) / 100
  const line = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`
  const last = points.length - 1
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="block h-auto w-full" role="img" aria-label={`Your scores: ${points.map((p, i) => `${labels[i]} ${Math.round(p)}%`).join(', ')}`}>
      <defs>
        <linearGradient id="stu-trend" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity="0.28" />
          <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[25, 50, 75].map((g) => <line key={g} x1={pad} x2={w - pad} y1={y(g)} y2={y(g)} stroke="currentColor" className="text-border" strokeDasharray="3 4" />)}
      {points.length > 1 && <path d={area} fill="url(#stu-trend)" />}
      {points.length > 1 && <path d={line} fill="none" stroke="hsl(var(--chart-1))" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}
      {points.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={i === last ? 5 : 3.5} fill={i === last ? 'hsl(var(--chart-1))' : 'hsl(var(--card))'} stroke="hsl(var(--chart-1))" strokeWidth="2" />)}
    </svg>
  )
}
