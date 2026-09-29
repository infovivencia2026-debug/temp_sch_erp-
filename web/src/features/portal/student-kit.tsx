import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { BookOpen, CalendarClock, Home, Menu, NotebookPen, RefreshCw } from 'lucide-react'
import { useFeatureHref } from '@/features/bento/bento-kit'
import { cn } from '@/lib/utils'
import { openLauncher } from '@/features/bento/launcher-open'

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
  late: 'bg-[color-mix(in_oklab,var(--color-destructive,#e11d48)_12%,transparent)] text-destructive',
  today: 'bg-[color-mix(in_oklab,#f59e0b_18%,transparent)] text-[#92400e] dark:text-[#fcd34d]',
  tomorrow: 'bg-[color-mix(in_oklab,#0ea5e9_14%,transparent)] text-[#075985] dark:text-[#7dd3fc]',
  later: 'bg-muted text-muted-foreground',
  done: 'bg-[color-mix(in_oklab,#10b981_16%,transparent)] text-[#065f46] dark:text-[#6ee7b7]',
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
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,#6366f1_14%,transparent)] text-[#4338ca] dark:text-[#a5b4fc]">
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
    root.style.setProperty('--dock-reserve', 'calc(68px + env(safe-area-inset-bottom, 0px))')
    root.dataset.studentTabs = ''
    const style = document.createElement('style')
    style.textContent = 'html[data-student-tabs] .bento-dock{display:none!important}'
    document.head.appendChild(style)
    return () => { root.style.removeProperty('--dock-reserve'); delete root.dataset.studentTabs; style.remove() }
  }, [])
  const item = 'flex min-h-[56px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[12px] font-medium transition-colors active:scale-95'
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t bg-[var(--color-card,white)]/95 px-2 pb-[env(safe-area-inset-bottom,0px)] pt-1 backdrop-blur md:hidden">
      <div className="mx-auto flex max-w-md items-stretch gap-1">
        {tabs.map((t) => {
          const on = loc.pathname === t.to || loc.pathname.startsWith(t.to + '/')
          const Icon = t.icon
          return (
            <Link key={t.label} to={t.to} aria-current={on ? 'page' : undefined}
              className={cn(item, on ? 'text-primary' : 'text-muted-foreground')}>
              <span className={cn('flex h-7 w-12 items-center justify-center rounded-full transition-colors', on && 'bg-[color-mix(in_oklab,var(--color-primary,#4f46e5)_12%,transparent)]')}>
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
