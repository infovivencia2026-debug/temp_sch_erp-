import { useState } from 'react'
import { Check, Moon, Settings2, Sun, Type } from 'lucide-react'
import { Modal, useToast } from '@/components/ui'
import { useApp, FONTS, TEXT_SIZES, CORNERS, BORDERS, SHADOWS, PATTERNS } from '@/hooks/useAppState'
import { cx } from '@/lib/utils'

/* ---------------------------------------------------------------------------
   Appearance settings — one control, present in every interface.

   Typeface, appearance and density are user preferences rather than properties
   of an interface, so they live here and are read through tokens: choosing a
   face applies it across all twenty-one interfaces and all five industries,
   and survives switching between them.
   --------------------------------------------------------------------------- */

export function AppearanceButton({ compact }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Appearance settings"
        aria-label="Appearance settings"
        className={cx('grid place-items-center rounded-lg hover:bg-accent',
          compact ? 'h-9 w-9' : 'p-2.5')}
      >
        <Settings2 className="h-[18px] w-[18px]" />
      </button>
      <AppearanceDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/* A labelled row of options. Extracted because five of them in a row is where
   copy-paste starts drifting — one gains a gap the others do not. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="mb-1.5 text-[11px] muted">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function Chip({ on, onClick, label, children }: {
  on: boolean; onClick: () => void; label: string; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cx('flex min-h-[38px] items-center gap-2 rounded-lg hairline px-2.5 text-[12.5px] transition-colors hover:bg-accent/50',
        on && 'ring-1 ring-primary')}
    >
      {children}
      {label}
      {on && <Check className="h-3.5 w-3.5 text-primary" />}
    </button>
  )
}

const PATTERN_SWATCH: Record<string, React.CSSProperties> = {
  none: {},
  dots: { backgroundImage: 'radial-gradient(currentColor 1px, transparent 1px)', backgroundSize: '5px 5px' },
  grid: { backgroundImage: 'linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)', backgroundSize: '6px 6px' },
  lines: { backgroundImage: 'repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 4px)' },
  noise: { backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='40' height='40' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")" },
}

export function AppearanceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp()
  const toast = useToast()

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Appearance"
      subtitle="Applies to every interface and every industry, and is remembered on this device."
    >
      <section>
        <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold">
          <Type className="h-3.5 w-3.5" /> Typeface
        </p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {FONTS.map((f) => {
            const active = app.font === f.id
            return (
              <button
                key={f.id}
                onClick={() => { app.setFont(f.id); toast({ title: `Typeface set to ${f.name}`, tone: 'success' }) }}
                aria-pressed={active}
                className={cx('rounded-lg hairline p-3 text-left transition-colors hover:bg-accent/50',
                  active && 'ring-1 ring-primary')}
              >
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{f.name}</span>
                  {active && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
                </span>
                {/* the specimen is set in the face it offers, so the choice is
                    made on the thing itself rather than on its name */}
                <span
                  className="mt-2 block text-[19px] leading-tight tracking-[-0.01em]"
                  /* data-font sets --app-font locally, which is the same rule
                     the interface uses. A hand-kept list here drifted the
                     moment fonts were added — every new face previewed as
                     Inter because it fell through the switch. */
                  data-font={f.id}
                  style={{ fontFamily: 'var(--app-font)' }}
                >
                  Aa Bb 12,482 · ₹8.42Cr
                </span>
                <span className="mt-1 block text-[11px] muted">{f.note}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="mt-6 border-t pt-5">
        <p className="mb-2 text-[12px] font-semibold">Appearance</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['light', 'dark'] as const).map((t) => (
            <button
              key={t}
              onClick={() => app.setTheme(t)}
              aria-pressed={app.theme === t}
              className={cx('flex items-center gap-2.5 rounded-lg hairline p-3 text-left text-[13px] transition-colors hover:bg-accent/50',
                app.theme === t && 'ring-1 ring-primary')}
            >
              {t === 'light' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              <span className="capitalize">{t}</span>
              {app.theme === t && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-6 border-t pt-5">
        {/* Size belongs beside the typeface: they are one decision about
            reading, and choosing a face without being able to size it is half
            an answer. The scale multiplies the whole interface, so a heading
            stays a heading against its body. */}
        <p className="mb-2 text-[12px] font-semibold">Text size</p>
        <div className="grid gap-2 sm:grid-cols-4">
          {TEXT_SIZES.map((t) => (
            <button
              key={t.id}
              onClick={() => app.setTextSize(t.id)}
              aria-pressed={app.textSize === t.id}
              title={t.note}
              className={cx('rounded-lg hairline p-3 text-left transition-colors hover:bg-accent/50',
                app.textSize === t.id && 'ring-1 ring-primary')}
            >
              <span className="flex items-center gap-2 text-[13px]">
                {t.name}
                {app.textSize === t.id && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
              </span>
              <span className="mt-1.5 block leading-none" style={{
                fontSize: `${{ small: 12, medium: 14, large: 17, 'x-large': 20 }[t.id]}px`,
              }}>Aa</span>
            </button>
          ))}
        </div>
      </section>

      <section className="mt-6 border-t pt-5">
        <p className="mb-2 text-[12px] font-semibold">Table density</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['comfortable', 'compact'] as const).map((dd) => (
            <button
              key={dd}
              onClick={() => app.setDensity(dd)}
              aria-pressed={app.density === dd}
              className={cx('rounded-lg hairline p-3 text-left text-[13px] transition-colors hover:bg-accent/50',
                app.density === dd && 'ring-1 ring-primary')}
            >
              <span className="flex items-center gap-2">
                <span className="capitalize">{dd}</span>
                {app.density === dd && <Check className="ml-auto h-3.5 w-3.5 text-primary" />}
              </span>
              <span className="mt-2 flex flex-col gap-[3px]">
                {Array.from({ length: 3 }, (_, i) => (
                  <span key={i} className={cx('rounded-[1px] bg-foreground/12', dd === 'compact' ? 'h-1' : 'h-2')} />
                ))}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] muted">
          Some interfaces set their own density when you switch to them; changing it here overrides that.
        </p>
      </section>

      {/* ------------------------------------------------------------- Look */}
      {/* Five dials, each a step from what the interface already draws rather
          than a value of its own. A drawn sample beside every option, because
          "Soft" and "Round" mean nothing until you have seen the difference. */}
      <section className="mt-6 border-t pt-5">
        <p className="mb-2 text-[12px] font-semibold">Look</p>

        <Row label="Corners">
          {CORNERS.map((c) => (
            <Chip key={c.id} on={app.corners === c.id} onClick={() => app.setCorners(c.id)} label={c.name}>
              <span className="block h-4 w-6 border-2 border-current"
                style={{ borderRadius: `${c.scale * 6}px` }} />
            </Chip>
          ))}
        </Row>

        <Row label="Borders">
          {BORDERS.map((b) => (
            <Chip key={b.id} on={app.borders === b.id} onClick={() => app.setBorders(b.id)} label={b.name}>
              <span className="block h-4 w-6 rounded-[3px]"
                style={{ border: `${b.id === 'strong' ? 2 : 1}px solid`,
                  borderColor: b.id === 'none' ? 'transparent'
                    : b.id === 'hairline' ? 'currentColor' : 'currentColor',
                  opacity: b.id === 'hairline' ? 0.4 : 1 }} />
            </Chip>
          ))}
        </Row>

        <Row label="Shadow">
          {SHADOWS.map((sh) => (
            <Chip key={sh.id} on={app.shadows === sh.id} onClick={() => app.setShadows(sh.id)} label={sh.name}>
              <span className="block h-4 w-6 rounded-[3px] bg-[hsl(var(--card))]"
                style={{ boxShadow: { flat: 'none', default: '0 2px 4px -2px currentColor',
                  lifted: '0 5px 8px -4px currentColor', deep: '0 8px 12px -5px currentColor' }[sh.id] }} />
            </Chip>
          ))}
        </Row>

        <Row label="Background pattern">
          {PATTERNS.map((pt) => (
            <Chip key={pt.id} on={app.pattern === pt.id} onClick={() => app.setPattern(pt.id)} label={pt.name}>
              <span className="block h-4 w-6 rounded-[3px] border" style={PATTERN_SWATCH[pt.id]} />
            </Chip>
          ))}
        </Row>

        <Row label="Contrast">
          {(['normal', 'high'] as const).map((c) => (
            <Chip key={c} on={app.contrast === c} onClick={() => app.setContrast(c)}
              label={c === 'normal' ? 'Normal' : 'High'}>
              <span className="block h-4 w-6 rounded-[3px] bg-[hsl(var(--card))]"
                style={{ border: `1px solid currentColor`, opacity: c === 'high' ? 1 : 0.45 }} />
            </Chip>
          ))}
        </Row>

        <p className="mt-3 text-[11px] muted">
          These scale what each interface already draws rather than replacing it, so the
          twenty-one stay as different from each other as they are now. None of them
          changes a size or a position.
        </p>
      </section>
    </Modal>
  )
}

