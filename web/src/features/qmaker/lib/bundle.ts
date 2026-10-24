import type { Box } from './box'
import { marksOf, walkBoxes } from './box'
import { readDoc, type PaperDoc } from './doc'
import { collectImageIds, imageBytes, uploadImage, type ImageAsset } from './images'
import { legacyToHtml, paperToBox, questionToBox, type OldPaper, type Question, type Template } from './legacy'
import type { PaperLang } from './labels'
import { richPlain } from './richdoc'

/* .qbank and .qpaper: the share files of the desktop QMaker, small enough to
   send on WhatsApp. They carry their pictures inside (data: URLs), so a file
   opens on any computer. Reading one here uploads each picture once and points
   the boxes at the uploaded copies; writing one does the reverse, so a file
   made here opens in the desktop app too. */

interface EmbeddedImage { id: string; w: number; h: number; name?: string; src?: string }

interface Bundle {
  format: 'qmaker'
  kind: 'bank' | 'paper'
  version: 1
  exportedAt: number
  templates: Template[]
  questions: Question[]
  papers: (Partial<OldPaper> & { body?: Box; style?: PaperDoc['style']; labelLang?: PaperLang; pageCols?: 1 | 2; bilingual?: boolean; maxMarks?: number })[]
  images?: Record<string, EmbeddedImage>
  library?: Box[]
}

export function parseBundle(text: string): Bundle {
  let data: Partial<Bundle>
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('This file is damaged or is not a QMaker file.')
  }
  if (data.format !== 'qmaker' || !Array.isArray(data.questions) || !Array.isArray(data.templates) || !Array.isArray(data.papers)) {
    throw new Error('This file is not a QMaker file.')
  }
  if ((data.version ?? 0) > 1) throw new Error('This file was made with a newer QMaker than this one can read.')
  return data as Bundle
}

/** What a file holds, as boxes, before anything is saved. */
export interface Received {
  kind: 'bank' | 'paper'
  /** Banked questions (the desktop library, and older bank questions converted). */
  questions: Box[]
  papers: PaperDoc[]
  images: Record<string, EmbeddedImage>
}

export function readBundle(b: Bundle): Received {
  const fromOld = b.questions.flatMap((q) => questionToBox(q, b.templates) ?? [])
  const known = new Set(fromOld.map((x) => x.id))
  const questions = [...(b.library ?? []).filter((x) => !known.has(x.id)), ...fromOld]
  const papers = b.papers.map((p) => readDoc({
    examName: p.examName ?? '', className: p.className ?? '', subject: p.subject ?? '', duration: p.duration ?? '', date: p.date ?? '',
    style: p.style, labelLang: p.labelLang, pageCols: p.pageCols, bilingual: p.bilingual, maxMarks: p.maxMarks,
    body: p.body ?? paperToBox(p as OldPaper, b.questions, b.templates),
    images: {},
  }))
  return { kind: b.kind, questions, papers, images: b.images ?? {} }
}

const dataUrlBlob = (src: string) => {
  const [head, data] = src.split(',')
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png'
  return new Blob([Uint8Array.from(atob(data ?? ''), (c) => c.charCodeAt(0))], { type: mime })
}

/* Uploads every picture the boxes use and rewrites their ids. A picture the
   file names but does not carry is left out of the text rather than shown
   broken. `onProgress` reports pictures done of total. */
export async function uploadBundleImages(boxes: Box[], images: Record<string, EmbeddedImage>, onProgress?: (done: number, total: number) => void) {
  const used = [...collectImageIds(boxes)].filter((id) => images[id]?.src)
  const map = new Map<string, ImageAsset>()
  for (const [i, id] of used.entries()) {
    const a = images[id]
    map.set(id, await uploadImage(dataUrlBlob(a.src!), a.name || 'Picture'))
    onProgress?.(i + 1, used.length)
  }
  const rewrite = (s: string) => s.replace(/<img\b[^>]*data-id="([A-Za-z0-9-]+)"[^>]*>/g, (tag, id) => {
    const to = map.get(id)
    return to ? tag.replace(`data-id="${id}"`, `data-id="${to.id}"`) : ''
  })
  const fix = (b: Box): Box => ({
    ...b,
    content: b.content === undefined ? undefined : rewrite(legacyToHtml(b.content)),
    content2: b.content2 === undefined ? undefined : rewrite(legacyToHtml(b.content2)),
    children: b.children?.map(fix),
  })
  const assets: Record<string, ImageAsset> = {}
  for (const a of map.values()) assets[a.id] = a
  return { boxes: boxes.map(fix), images: assets }
}

// ---------- the bank's fields for a banked box ----------

const allText = (b: Box): string => [b.content ? richPlain(b.content) : '', ...(b.children ?? []).filter((c) => c.visible !== 'key').map(allText)].join(' ').replace(/\s+/g, ' ').trim()

/* The plain stem the bank searches and online tests read, and the kind it is
   filed under. A box with lettered options and one marked correct is
   multiple choice and carries those options; anything else is a written
   answer, short up to 3 marks and long above. */
export function bankFields(b: Box) {
  let options: { body: string; is_correct: boolean }[] = []
  walkBoxes(b, (x) => {
    if (options.length || !x.children?.length) return
    const opts = x.children.filter((c) => c.number?.format === 'a' && c.content !== undefined && !c.children?.length)
    if (opts.length >= 2 && opts.length === x.children.length && opts.some((c) => c.correct)) {
      options = opts.map((c) => ({ body: richPlain(c.content ?? ''), is_correct: !!c.correct }))
    }
  })
  const stemOf = (x: Box): string => [x.content ? richPlain(x.content) : '', ...(x.children ?? []).filter((c) => c.visible !== 'key' && !(options.length && c.name === 'Options')).map(stemOf)].join(' ').replace(/\s+/g, ' ').trim()
  const marks = marksOf(b) || 1
  const mcq = options.length >= 2 && options.every((o) => o.body !== '')
  return {
    stem: (mcq ? stemOf(b) : allText(b)).slice(0, 4000) || b.name || 'Question',
    kind: mcq ? 'mcq' : marks <= 3 ? 'short' : 'long',
    options: mcq ? options : [],
    default_marks: marks,
    difficulty: b.meta?.difficulty ?? 'medium',
    chapter: b.meta?.chapter ?? '',
  }
}

// ---------- writing a file ----------

async function embed(ids: Iterable<string>, images: Record<string, ImageAsset>): Promise<Record<string, EmbeddedImage>> {
  const out: Record<string, EmbeddedImage> = {}
  for (const id of ids) {
    const a = images[id]
    if (!a) continue
    try {
      const bytes = await imageBytes(a)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      const mime = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg'
      out[id] = { id, w: a.w, h: a.h, name: a.name, src: `data:${mime};base64,${btoa(bin)}` }
    } catch {
      // A picture that will not load is left out rather than failing the whole file.
    }
  }
  return out
}

const now = () => Date.now()

export async function paperFile(doc: PaperDoc): Promise<string> {
  const paper = {
    id: crypto.randomUUID(), examName: doc.examName, subject: doc.subject, className: doc.className, duration: doc.duration, date: doc.date,
    instructions: '', answerSpace: true, sections: [], body: doc.body, style: doc.style, labelLang: doc.labelLang, pageCols: doc.pageCols,
    bilingual: doc.bilingual, maxMarks: doc.maxMarks, createdAt: now(), updatedAt: now(),
  }
  const bundle: Bundle = { format: 'qmaker', kind: 'paper', version: 1, exportedAt: now(), templates: [], questions: [], papers: [paper], images: await embed(collectImageIds(doc.body), doc.images) }
  return JSON.stringify(bundle)
}

export async function bankFile(boxes: Box[], images: Record<string, ImageAsset>): Promise<string> {
  const library = boxes.map((b) => ({ ...b, updatedAt: b.updatedAt ?? now() }))
  const bundle: Bundle = { format: 'qmaker', kind: 'bank', version: 1, exportedAt: now(), templates: [], questions: [], papers: [], library, images: await embed(collectImageIds(library), images) }
  return JSON.stringify(bundle)
}
