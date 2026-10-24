import type { Box } from './box'
import type { ImageAsset } from './images'
import type { PaperLang } from './labels'

/* A paper as the server keeps it (question_paper_drafts.doc, and the frozen
   copy on question_papers.doc). The school's name, address and logo are not
   in it: they come from the school's own settings when it is printed, so a
   paper never carries another school's letterhead. */

export interface PaperStyle {
  /** Font ids from lib/fonts.ts, one per script. */
  latinFont: string
  hindiFont: string
  teluguFont: string
  /** Body size in points. */
  fontSize: number
  lineHeight: number
  /** Space between questions in points. */
  questionGap: number
}

export interface PaperDoc {
  examName: string
  className: string
  subject: string
  duration: string
  date: string
  /** Overrides of the default paper style. */
  style?: Partial<PaperStyle>
  /** Language of printed words like "Class", "Max. Marks", "OR". */
  labelLang?: PaperLang
  /** Page columns for the questions (the header always spans the page). */
  pageCols?: 1 | 2
  /** Print each box's second-language version under it. */
  bilingual?: boolean
  /** Target maximum marks (0 = no target). */
  maxMarks?: number
  body: Box
  /** Every picture the paper uses, with the size printing needs. */
  images: Record<string, ImageAsset>
}

/** The letterhead, from the school's settings. */
export interface SchoolHead {
  name: string
  address: string
  /** File id of the school's logo. */
  logo: string
}

export const emptyDoc = (patch: Partial<PaperDoc> = {}): PaperDoc => ({
  examName: '', className: '', subject: '', duration: '', date: '',
  body: { id: crypto.randomUUID(), children: [] }, images: {}, ...patch,
})

/** A stored document, tolerating fields an older version did not write. */
export function readDoc(raw: unknown): PaperDoc {
  const d = (raw ?? {}) as Partial<PaperDoc>
  return {
    ...emptyDoc(),
    ...d,
    body: d.body && Array.isArray(d.body.children) ? d.body : { id: crypto.randomUUID(), children: [] },
    images: d.images ?? {},
  }
}
