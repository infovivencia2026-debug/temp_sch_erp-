import { Field, Input } from '@/components/ui'
import { PickerMenu } from '@/components/PickerMenu'
import { HINDI_FONTS, LATIN_FONTS, TELUGU_FONTS, type FontChoice } from '../lib/fonts'
import type { PaperStyle } from '../lib/doc'

const SAMPLES = { latin: 'Answer all questions', hindi: 'प्रश्न का उत्तर लिखिए', telugu: 'ప్రశ్నకు జవాబు రాయండి' }

function FontPick({ label, list, value, sample, onChange }: { label: string; list: FontChoice[]; value: string; sample: string; onChange: (id: string) => void }) {
  return (
    <Field label={label} hint={sample}>
      <PickerMenu
        ariaLabel={label}
        value={value}
        onChange={onChange}
        options={list.map((f) => ({ value: f.id, label: f.label, style: { fontFamily: `'${f.css}'` } }))}
        className="w-full"
      />
    </Field>
  )
}

const clamp = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Number(v) || min))

/** Fonts for each script, size and spacing. The sheet shows each change at once. */
export default function StyleEditor({ value, onChange }: { value: PaperStyle; onChange: (patch: Partial<PaperStyle>) => void }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Field label="Size (pt)"><Input type="number" min={9} max={16} value={String(value.fontSize)} onChange={(v) => onChange({ fontSize: clamp(v, 9, 16) })} /></Field>
        <Field label="Line spacing"><Input type="number" min={1.1} max={2.2} value={String(value.lineHeight)} onChange={(v) => onChange({ lineHeight: clamp(v, 1.1, 2.2) })} /></Field>
        <Field label="Gap (pt)"><Input type="number" min={0} max={24} value={String(value.questionGap)} onChange={(v) => onChange({ questionGap: clamp(v, 0, 24) })} /></Field>
      </div>
      <FontPick label="English" list={LATIN_FONTS} value={value.latinFont} sample={SAMPLES.latin} onChange={(id) => onChange({ latinFont: id })} />
      <FontPick label="Hindi" list={HINDI_FONTS} value={value.hindiFont} sample={SAMPLES.hindi} onChange={(id) => onChange({ hindiFont: id })} />
      <FontPick label="Telugu" list={TELUGU_FONTS} value={value.teluguFont} sample={SAMPLES.telugu} onChange={(id) => onChange({ teluguFont: id })} />
      <p className="text-[12px] text-muted-foreground">Printing uses these fonts exactly. A Word file uses Nirmala UI for Hindi and Telugu, so it opens correctly on any Windows computer.</p>
    </div>
  )
}
