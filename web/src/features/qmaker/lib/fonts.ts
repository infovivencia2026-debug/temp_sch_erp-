import type { PaperStyle } from './doc'

export interface FontChoice {
  id: string
  label: string
  /** CSS family, bundled with the app (used for preview and PDF). */
  css: string
  /** Font Word uses. Only fonts that ship with every Windows PC, so .docx opens correctly anywhere. */
  word: string
}

export const LATIN_FONTS: FontChoice[] = [
  { id: 'noto-serif', label: 'Noto Serif', css: 'Noto Serif', word: 'Cambria' },
  { id: 'tinos', label: 'Times style (Tinos)', css: 'Tinos', word: 'Times New Roman' },
  { id: 'arimo', label: 'Arial style (Arimo)', css: 'Arimo', word: 'Arial' },
  { id: 'noto-sans', label: 'Noto Sans', css: 'Noto Sans', word: 'Calibri' },
]

// Word always uses Nirmala UI for Indic scripts: it is the only Hindi/Telugu font guaranteed on Windows 8+.
export const HINDI_FONTS: FontChoice[] = [
  { id: 'noto-serif-devanagari', label: 'Noto Serif Devanagari', css: 'Noto Serif Devanagari', word: 'Nirmala UI' },
  { id: 'noto-sans-devanagari', label: 'Noto Sans Devanagari', css: 'Noto Sans Devanagari', word: 'Nirmala UI' },
  { id: 'tiro-devanagari-hindi', label: 'Tiro Devanagari Hindi', css: 'Tiro Devanagari Hindi', word: 'Nirmala UI' },
  { id: 'mukta', label: 'Mukta', css: 'Mukta', word: 'Nirmala UI' },
  { id: 'hind', label: 'Hind', css: 'Hind', word: 'Nirmala UI' },
]

export const TELUGU_FONTS: FontChoice[] = [
  { id: 'noto-serif-telugu', label: 'Noto Serif Telugu', css: 'Noto Serif Telugu', word: 'Nirmala UI' },
  { id: 'noto-sans-telugu', label: 'Noto Sans Telugu', css: 'Noto Sans Telugu', word: 'Nirmala UI' },
  { id: 'tiro-telugu', label: 'Tiro Telugu', css: 'Tiro Telugu', word: 'Nirmala UI' },
  { id: 'mandali', label: 'Mandali', css: 'Mandali', word: 'Nirmala UI' },
  { id: 'ntr', label: 'NTR', css: 'NTR', word: 'Nirmala UI' },
  { id: 'suranna', label: 'Suranna', css: 'Suranna', word: 'Nirmala UI' },
]

export const DEFAULT_STYLE: PaperStyle = {
  latinFont: 'noto-serif', hindiFont: 'noto-serif-devanagari', teluguFont: 'noto-serif-telugu',
  fontSize: 12, lineHeight: 1.45, questionGap: 6,
}

const find = (list: FontChoice[], id: string) => list.find((f) => f.id === id) ?? list[0]

export function effectiveStyle(base: Partial<PaperStyle> | undefined, override?: Partial<PaperStyle>): PaperStyle {
  return { ...DEFAULT_STYLE, ...base, ...override }
}

/** Latin first so English text never picks up an Indic font's Latin glyphs. */
export function fontStack(s: PaperStyle) {
  return [find(LATIN_FONTS, s.latinFont), find(HINDI_FONTS, s.hindiFont), find(TELUGU_FONTS, s.teluguFont)]
    .map((f) => `'${f.css}'`)
    .join(', ') + ', serif'
}

export const wordLatinFont = (s: PaperStyle) => find(LATIN_FONTS, s.latinFont).word

/** Inline CSS for the paper root; every size in PAPER_CSS derives from --fs. */
export function styleVars(s: PaperStyle) {
  return `font-family: ${fontStack(s)}; --fs: ${s.fontSize}pt; --lh: ${s.lineHeight}; --gap: ${s.questionGap}pt;`
}
