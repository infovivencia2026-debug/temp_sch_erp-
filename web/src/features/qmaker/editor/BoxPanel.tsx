import type { ReactNode } from 'react'
import { Checkbox, Field, Input, SEG_BAR, Switch, segClass } from '@/components/ui'
import { marksOf, type Box, type BoxLayout, type BoxMarks, type BoxNumber, type BoxStyle, type NumberFormat } from '../lib/box'

/** A short row of mutually exclusive choices, in the shared segmented style. */
export function Choice<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className={`${SEG_BAR} flex-wrap`}>
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={segClass(value === v)} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="qm-panel">
      <h3 className="qm-panel-h">{title}</h3>
      {children}
    </section>
  )
}

/** A switch that opens its own settings underneath when on. */
function Toggle({ on, label, onChange, children }: { on: boolean; label: string; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13.5px] font-medium">{label}</span>
        <Switch on={on} onChange={onChange} label={label} />
      </div>
      {on && children && <div className="space-y-3">{children}</div>}
    </div>
  )
}

const NUMBER_PATTERNS = ['{n}.', '({n})', '{n})', 'Q{n}.', 'Q.{n}', '[{n}]']
const MARK_PATTERNS: [string, string][] = [['[{m}]', '[2]'], ['({m})', '(2)'], ['{m} Marks', '2 Marks'], ['{k} × {e} = {m}', '5 × 2 = 10'], ['{m}', '2']]
const num = (v: string) => (v.trim() === '' ? undefined : Number(v))

/** Every setting a box has. None of them is specific to one kind of question. */
export default function BoxPanel({ b, update }: { b: Box; update: (patch: Partial<Box>) => void }) {
  const setNumber = (p: Partial<BoxNumber>) => update({ number: { format: '1', pattern: '{n}.', scope: 'local', ...b.number, ...p } })
  const setMarks = (p: Partial<BoxMarks>) => update({ marks: { mode: 'fixed', show: true, value: 1, ...b.marks, ...p } })
  const setLayout = (p: Partial<BoxLayout>) => update({ layout: { mode: 'stack', ...b.layout, ...p } })
  const setStyle = (p: Partial<BoxStyle>) => update({ style: { ...b.style, ...p } })
  const s = b.style ?? {}
  const sample = b.number?.format === 'a' ? 'a' : b.number?.format === 'A' ? 'A' : b.number?.format === 'i' ? 'i' : b.number?.format === 'I' ? 'I' : '1'

  return (
    <div className="space-y-4">
      <Group title="This box">
        <Field label="Name" hint="Shown in the bank and on this bar; not printed.">
          <Input value={b.name ?? ''} placeholder="Question, Section, Options" onChange={(v) => update({ name: v || undefined })} />
        </Field>
        <Toggle on={b.content !== undefined} label="Has its own text" onChange={(v) => update({ content: v ? '' : undefined, content2: v ? b.content2 : undefined })} />
      </Group>

      <Group title="Numbering">
        <Toggle on={!!b.number} label="Numbered" onChange={(v) => update({ number: v ? { format: '1', pattern: '{n}.', scope: 'local' } : undefined })}>
          <Choice label="Number style" value={b.number?.format ?? '1'} onChange={(v: NumberFormat) => setNumber({ format: v })} options={[['1', '1 2 3'], ['a', 'a b c'], ['A', 'A B C'], ['i', 'i ii iii'], ['I', 'I II III']]} />
          <Choice label="Printed as" value={b.number?.pattern ?? '{n}.'} onChange={(v) => setNumber({ pattern: v })} options={NUMBER_PATTERNS.map((p) => [p, p.replace('{n}', sample)] as [string, string])} />
          <Choice label="Counting" value={b.number?.scope ?? 'local'} onChange={(v) => setNumber({ scope: v, counter: v === 'paper' ? b.number?.counter || 'q' : undefined })} options={[['local', 'Restart in each box'], ['paper', 'Run through the paper']]} />
          {b.number?.scope === 'paper' && (
            <Field label="Counter name" hint="Boxes with the same name count together.">
              <Input value={b.number.counter ?? ''} onChange={(v) => setNumber({ counter: v || undefined })} />
            </Field>
          )}
        </Toggle>
      </Group>

      <Group title="Marks">
        <Toggle on={!!b.marks} label="Carries marks" onChange={(v) => update({ marks: v ? { mode: 'fixed', value: 1, show: true, pattern: '[{m}]' } : undefined })}>
          <Choice label="How the marks are worked out" value={b.marks?.mode ?? 'fixed'} onChange={(v) => setMarks({ mode: v })} options={[['fixed', 'This many'], ['sum', 'Add up inside'], ['best', 'Best N inside']]} />
          {b.marks?.mode === 'fixed' && <Field label="Marks"><Input type="number" min={0} value={String(b.marks.value ?? 0)} onChange={(v) => setMarks({ value: Math.max(0, Number(v) || 0) })} /></Field>}
          {b.marks?.mode === 'best' && <Field label="Count only the best" hint="Answer any N of the boxes inside."><Input type="number" min={1} value={String(b.marks.best ?? 1)} onChange={(v) => setMarks({ best: Math.max(1, Number(v) || 1) })} /></Field>}
          <p className="text-[12px] text-muted-foreground">Worth {marksOf(b)} marks.</p>
          <Checkbox checked={b.marks?.show ?? true} onChange={(v) => setMarks({ show: v })} label="Print the marks on the right" />
          {b.marks?.show && <Choice label="Marks printed as" value={b.marks.pattern ?? '[{m}]'} onChange={(v) => setMarks({ pattern: v })} options={MARK_PATTERNS} />}
        </Toggle>
      </Group>

      <Group title="Inside this box">
        <Choice label="Arrangement" value={b.layout?.mode ?? 'stack'} onChange={(v) => setLayout({ mode: v })} options={[['stack', 'One below another'], ['grid', 'Side by side']]} />
        {b.layout?.mode === 'grid' && (
          <>
            <Choice label="Columns" value={b.layout.cols ?? 0} onChange={(v) => setLayout({ cols: v || undefined, widths: undefined })} options={[[0, 'All in a row'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']]} />
            <Field label="Column widths in %" hint="Optional, for example 30, 70. Equal when empty.">
              <Input value={b.layout.widths?.join(', ') ?? ''} placeholder="Equal" onChange={(v) => {
                const w = v.split(/[,\s]+/).map(Number).filter((x) => x > 0)
                setLayout({ widths: w.length ? w : undefined })
              }} />
            </Field>
            <Choice label="Fill order" value={b.layout.order ?? 'across'} onChange={(v) => setLayout({ order: v })} options={[['across', 'Across, a b then c d'], ['down', 'Down, a c then b d']]} />
            <Field label="Gap (mm)"><Input type="number" min={0} max={30} value={b.layout.gapMm == null ? '' : String(b.layout.gapMm)} placeholder="Automatic" onChange={(v) => setLayout({ gapMm: num(v) })} /></Field>
          </>
        )}
        <Checkbox checked={!!b.choice} onChange={(v) => update({ choice: v || undefined })} label='Choice: print "OR" between the boxes inside' />
        <Checkbox checked={!!b.shuffle} onChange={(v) => update({ shuffle: v || undefined })} label="Shuffle them on the paper" hint="The answer key keeps this order." />
      </Group>

      <Group title="Look">
        <Checkbox checked={!!s.rule} onChange={(v) => setStyle({ rule: v || undefined })} label="Heading, with a line under it" />
        <Checkbox checked={!!s.border} onChange={(v) => setStyle({ border: v || undefined })} label="Border" />
        <Checkbox checked={!!s.bold} onChange={(v) => setStyle({ bold: v || undefined })} label="Bold text" />
        <Checkbox checked={!!s.italic} onChange={(v) => setStyle({ italic: v || undefined })} label="Italic text" />
        <Checkbox checked={!!s.pageBreak} onChange={(v) => setStyle({ pageBreak: v || undefined })} label="Start on a new page" />
        <Choice label="Align text" value={s.align ?? 'left'} onChange={(v) => setStyle({ align: v === 'left' ? undefined : v })} options={[['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Text size %"><Input type="number" min={50} max={250} value={String(Math.round((s.scale ?? 1) * 100))} onChange={(v) => { const x = (Number(v) || 100) / 100; setStyle({ scale: x === 1 ? undefined : x }) }} /></Field>
          <Field label="Padding (mm)"><Input type="number" min={0} max={20} value={String(s.paddingMm ?? 0)} onChange={(v) => setStyle({ paddingMm: Number(v) || undefined })} /></Field>
        </div>
        <Field label="Space above (pt)"><Input type="number" min={0} max={72} value={String(s.spaceBefore ?? 0)} onChange={(v) => setStyle({ spaceBefore: Number(v) || undefined })} /></Field>
      </Group>

      <Group title="Paper and answer key">
        <Choice label="Printed on" value={b.visible ?? 'both'} onChange={(v) => update({ visible: v === 'both' ? undefined : v })} options={[['both', 'Both'], ['paper', 'Paper only'], ['key', 'Answer key only']]} />
        <Checkbox checked={!!b.correct} onChange={(v) => update({ correct: v || undefined })} label="Correct answer" hint="Bold and underlined in the answer key." />
      </Group>

      <Group title="For the bank and the marks split">
        <Field label="Chapter"><Input value={b.meta?.chapter ?? ''} onChange={(v) => update({ meta: { ...b.meta, chapter: v || undefined } })} /></Field>
        <Choice label="Difficulty" value={b.meta?.difficulty ?? ''} onChange={(v) => update({ meta: { ...b.meta, difficulty: (v || undefined) as never } })} options={[['', 'Not set'], ['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']]} />
      </Group>
    </div>
  )
}
