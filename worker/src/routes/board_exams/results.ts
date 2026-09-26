/* The board's result file: parsing and reconciliation, ported from
   parseBoardResultCSV, matchBoardLines, boardKeyOf and boardNameKey in
   internal/api/board_exams.go. Pure functions; nothing here touches D1. */

export interface ResultLine {
  id?: string
  line_no: number
  hall_ticket_no: string
  registration_no: string
  candidate_name: string
  student_id: string
  school_record_name: string
  admission_no: string
  match_method: string
  result: string
  total_marks: number | null
  max_marks: number | null
  percent: number | null
  /** JSON text of [{subject, marks}]. */
  subjects: string
  registration_id: string | null
  raw: Record<string, string>
}

export interface CandidateKey {
  registration_id: string
  student_id: string
  admission_no: string
  name: string
  class_name: string
  hall_ticket_no: string | null
  registration_no: string | null
  status: string
  used: boolean
}

/** round1 keeps a computed figure to one decimal place (math.Round, not truncation). */
export const round1 = (v: number) => Math.round(v * 10) / 10

/** The JSON shape of a boardResultLine with its omitempty fields left out. */
export function lineJSON(l: ResultLine): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  if (l.id) o.id = l.id
  o.line_no = l.line_no
  o.hall_ticket_no = l.hall_ticket_no
  o.registration_no = l.registration_no
  o.candidate_name = l.candidate_name
  if (l.student_id) o.student_id = l.student_id
  if (l.school_record_name) o.school_record_name = l.school_record_name
  if (l.admission_no) o.admission_no = l.admission_no
  o.match_method = l.match_method
  o.result = l.result
  if (l.total_marks !== null) o.total_marks = l.total_marks
  if (l.max_marks !== null) o.max_marks = l.max_marks
  if (l.percent !== null) o.percent = l.percent
  if (l.subjects) o.subjects = JSON.parse(l.subjects)
  return o
}

export function percentOf(total: number | null, max: number | null): number | null {
  return total !== null && max !== null && max > 0 ? round1((100 * total) / max) : null
}

// ---------------------------------------------------------------- matching

/** Normalises an identifier: whitespace out, upper case. */
export const boardKeyOf = (v: string) => v.split(/\s+/).join('').toUpperCase()

/** Normalises a candidate's name: case, punctuation and the dots of initials. */
export function boardNameKey(v: string): string {
  const kept = v.toUpperCase().replace(/[^A-Z0-9 ]/g, '')
  return kept.split(/ +/).filter(Boolean).join(' ')
}

/** Attaches each line to at most one candidate: hall ticket, then registration number, then an unambiguous name. */
export function matchBoardLines(lines: ResultLine[], candidates: CandidateKey[]): void {
  const byTicket = new Map<string, CandidateKey>()
  const byReg = new Map<string, CandidateKey>()
  const byName = new Map<string, CandidateKey[]>()
  for (const c of candidates) {
    if (c.hall_ticket_no !== null) byTicket.set(boardKeyOf(c.hall_ticket_no), c)
    if (c.registration_no !== null) byReg.set(boardKeyOf(c.registration_no), c)
    const n = boardNameKey(c.name)
    byName.set(n, [...(byName.get(n) ?? []), c])
  }
  const claim = (c: CandidateKey | undefined, l: ResultLine, how: string): boolean => {
    if (!c || c.used) return false
    c.used = true
    l.student_id = c.student_id
    l.school_record_name = c.name
    l.admission_no = c.admission_no
    l.match_method = how
    l.registration_id = c.registration_id
    return true
  }
  for (const l of lines) {
    if (l.hall_ticket_no && claim(byTicket.get(boardKeyOf(l.hall_ticket_no)), l, 'hall_ticket')) continue
    if (l.registration_no && claim(byReg.get(boardKeyOf(l.registration_no)), l, 'registration_no')) continue
    const hits = byName.get(boardNameKey(l.candidate_name)) ?? []
    if (hits.length === 1 && claim(hits[0], l, 'name')) continue
    l.match_method = 'unmatched'
  }
}

// ---------------------------------------------------------------- csv

/** Port of parseBoardResultCSV. Throws an Error whose message is the 400 text. */
export function parseBoardResultCSV(text: string): ResultLine[] {
  const records = readCSV(text)
  if (records.length === 0) throw new Error("could not read the file's header row")
  const header = records[0].rec
  const canon = header.map(boardResultColumn)
  if (!canon.some((c) => c !== '')) {
    throw new Error('none of the columns could be recognised. The file needs at least a hall ' +
      'ticket number, a registration number or a candidate name')
  }
  const out: ResultLine[] = []
  for (let i = 1; i < records.length; i++) {
    // Numbered as encoding/csv reads: one per record, blank lines skipped, header is 1.
    const { rec, error } = records[i]
    const line = i + 1
    if (error) throw new Error(`line ${line} could not be read: ${error}`)
    const l: ResultLine = {
      line_no: line, hall_ticket_no: '', registration_no: '', candidate_name: '', student_id: '',
      school_record_name: '', admission_no: '', match_method: '', result: '', total_marks: null, max_marks: null,
      percent: null, subjects: '[]', registration_id: null, raw: {},
    }
    const subjects: { subject: string; marks: number }[] = []
    for (let j = 0; j < rec.length && j < header.length; j++) {
      const cell = rec[j].trim()
      const name = header[j].trim()
      l.raw[name] = cell
      switch (canon[j]) {
        case 'hall_ticket_no': l.hall_ticket_no = cell; break
        case 'registration_no': l.registration_no = cell; break
        case 'candidate_name': l.candidate_name = cell; break
        case 'result': l.result = boardResultWord(cell); break
        case 'total_marks': l.total_marks = parseNumber(cell); break
        case 'max_marks': l.max_marks = parseNumber(cell); break
        default: {
          const n = parseNumber(cell)
          if (n !== null) subjects.push({ subject: name, marks: n })
        }
      }
    }
    if (!l.hall_ticket_no && !l.registration_no && !l.candidate_name) continue
    l.percent = percentOf(l.total_marks, l.max_marks)
    l.subjects = JSON.stringify(subjects)
    out.push(l)
  }
  return out
}

interface Record_ { rec: string[]; line: number; error?: string }

/* encoding/csv with TrimLeadingSpace and ragged rows allowed. A quoted field
   may span lines; a bare quote inside an unquoted field is an error on that
   line, as it is in Go. */
function readCSV(text: string): Record_[] {
  const out: Record_[] = []
  const src = text.replace(/\r\n/g, '\n')
  let i = 0, line = 0
  while (i < src.length) {
    line++
    const startLine = line
    const rec: string[] = []
    let error: string | undefined
    let field = ''
    let done = false
    let inQuotes = false
    let fieldStart = true
    while (!done) {
      if (i >= src.length) {
        if (inQuotes) error = 'extraneous or missing " in quoted-field'
        rec.push(field); done = true; break
      }
      const ch = src[i]
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i += 2; continue }
          inQuotes = false; i++
          // Whatever follows a closing quote must be a delimiter or newline.
          if (i < src.length && src[i] !== ',' && src[i] !== '\n') error = 'extraneous or missing " in quoted-field'
          continue
        }
        if (ch === '\n') line++
        field += ch; i++; continue
      }
      if (fieldStart && (ch === ' ' || ch === '\t')) { i++; continue }
      if (fieldStart && ch === '"') { inQuotes = true; fieldStart = false; i++; continue }
      fieldStart = false
      if (ch === ',') { rec.push(field); field = ''; fieldStart = true; i++; continue }
      if (ch === '\n') { rec.push(field); i++; done = true; break }
      if (ch === '"') error = 'bare " in non-quoted-field'
      field += ch; i++
    }
    // A blank line is skipped by encoding/csv.
    if (rec.length === 1 && rec[0] === '' && !error) continue
    out.push({ rec, line: startLine, error })
  }
  return out
}

function boardResultColumn(h: string): string {
  const k = h.trim().toLowerCase().replace(/ /g, '_').replace(/\./g, '').replace(/-/g, '_').replace(/\//g, '_')
  switch (k) {
    case 'hall_ticket_no': case 'hall_ticket': case 'hallticket': case 'htno': case 'ht_no': case 'roll_no': case 'rollno':
      return 'hall_ticket_no'
    case 'registration_no': case 'regd_no': case 'reg_no': case 'regno': case 'registration':
      return 'registration_no'
    case 'candidate_name': case 'name': case 'student_name': case 'candidate':
      return 'candidate_name'
    case 'result': case 'result_status': case 'status': case 'division':
      return 'result'
    case 'total': case 'total_marks': case 'grand_total': case 'marks_secured': case 'secured':
      return 'total_marks'
    case 'max_marks': case 'maximum_marks': case 'out_of': case 'total_max':
      return 'max_marks'
  }
  return ''
}

/** Folds the board's vocabulary into the five outcomes the summary counts. */
export function boardResultWord(v: string): string {
  const s = v.trim().toLowerCase()
  if (s === '') return ''
  if (s.startsWith('pass') || s === 'p' || s.startsWith('promot')) return 'pass'
  if (s.startsWith('fail') || s === 'f') return 'fail'
  if (s.startsWith('comp') || s === 'c') return 'compartment'
  if (s.startsWith('abs') || s === 'a') return 'absent'
  if (s.startsWith('with') || s === 'w') return 'withheld'
  return s
}

const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
export function parseNumber(v: string): number | null {
  const s = v.replace(/,/g, '').trim()
  if (s === '' || !FLOAT.test(s)) return null
  const f = Number(s)
  return Number.isFinite(f) ? f : null
}
