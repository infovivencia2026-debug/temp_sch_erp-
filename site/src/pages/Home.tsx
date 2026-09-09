import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Check, Moon, Sun } from 'lucide-react'
import { INDUSTRIES, homePathFor, INDUSTRY_MAP } from '@/industries'
import { industryPath } from '@/lib/nav'
import { Modal } from '@/components/ui'
import { AppearanceButton } from '@/components/layout/appearance'
import { useApp, UIS, type UiId } from '@/hooks/useAppState'
import { cx } from '@/lib/utils'

/**
 * The one vertical on this site that is a shipped product rather than a
 * prototype: the school ERP. Both links below point at its real sign-in.
 */
const SIGN_IN_URL = 'https://school-erp-cqj.pages.dev/login'

/**
 * The front door. One suite, five verticals — the same shell, tables, drawers
 * and charts behind each button, with a different registry and vocabulary
 * loaded underneath.
 */
export function Home() {
  const nav = useNavigate()
  const app = useApp()

  // Choosing an industry is only half the choice: the same registry can be
  // worn three different ways, so the card opens the interface picker rather
  // than jumping straight into the app.
  const [picking, setPicking] = useState<string | null>(null)
  const pickingDef = picking ? INDUSTRY_MAP[picking] : null

  const open = (industryId: string, ui: UiId) => {
    app.setUi(ui)
    app.setIndustry(industryId)
    const def = INDUSTRY_MAP[industryId]
    // homePathFor reads the registry that setIndustry just activated.
    nav(`${industryPath(homePathFor(def.user.defaultRole), industryId)}?ui=${ui}`)
  }

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-[68px] items-center gap-3 border-b chrome px-6 sm:px-10">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-ink text-ink-foreground text-[13px] font-semibold">V</div>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold leading-tight">Vivencia Suite</p>
          <p className="text-[10px] muted">Industry ERP platform</p>
        </div>
        <a
          href={SIGN_IN_URL}
          className="ml-auto rounded-full border px-4 py-2 text-[13px] font-medium transition-colors duration-300 ease-premium hover:bg-accent"
        >
          Sign in
        </a>
        <span><AppearanceButton /></span>
        <button
          className="rounded-full p-2.5 hover:bg-accent"
          onClick={() => app.setTheme(app.theme === 'dark' ? 'light' : 'dark')}
          title="Toggle theme"
        >
          {app.theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>
      </header>

      <section className="border-b px-6 pb-14 pt-16 sm:px-10">
        <div className="max-w-3xl reveal">
          <p className="eyebrow">One platform · five industries</p>
          <h1 className="display mt-5">Pick the business you run.</h1>
          <p className="mt-6 max-w-xl text-[17px] leading-relaxed muted">
            Every vertical below is the same application — the same navigation, tables, record
            drawers, forms and dashboards. What changes is the module registry underneath and the
            language on screen.
          </p>
        </div>
      </section>

      {/* Industry buttons. A single grid of large targets: the whole card is the
          button, so there is nothing to hunt for. */}
      <section className="px-6 py-14 sm:px-10">
        <p className="eyebrow mb-6">Choose an industry</p>
        <div className="grid gap-px overflow-hidden rounded-lg bg-border reveal md:grid-cols-2 xl:grid-cols-3">
          {INDUSTRIES.map((ind, i) => {
            const current = app.industryId === ind.id
            // Education is the vertical that actually ships, so its card leads
            // to the live sign-in; the others can only open the prototype.
            const live = ind.id === 'education'
            const Card: 'a' | 'button' = live ? 'a' : 'button'
            return (
              <Card
                key={ind.id}
                {...(live
                  ? { href: SIGN_IN_URL }
                  : { onClick: () => setPicking(ind.id) })}
                className="group bg-card p-8 text-left transition-colors duration-500 ease-premium hover:bg-accent/40"
              >
                <div className="flex items-start justify-between">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-primary-foreground">
                    <ind.icon className="h-5 w-5" />
                  </div>
                  <span className="section-no">{String(i + 1).padStart(2, '0')}</span>
                </div>
                <h2 className="mt-6 text-[24px] font-medium leading-tight tracking-[-0.03em]">{ind.label}</h2>
                <p className="mt-2 text-[13px] font-medium muted">{ind.tagline}</p>
                <p className="mt-4 text-[13px] leading-relaxed muted">{ind.blurb}</p>

                <ul className="mt-6 space-y-1.5">
                  {ind.highlights.map((h) => (
                    <li key={h} className="flex items-start gap-2 text-[12px] muted">
                      <Check className="mt-[3px] h-3 w-3 shrink-0 text-primary" /> {h}
                    </li>
                  ))}
                </ul>

                <div className="mt-7 flex items-center gap-2 border-t pt-5 text-[13px] font-medium">
                  <span className={cx((current || live) && 'text-primary')}>
                    {live
                      ? `Sign in to ${ind.product}`
                      : `${current ? 'Continue in' : 'Open'} ${ind.product}`}
                  </span>
                  <ArrowRight className="h-4 w-4 transition-transform duration-500 ease-premium group-hover:translate-x-1" />
                  <span className="ml-auto text-[11px] font-normal muted tabular-nums">
                    {ind.modules.length} modules
                  </span>
                </div>
                {live && (
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); setPicking(ind.id) }}
                    className="mt-3 text-[12px] font-medium muted underline underline-offset-4"
                  >
                    Or open the prototype
                  </button>
                )}
              </Card>
            )
          })}

          {/* Keeps the grid rhythm on three-column layouts and explains the idea. */}
          <div className="hidden bg-card p-8 xl:block">
            <p className="eyebrow">Why one build</p>
            <p className="mt-5 text-[13px] leading-relaxed muted">
              The registry is data: a module is a label, an icon, a group and a list of tabs, and a
              tab is a compact column spec. Adding a vertical means writing that data, not writing
              another application.
            </p>
            <p className="mt-4 text-[13px] leading-relaxed muted">
              Records are generated deterministically from the active industry, so a tab shows the
              same rows on every reload — and switching industry re-seeds the whole suite.
            </p>
          </div>
        </div>
      </section>

      <footer className="border-t px-6 py-8 text-[11px] muted sm:px-10">
        Prototype data · no backend · all figures are simulated
      </footer>

      <Modal
        open={!!pickingDef}
        onClose={() => setPicking(null)}
        size="xl"
        title={pickingDef ? `Open ${pickingDef.label}` : ''}
        subtitle={`Choose an interface. Same modules, same records — ${UIS.length} ways of working.`}
      >
        <div className="max-h-none overflow-y-auto overscroll-contain sm:max-h-[68vh] pr-1">
          {(['shell', 'dashboard', 'education'] as const).map((fam) => (
            UIS.some((u) => u.family === fam && (!u.onlyIndustry || u.onlyIndustry === picking)) === false ? null : (
            <section key={fam} className="mb-6 last:mb-0">
              <p className="eyebrow mb-3">
                {fam === 'shell' ? 'UI-1 – UI-9 · the navigation is the difference'
                  : fam === 'dashboard' ? 'UI-11 – UI-15 · the dashboard is the difference'
                    : 'UI-16 · built for education only'}
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {UIS.filter((u) => u.family === fam)
                  .filter((u) => !u.onlyIndustry || u.onlyIndustry === picking)
                  .map((u) => (
            <button
              key={u.id}
              onClick={() => picking && open(picking, u.id)}
              className={cx('group rounded-xl hairline p-4 text-left transition-colors duration-300 ease-premium hover:bg-accent/50',
                app.ui === u.id && 'ring-1 ring-primary')}
            >
              <UiPreview id={u.id} />
              <div className="mt-4 flex flex-wrap items-baseline gap-x-2">
                <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold tracking-wide muted">{u.label}</span>
                <span className="text-[15px] font-medium">{u.name}</span>
              </div>
              <p className="mt-1 text-[11px] font-medium muted">{u.tagline}</p>
              <p className="mt-2 text-[12px] leading-relaxed muted">{u.detail}</p>
              <span className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-primary touch-reveal">
                Open in {u.name} <ArrowRight className="h-3.5 w-3.5" />
              </span>
                  </button>
                ))}
              </div>
            </section>
            )
          ))}
        </div>
      </Modal>
    </div>
  )
}

/**
 * A wireframe of each shell, drawn rather than screenshotted so it always
 * matches the real thing. Each one shows where the navigation lives, which is
 * the actual difference between the ten.
 */
function UiPreview({ id }: { id: UiId }) {
  const bar = (n: number, cls = 'bg-foreground/15') =>
    Array.from({ length: n }, (_, i) => <span key={i} className={cx('h-1.5 rounded-sm', cls)} />)

  const frame = (bg: string, children: React.ReactNode) => (
    <div className={cx('flex h-[74px] gap-1.5 overflow-hidden rounded-md p-1.5', bg)}>{children}</div>
  )
  const rows = (
    <div className="flex flex-1 flex-col gap-1.5 pt-0.5">
      <span className="h-2 w-1/2 rounded-[2px] bg-foreground/40" />
      {Array.from({ length: 3 }, (_, i) => <span key={i} className="h-px w-full bg-foreground/15" />)}
    </div>
  )

  switch (id) {
    case 'ui-1':  // dock + contextual panel
      return frame('bg-[#12151a]', <>
        <div className="flex w-3 shrink-0 flex-col gap-1">{bar(5, 'bg-cyan-400/50')}</div>
        <div className="flex w-7 shrink-0 flex-col gap-1">{bar(4, 'bg-white/20')}</div>
        <div className="flex flex-1 flex-col gap-1.5 pt-0.5">
          <span className="h-2 w-1/2 rounded-[2px] bg-cyan-300/70" />
          {Array.from({ length: 3 }, (_, i) => <span key={i} className="h-px w-full bg-white/15" />)}
        </div>
      </>)
    case 'ui-2':  // header mega-menu
      return frame('bg-[#f7f4ee] flex-col', <>
        <div className="flex gap-1.5">{bar(5, 'bg-[#b0894a]/40 flex-1')}</div>
        <div className="flex flex-1 flex-col justify-center gap-2">
          <span className="h-4 w-2/3 rounded-[2px] bg-[#1e1b16]/70" />
          <span className="h-px w-full bg-[#1e1b16]/15" />
        </div>
      </>)
    case 'ui-3':  // control strip + chips
      return frame('bg-[#0e1116]', <>
        <div className="flex w-2.5 shrink-0 flex-col gap-1">{bar(6, 'bg-sky-400/40')}</div>
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex gap-1">{bar(4, 'bg-white/20 flex-1')}</div>
          {Array.from({ length: 6 }, (_, i) => <span key={i} className="h-[3px] rounded-[1px] bg-white/10" />)}
        </div>
      </>)
    case 'ui-4':  // command menu + inspector
      return frame('bg-white flex-col', <>
        <div className="flex gap-1">{bar(3, 'bg-orange-500/40 flex-1')}</div>
        <div className="flex flex-1 gap-1.5">
          <div className="flex flex-1 flex-col gap-1 pt-1">
            {Array.from({ length: 4 }, (_, i) => <span key={i} className="h-px w-full bg-black/12" />)}
          </div>
          <div className="w-8 shrink-0 rounded-sm bg-black/[0.06]" />
        </div>
      </>)
    case 'ui-5':  // bottom dock
      return frame('bg-[#f4f6f9] flex-col', <>
        <div className="flex flex-1 items-center justify-center">
          <span className="h-8 w-8 rounded-full border-2 border-sky-500/50" />
        </div>
        <div className="mx-auto flex gap-1 rounded-full border border-black/5 bg-white px-1.5 py-1">
          {Array.from({ length: 5 }, (_, i) => <span key={i} className="h-1.5 w-1.5 rounded-full bg-[#0f2540]/30" />)}
        </div>
      </>)
    case 'ui-6':  // command strip, no rail
      return frame('bg-[#0a0a0a] flex-col', <>
        <div className="flex gap-1.5">{bar(2, 'bg-lime-400/60 w-6')}</div>
        <div className="flex flex-1 items-end gap-1.5 pb-0.5">
          {[10, 16, 8, 20, 13].map((h, i) => (
            <span key={i} className="flex-1 rounded-[1px] bg-white/25" style={{ height: h }} />
          ))}
        </div>
      </>)
    case 'ui-7':  // horizontal bands
      return frame('bg-[#fbf7f0] flex-col gap-1', <>
        <div className="flex gap-1">{bar(4, 'bg-emerald-700/30 flex-1')}</div>
        <span className="h-3 rounded-sm bg-emerald-700/15" />
        <span className="h-3 rounded-sm bg-orange-700/15" />
        <span className="h-3 rounded-sm bg-indigo-700/15" />
      </>)
    case 'ui-8':  // rail + timeline
      return frame('bg-[#0b1220]', <>
        <div className="flex w-3 shrink-0 flex-col gap-1">{bar(4, 'bg-cyan-400/50')}</div>
        <div className="flex w-6 shrink-0 flex-col gap-1.5 border-l border-white/15 pl-1">
          {Array.from({ length: 4 }, (_, i) => <span key={i} className="h-1.5 w-1.5 rounded-full bg-cyan-400/60" />)}
        </div>
        <div className="flex flex-1 flex-col gap-1 pt-0.5">
          {Array.from({ length: 5 }, (_, i) => <span key={i} className="h-[3px] rounded-[1px] bg-white/15" />)}
        </div>
      </>)
    case 'ui-9': // tiles as navigation
      return frame('bg-[#f5f6f8]', <>
        <div className="grid flex-1 grid-cols-3 grid-rows-2 gap-1">
          <span className="col-span-2 rounded-md bg-blue-600/15" />
          <span className="rounded-md bg-teal-600/15" />
          <span className="rounded-md bg-orange-500/15" />
          <span className="rounded-md bg-violet-600/15" />
          <span className="rounded-md bg-white shadow-sm" />
        </div>
      </>)

    /* UI-11 to UI-15 wireframe the PAGE, not the chrome: for these ten the
       skeleton is the identity, so that is what the preview has to show. */
    case 'ui-10': // dense matrix
      return frame('bg-[#f2f4f7]', <>
        <div className="grid flex-1 grid-cols-6 grid-rows-4 gap-[3px]">
          {Array.from({ length: 24 }, (_, i) => (
            <span key={i} className={cx('rounded-[1px]', i === 6 || i === 7 ? 'bg-sky-600/30' : 'bg-foreground/10')} />
          ))}
        </div>
      </>)
    case 'ui-11': // triptych
      return frame('bg-white', <>
        <span className="w-[18%] rounded-sm bg-foreground/10" />
        <span className="flex-1 rounded-sm bg-orange-500/20" />
        <span className="w-[25%] rounded-sm bg-foreground/10" />
      </>)
    case 'ui-12': // full-screen stage
      return frame('bg-[#0e0e10] flex-col items-center justify-center gap-2', <>
        <span className="h-5 w-1/3 rounded-[2px] bg-amber-400/80" />
        <span className="h-6 w-4/5 rounded-sm bg-white/15" />
      </>)
    case 'ui-13': // terraces
      return frame('bg-[#faf3e9] flex-col gap-1', <>
        <span className="h-6 rounded-sm bg-orange-700/25" />
        <span className="h-2.5 rounded-sm bg-foreground/10" />
        <span className="h-2.5 rounded-sm bg-foreground/10" />
        <span className="h-2.5 rounded-sm bg-foreground/10" />
      </>)
    case 'ui-14': // event spine
      return frame('bg-[#14122a]', <>
        <div className="flex flex-1 flex-col items-end justify-around gap-1 pr-1">
          {Array.from({ length: 3 }, (_, i) => <span key={i} className="h-1.5 w-8 rounded-[1px] bg-white/25" />)}
        </div>
        <div className="relative flex w-3 justify-center">
          <span className="absolute inset-y-0 w-px bg-white/25" />
          {[15, 50, 85].map((t) => (
            <span key={t} className="absolute h-2 w-2 rounded-full bg-violet-400" style={{ top: `${t}%` }} />
          ))}
        </div>
        <div className="flex flex-1 flex-col justify-around gap-1 pl-1">
          {Array.from({ length: 3 }, (_, i) => <span key={i} className="h-1.5 w-10 rounded-[1px] bg-white/20" />)}
        </div>
      </>)
    default:      // ui-15 adaptive mosaic
      return frame('bg-[#f7f7fb]', <>
        <div className="grid flex-1 grid-cols-4 grid-rows-3 gap-1">
          <span className="col-span-3 row-span-2 rounded-lg bg-fuchsia-600/15" />
          <span className="row-span-2 rounded-lg bg-teal-600/15" />
          <span className="col-span-2 rounded-lg bg-blue-600/15" />
          <span className="rounded-lg bg-orange-500/15" />
          <span className="rounded-lg bg-white shadow-sm" />
        </div>
      </>)
  }
}
