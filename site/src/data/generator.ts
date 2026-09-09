import { rng, hashStr, pick, int, inr, fmtDate, dateOffset } from '@/lib/utils'
import { activeIndustry, getActiveIndustryId } from '@/industries'
import {
  FIRST, LAST, DEPARTMENTS, PROGRAMS, COURSES, CAMPUSES, CITIES, SOURCES,
  COMPANIES, VENDORS, ROOMS, CLASSES, SCHOOL_SUBJECTS, SCHOOL_DEPARTMENTS,
  GRADE_LEVELS, CBSE_GRADES,
} from './vocab'

export type Segment = 'higher-ed' | 'k12'

/* The active segment is module state rather than a parameter because every
   call site would otherwise have to thread it through. Changing it remounts
   the page tree (see App.tsx), which re-runs generation. */
let SEGMENT: Segment = 'higher-ed'
export const setSegment = (s: Segment) => { SEGMENT = s }
export const getSegment = () => SEGMENT

const isEducation = () => getActiveIndustryId() === 'education'
const isK12 = () => isEducation() && SEGMENT === 'k12'

/**
 * Word pools for the active vertical. Every industry supplies the same shape,
 * so a column spec written once renders sensible data in all five — and inside
 * education the K-12 segment swaps a second layer of words on top.
 */
const pools = () => {
  const v = activeIndustry().vocab
  if (!isEducation()) return { ...v, level: ['Tier 1', 'Tier 2', 'Tier 3'] }
  return {
    ...v,
    program: isK12() ? CLASSES : PROGRAMS,
    course: isK12() ? SCHOOL_SUBJECTS : COURSES,
    dept: isK12() ? SCHOOL_DEPARTMENTS : DEPARTMENTS,
    grade: isK12() ? CBSE_GRADES : ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D'],
    level: isK12() ? GRADE_LEVELS : ['UG', 'PG', 'Doctoral', 'Diploma'],
  }
}

export type ColType =
  | 'id' | 'code' | 'person' | 'dept' | 'program' | 'course' | 'campus' | 'city'
  | 'company' | 'vendor' | 'room' | 'source' | 'date' | 'datepast' | 'datefuture'
  | 'money' | 'moneysm' | 'int' | 'pct' | 'grade' | 'status' | 'badge' | 'text'
  | 'email' | 'phone' | 'time' | 'rating' | 'sem' | 'batch'

export interface Column {
  key: string
  label: string
  type: ColType
  options?: string[]
  align?: 'left' | 'right'
  filterable?: boolean
}

/** Compact spec: "type:Label@Option A,Option B" — keeps the module registry readable. */
export function parseCols(specs: string[]): Column[] {
  return specs.map((spec) => {
    const [head, opts] = spec.split('@')
    const [type, label] = head.split(':') as [ColType, string]
    const options = opts ? opts.split(',') : undefined
    return {
      key: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, ''),
      label,
      type,
      options,
      align: ['money', 'moneysm', 'int', 'pct', 'rating'].includes(type) ? 'right' : 'left',
      filterable: ['status', 'badge', 'text', 'dept', 'program', 'campus', 'source', 'grade'].includes(type),
    }
  })
}

/**
 * Reference numbers read better when they carry the document they belong to:
 * a work order is WO-02831, not REC-02831. Derived from the column label, with
 * the noise words ("No", "ID", "Ref") dropped first.
 */
const NOISE = /^(no|number|id|ref|code)$/i
function refPrefix(label: string, fallback: string) {
  const words = label.split(/[^A-Za-z]+/).filter((w) => w && !NOISE.test(w))
  if (!words.length) return fallback
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  return words.map((w) => w[0]).join('').slice(0, 3).toUpperCase()
}

export function personName(r: () => number) {
  return `${pick(r, FIRST)} ${pick(r, LAST)}`
}

function valueFor(c: Column, r: () => number, i: number, salt: number): string | number {
  switch (c.type) {
    case 'id': return `${refPrefix(c.label, 'REC')}-${String(2600 + salt % 400 + i).padStart(5, '0')}`
    case 'code': return `${refPrefix(c.label, 'CD').slice(0, 2)}-${String.fromCharCode(65 + (salt + i) % 26)}${int(r, 100, 899)}`
    case 'person': return personName(r)
    case 'dept': return pick(r, pools().dept)
    case 'program': return pick(r, pools().program)
    case 'course': return pick(r, pools().course)
    case 'campus': return pick(r, isEducation() ? CAMPUSES : pools().campus)
    case 'city': return pick(r, CITIES)
    case 'company': return pick(r, pools().company)
    case 'vendor': return pick(r, pools().vendor)
    case 'room': return pick(r, isEducation() ? ROOMS : pools().room)
    case 'source': return pick(r, pools().source)
    case 'date': return fmtDate(dateOffset(int(r, -120, 60)))
    case 'datepast': return fmtDate(dateOffset(-int(r, 1, 400)))
    case 'datefuture': return fmtDate(dateOffset(int(r, 1, 120)))
    case 'money': return inr(int(r, 12, 900) * 1000)
    case 'moneysm': return inr(int(r, 2, 90) * 100)
    case 'int': return int(r, 1, 480)
    case 'pct': return `${int(r, 58, 99)}%`
    case 'grade': return pick(r, pools().grade)
    case 'rating': return `${(3 + r() * 2).toFixed(1)}`
    case 'sem':
      if (!isEducation()) return pick(r, pools().sem)
      return isK12() ? `Term ${int(r, 1, 3)}` : `Semester ${int(r, 1, 8)}`
    case 'batch':
      if (!isEducation()) return `${pick(r, pools().batch)} · ${2026 + int(r, 0, 1)}`
      return isK12()
        ? `${pick(r, CLASSES)} · ${2026 + int(r, 0, 1)}–${2027 + int(r, 0, 1)}`
        : `${2022 + int(r, 0, 3)}–${2026 + int(r, 0, 3)} · Sec ${pick(r, ['A', 'B', 'C', 'D'])}`
    case 'time': return `${String(int(r, 8, 18)).padStart(2, '0')}:${pick(r, ['00', '15', '30', '45'])}`
    case 'email': {
      const n = personName(r).toLowerCase().replace(/\s/g, '.')
      return `${n}@${pools().domain}`
    }
    case 'phone': return `+91 ${int(r, 70, 99)}${int(r, 10000, 99999)}${int(r, 100, 999)}`
    case 'status':
    case 'badge':
    case 'text':
      return pick(r, c.options && c.options.length ? c.options : ['Active', 'Inactive'])
    default: return '—'
  }
}

export interface Row { _id: string; [k: string]: any }

/** Deterministic per (seedKey, columns) so the same tab always shows the same records. */
export function makeRows(seedKey: string, cols: Column[], count: number): Row[] {
  const base = hashStr(`${getActiveIndustryId()}:${SEGMENT}:${seedKey}`)
  const rows: Row[] = []
  for (let i = 0; i < count; i++) {
    const r = rng(base + i * 7919)
    const row: Row = { _id: `${seedKey}-${i}` }
    cols.forEach((c) => { row[c.key] = valueFor(c, r, i, base % 1000) })
    rows.push(row)
  }
  return rows
}

export function toneFor(value: string): 'green' | 'amber' | 'red' | 'blue' | 'slate' {
  const v = value.toLowerCase()
  if (/(active|paid|approved|completed|resolved|present|connected|published|hired|passed|verified|issued|available|granted|open position|success|delivered|allotted|in stock|cleared)/.test(v)) return 'green'
  if (/(pending|in progress|partial|late|review|draft|processing|shortlisted|reserved|scheduled|on hold|renewal|low stock|maintenance|waitlist|due)/.test(v)) return 'amber'
  if (/(overdue|rejected|absent|failed|suspended|critical|high|disconnected|cancelled|expired|blocked|defaulter|out of stock|breach|escalated|dropped)/.test(v)) return 'red'
  if (/(inactive|archived|closed|alumni|graduated|withdrawn|na|n\/a)/.test(v)) return 'slate'
  return 'blue'
}
