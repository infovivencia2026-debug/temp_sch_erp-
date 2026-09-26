import type { Router } from '../../router'
import type { Ctx } from '../../router'
import { badRequest, bool, isUUID, noContent, notFound, now, ok, readJSON, uuid, uuidParam, created } from '../../http'
import {
  fin, items, paise, p, today, isDate, daysBetween, addDays, financialYear, notifyStmt, householdUserIds,
  rupeesFixed, studentPredicate, inList, isUniqueViolation, syncInvoice, NET_SQL, str, optStr,
} from './common'
import { school } from '../school'

/*
Port of internal/api/fee_engine.go: fee structure versioning, the late fine
rules engine and GST receipt numbering. All routes sit inside the /finance
group (InvoicesRead gate, enforced by fin()); masters write with
finance.fees.write and a levy with finance.invoices.write.

The fine arithmetic (internal/fees/fines.go) is reproduced below in integer
paise: percentages go through basis points and round half up once, exactly as
the Go did.
*/

const MASTERS = 'finance.fees.write'
const LEVY = 'finance.invoices.write'
const READ = 'finance.invoices.read'
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

/* concessionKinds (concessions_grant.go), for the rule editor's picker. */
const CONCESSION_KINDS = ['scholarship', 'sibling', 'staff_ward', 'rte', 'merit', 'other', 'full_payment']

const inst = (c: Ctx) => school(c).id

/** Drops keys whose value is null/undefined (pointer fields tagged omitempty). */
function omit<T extends object>(o: T): T {
  const r = o as Record<string, unknown>
  for (const k of Object.keys(r)) if (r[k] === null || r[k] === undefined) delete r[k]
  return o
}

/** A Postgres text[] that crossed as a JSON array, or as its '{a,b}' literal. */
function textArray(v: unknown): string[] {
  const s = str(v).trim()
  if (s === '' || s === '{}' || s === '[]') return []
  if (s.startsWith('[')) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : [] } catch { return [] } }
  if (s.startsWith('{')) return s.slice(1, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean)
  return []
}

/** Basis points from a numeric(5,2) text: "2.50" -> 250, as int64(percent*100+0.5) did. */
function basisPoints(percent: unknown): number {
  if (percent === null || percent === undefined || percent === '') return 0
  const n = typeof percent === 'number' ? percent : Number(String(percent).trim())
  if (!Number.isFinite(n)) return 0
  return Math.floor(n * 100 + 0.5)
}

/* ------------------------------------------------------------------------- */
/* Fee head options shared by three screens (loadFeeHeadOptions). */

interface HeadOption { id: string; name: string; code: string; is_taxable: boolean; gst_rate_bp: number; hsn_sac: string }
async function loadFeeHeadOptions(c: Ctx): Promise<HeadOption[]> {
  const rows = await c.db.prepare(`SELECT id, name, code, is_taxable, gst_rate_bp, COALESCE(hsn_sac,'') AS hsn_sac FROM fee_heads ORDER BY name`).all<Record<string, unknown>>()
  return rows.results.map((h) => ({
    id: str(h.id), name: str(h.name), code: str(h.code), is_taxable: bool(h.is_taxable), gst_rate_bp: p(h.gst_rate_bp), hsn_sac: str(h.hsn_sac),
  }))
}

/* ------------------------------------------------------------------------- */
/* The fine engine (internal/fees/fines.go), in integer paise. */

interface FineRule {
  id: string; name: string; campusId: string | null; structureId: string | null; feeHeadId: string | null
  kind: string; graceDays: number; amountPaise: number; percentBP: number; capPaise: number | null
  compound: string; applyMode: string; exemptKinds: string[]; priority: number
}
interface FineSubject {
  invoiceId: string; invoiceNo: string; studentId: string; studentName: string; campusId: string
  structureId: string | null; versionId: string | null; versionLabel: string
  dueOn: string | null; balancePaise: number
  headAmounts: Record<string, number>
  concessionKinds: string[]
  alreadyFinedPaise: number
}
interface FineStep { period: number; basis_paise: number; amount_paise: number; note: string }
interface FineAssessment {
  invoice_id: string; invoice_no: string; student_id: string; student_name: string
  rule_id?: string; rule_name?: string; fee_head_id?: string; version_id?: string; version_label?: string
  days_overdue: number; basis_paise: number; amount_paise: number; delta_paise: number
  periods: number; was_capped: boolean; exempt: boolean; reason: string; steps?: FineStep[]
}

const plural = (n: number, noun: string) => `${n} ${noun}${n !== 1 ? 's' : ''}`
const humanKind = (k: string) => (k === 'staff_ward' ? 'staff ward' : k === 'rte' ? 'RTE' : k)

function periodsFor(compound: string, chargeableDays: number): number {
  const length = compound === 'weekly' ? 7 : compound === 'monthly' ? 30 : 0
  if (!length) return 1
  const periods = Math.floor((chargeableDays + length - 1) / length)
  return periods < 1 ? 1 : periods
}
/** (basis*bp + 5000) / 10000, integer division, rounding half up once. */
function percentOf(basisPaise: number, bp: number): number {
  if (bp <= 0 || basisPaise <= 0) return 0
  return Math.floor((basisPaise * bp + 5000) / 10000)
}

function bestRuleFor(s: FineSubject, rules: FineRule[]): FineRule | null {
  const matches: { rule: FineRule; score: number }[] = []
  for (const r of rules) {
    if (r.campusId !== null && r.campusId !== s.campusId) continue
    if (r.structureId !== null && (s.structureId === null || r.structureId !== s.structureId)) continue
    if (r.feeHeadId !== null && !(r.feeHeadId in s.headAmounts)) continue
    let score = 0
    if (r.feeHeadId !== null) score += 4
    if (r.structureId !== null) score += 2
    if (r.campusId !== null) score++
    matches.push({ rule: r, score })
  }
  if (!matches.length) return null
  matches.sort((a, b) => b.score - a.score || a.rule.priority - b.rule.priority || (a.rule.name < b.rule.name ? -1 : a.rule.name > b.rule.name ? 1 : 0))
  return matches[0].rule
}

function assessFine(s: FineSubject, rule: FineRule, asOf: string): FineAssessment {
  const a: FineAssessment = {
    invoice_id: s.invoiceId, invoice_no: s.invoiceNo, student_id: s.studentId, student_name: s.studentName,
    rule_id: rule.id === ZERO_UUID || rule.id === '' ? undefined : rule.id,
    rule_name: rule.name || undefined,
    fee_head_id: rule.feeHeadId ?? undefined,
    version_id: s.versionId ?? undefined, version_label: s.versionLabel || undefined,
    days_overdue: 0, basis_paise: 0, amount_paise: 0, delta_paise: 0, periods: 1, was_capped: false, exempt: false, reason: '',
  }
  const exemptKind = s.concessionKinds.find((h) => rule.exemptKinds.includes(h))
  if (exemptKind !== undefined) { a.exempt = true; a.reason = 'exempt: holds a ' + humanKind(exemptKind) + ' concession'; return a }
  if (s.dueOn === null) { a.reason = 'no due date on the invoice, so nothing is overdue'; return a }
  if (s.balancePaise <= 0) { a.reason = 'nothing outstanding'; return a }
  a.days_overdue = daysBetween(s.dueOn, asOf)
  if (a.days_overdue <= 0) { a.reason = 'not yet due'; return a }
  if (a.days_overdue <= rule.graceDays) { a.reason = 'within the ' + plural(rule.graceDays, 'day') + ' grace period'; return a }
  const chargeable = a.days_overdue - rule.graceDays

  a.basis_paise = rule.feeHeadId !== null ? (s.headAmounts[rule.feeHeadId] ?? 0) : s.balancePaise
  if (a.basis_paise <= 0) { a.reason = 'the head this rule covers is not charged on this invoice'; return a }

  a.periods = periodsFor(rule.compound, chargeable)
  const steps: FineStep[] = []
  switch (rule.kind) {
    case 'fixed':
      for (let i = 1; i <= a.periods; i++) {
        steps.push({ period: i, basis_paise: a.basis_paise, amount_paise: rule.amountPaise, note: 'flat charge' })
        a.amount_paise += rule.amountPaise
      }
      a.reason = plural(chargeable, 'day') + ' past grace, flat charge'
      if (a.periods > 1) a.reason += ' levied ' + plural(a.periods, 'time') + ' (' + rule.compound + ')'
      break
    case 'per_day':
      a.amount_paise = rule.amountPaise * chargeable
      a.periods = 1
      steps.push({ period: 1, basis_paise: a.basis_paise, amount_paise: a.amount_paise, note: plural(chargeable, 'day') + ' past grace' })
      a.reason = plural(chargeable, 'day') + ' past grace at a daily rate'
      break
    case 'percent': {
      let running = a.basis_paise
      for (let i = 1; i <= a.periods; i++) {
        const step = percentOf(running, rule.percentBP)
        steps.push({ period: i, basis_paise: running, amount_paise: step, note: 'percentage of the outstanding basis' })
        a.amount_paise += step
        running += step
      }
      a.reason = plural(chargeable, 'day') + ' past grace, charged as a percentage'
      if (a.periods > 1) a.reason += ', compounded ' + rule.compound + ' over ' + plural(a.periods, 'period')
      break
    }
    default:
      a.reason = 'rule kind ' + rule.kind + ' is not one this engine knows'
      return a
  }
  if (steps.length) a.steps = steps
  if (rule.capPaise !== null && a.amount_paise > rule.capPaise) { a.amount_paise = rule.capPaise; a.was_capped = true; a.reason += ', capped' }
  if (a.amount_paise < 0) a.amount_paise = 0
  a.delta_paise = a.amount_paise - s.alreadyFinedPaise
  if (a.delta_paise < 0) a.delta_paise = 0
  return a
}

function evaluateFines(subjects: FineSubject[], rules: FineRule[], asOf: string): FineAssessment[] {
  return subjects.map((s) => {
    const rule = bestRuleFor(s, rules)
    if (!rule) {
      const none: FineAssessment = {
        invoice_id: s.invoiceId, invoice_no: s.invoiceNo, student_id: s.studentId, student_name: s.studentName,
        version_id: s.versionId ?? undefined, version_label: s.versionLabel || undefined,
        days_overdue: 0, basis_paise: 0, amount_paise: 0, delta_paise: 0, periods: 0, was_capped: false, exempt: false,
        reason: 'no fine rule covers this invoice',
      }
      return omit(none)
    }
    return omit(assessFine(s, rule, asOf))
  })
}

/* ------------------------------------------------------------------------- */
/* Gathering the engine's inputs (loadFineSubjects, loadFineRuleSet, assessDues). */

type ChargeKey = string
const chargeKey = (invoiceId: string, ruleId: string) => invoiceId + '|' + ruleId

async function loadFineSubjects(c: Ctx, asOf: string, onlyInvoices: string[] | null): Promise<{ subjects: FineSubject[]; already: Map<ChargeKey, number> }> {
  const scope = await studentPredicate(c, 'st')
  const args: unknown[] = [asOf]
  let onlySQL = ''
  if (onlyInvoices !== null) { const l = inList('i.id', onlyInvoices); onlySQL = ' AND ' + l.sql; args.push(...l.args) }
  args.push(...scope.args)
  const rows = await c.db.prepare(`
    SELECT i.id, i.invoice_no, i.student_id,
           TRIM(st.first_name || ' ' || COALESCE(st.last_name, '')) AS student_name,
           i.campus_id, v.fee_structure_id AS structure_id, i.fee_structure_version_id AS version_id,
           CASE WHEN v.id IS NULL THEN '' ELSE COALESCE(fs.name,'') || ' v' || v.version_no END AS version_label,
           i.due_on, i.net_paise - i.paid_paise AS balance
      FROM invoices i
      JOIN students st ON st.id = i.student_id
      LEFT JOIN fee_structure_versions v ON v.id = i.fee_structure_version_id
      LEFT JOIN fee_structures fs ON fs.id = v.fee_structure_id
     WHERE i.status IN ('unpaid','partial','overdue')
       AND i.net_paise > i.paid_paise
       AND i.due_on IS NOT NULL
       AND i.due_on < ?${onlySQL}
       AND ${scope.sql}
     ORDER BY i.due_on, i.invoice_no`).bind(...args).all<Record<string, unknown>>()

  const subjects: FineSubject[] = rows.results.map((r) => ({
    invoiceId: str(r.id), invoiceNo: str(r.invoice_no), studentId: str(r.student_id), studentName: str(r.student_name),
    campusId: str(r.campus_id), structureId: optStr(r.structure_id), versionId: optStr(r.version_id), versionLabel: str(r.version_label),
    dueOn: optStr(r.due_on), balancePaise: p(r.balance), headAmounts: {}, concessionKinds: [], alreadyFinedPaise: 0,
  }))
  const already = new Map<ChargeKey, number>()
  if (!subjects.length) return { subjects, already }

  const versionIds = [...new Set(subjects.map((s) => s.versionId).filter((v): v is string => v !== null))]
  const studentIds = [...new Set(subjects.map((s) => s.studentId))]
  const invoiceIds = subjects.map((s) => s.invoiceId)

  // Head amounts from the version each invoice was raised under: the basis of a head-specific percentage rule.
  const headAmounts: Record<string, Record<string, number>> = {}
  if (versionIds.length) {
    const l = inList('version_id', versionIds)
    const h = await c.db.prepare(`SELECT version_id, fee_head_id, sum(amount_paise) AS amt FROM fee_structure_version_items WHERE ${l.sql} GROUP BY version_id, fee_head_id`)
      .bind(...l.args).all<{ version_id: string; fee_head_id: string; amt: number }>()
    for (const r of h.results) (headAmounts[r.version_id] ??= {})[r.fee_head_id] = p(r.amt)
  }

  // Approved concessions only.
  const concessions: Record<string, string[]> = {}
  {
    const l = inList('student_id', studentIds)
    const cr = await c.db.prepare(`SELECT DISTINCT student_id, kind FROM fee_concessions WHERE ${l.sql} AND approved_at IS NOT NULL`)
      .bind(...l.args).all<{ student_id: string; kind: string }>()
    for (const r of cr.results) (concessions[r.student_id] ??= []).push(r.kind)
  }

  // What each rule has already charged each invoice.
  {
    const l = inList('invoice_id', invoiceIds)
    const ar = await c.db.prepare(`SELECT invoice_id, COALESCE(fee_fine_rule_id, ?) AS rule_id, sum(amount_paise) AS amt
        FROM fee_fine_charges WHERE ${l.sql} AND status = 'applied' GROUP BY invoice_id, fee_fine_rule_id`)
      .bind(ZERO_UUID, ...l.args).all<{ invoice_id: string; rule_id: string; amt: number }>()
    for (const r of ar.results) already.set(chargeKey(r.invoice_id, r.rule_id), p(r.amt))
  }

  for (const s of subjects) {
    if (s.versionId !== null && headAmounts[s.versionId]) s.headAmounts = headAmounts[s.versionId]
    s.concessionKinds = concessions[s.studentId] ?? []
  }
  return { subjects, already }
}

function ruleFromRow(r: Record<string, unknown>): FineRule {
  return {
    id: str(r.id), name: str(r.name), campusId: optStr(r.campus_id), structureId: optStr(r.fee_structure_id), feeHeadId: optStr(r.fee_head_id),
    kind: str(r.kind), graceDays: p(r.grace_days), amountPaise: p(r.amount_paise), percentBP: basisPoints(r.percent),
    capPaise: r.cap_paise === null || r.cap_paise === undefined ? null : p(r.cap_paise),
    compound: str(r.compound_period), applyMode: str(r.apply_mode), exemptKinds: textArray(r.exempt_concession_kinds), priority: p(r.priority),
  }
}

async function loadFineRuleSet(c: Ctx, onlyRule: string | null): Promise<FineRule[]> {
  const rows = await c.db.prepare(`SELECT id, name, campus_id, fee_structure_id, fee_head_id, kind, grace_days, amount_paise, percent, cap_paise,
        compound_period, exempt_concession_kinds, priority, apply_mode FROM fee_fine_rules WHERE is_active AND (? IS NULL OR id = ?)`)
    .bind(onlyRule, onlyRule).all<Record<string, unknown>>()
  return rows.results.map(ruleFromRow)
}

async function assessDues(c: Ctx, asOf: string, onlyRule: string | null, onlyInvoices: string[] | null): Promise<FineAssessment[]> {
  const { subjects, already } = await loadFineSubjects(c, asOf, onlyInvoices)
  const rules = await loadFineRuleSet(c, onlyRule)
  for (const s of subjects) {
    const rule = bestRuleFor(s, rules)
    if (rule) s.alreadyFinedPaise = already.get(chargeKey(s.invoiceId, rule.id)) ?? 0
  }
  return evaluateFines(subjects, rules, asOf)
}

/** parseDate: blank falls back to today (India); otherwise strict YYYY-MM-DD. */
function parseAsOf(v: unknown, err: string): string {
  const s = str(v).trim()
  if (s === '') return today()
  if (!isDate(s)) throw badRequest(err)
  return s
}

/* ------------------------------------------------------------------------- */
/* Receipt series preview (feRenderPreview). */

function renderPreview(v: { format: string; prefix: string; suffix: string; padding: number; next_value: number }, fy: string): string {
  let format = v.format || '{prefix}{fy}/{seq}{suffix}'
  if (fy === '') for (const d of ['{fy}/', '{fy}-', '/{fy}', '-{fy}']) format = format.split(d).join('')
  return format.split('{prefix}').join(v.prefix).split('{fy}').join(fy)
    .split('{seq}').join(String(v.next_value).padStart(v.padding, '0')).split('{suffix}').join(v.suffix)
}

/* ------------------------------------------------------------------------- */

export function registerFeeEngine(r: Router): void {
  // --- fee structure versioning -----------------------------------------

  r.get('/finance/fee-engine/structures', READ, fin(async (c) => {
    const rows = await c.db.prepare(`
      SELECT fs.id, fs.name, c.name AS class_name, ay.name AS academic_year, fs.applies_to, fs.is_active,
             (SELECT count(*) FROM fee_structure_versions sv WHERE sv.fee_structure_id = fs.id) AS versions,
             (SELECT max(sv.version_no) FROM fee_structure_versions sv WHERE sv.fee_structure_id = fs.id AND sv.status = 'active') AS active_no,
             (SELECT max(sv.version_no) FROM fee_structure_versions sv WHERE sv.fee_structure_id = fs.id AND sv.status = 'draft') AS draft_no,
             (SELECT max(sv.effective_from) FROM fee_structure_versions sv WHERE sv.fee_structure_id = fs.id AND sv.status = 'active') AS effective_from,
             COALESCE((SELECT sum(i.amount_paise) FROM fee_structure_version_items i
                         JOIN fee_structure_versions av ON av.id = i.version_id
                        WHERE av.fee_structure_id = fs.id AND av.status = 'active'), 0) AS active_total,
             (SELECT count(*) FROM invoices i JOIN fee_structure_versions sv ON sv.id = i.fee_structure_version_id
               WHERE sv.fee_structure_id = fs.id) AS invoices_raised
        FROM fee_structures fs
        LEFT JOIN classes c ON c.id = fs.class_id
        LEFT JOIN academic_years ay ON ay.id = fs.academic_year_id
       ORDER BY fs.is_active DESC, fs.name`).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => omit({
      id: str(v.id), name: str(v.name), class_name: optStr(v.class_name), academic_year: optStr(v.academic_year), applies_to: optStr(v.applies_to),
      is_active: bool(v.is_active), versions: p(v.versions),
      active_version: v.active_no === null || v.active_no === undefined ? null : p(v.active_no),
      active_total_paise: p(v.active_total), effective_from: optStr(v.effective_from),
      draft_version: v.draft_no === null || v.draft_no === undefined ? null : p(v.draft_no),
      invoices_raised: p(v.invoices_raised),
    }))))
  }))

  r.get('/finance/fee-engine/structures/{id}/versions', READ, fin(async (c) => {
    const structureId = uuidParam(c.params.id, 'structure id')
    const st = await c.db.prepare(`SELECT name FROM fee_structures WHERE id = ?`).bind(structureId).first<{ name: string }>()
    if (!st) throw notFound()
    const [vrows, lines, heads] = await Promise.all([
      c.db.prepare(`
        SELECT v.id, v.version_no, v.status, v.effective_from, v.effective_to, v.revision_note, v.activated_at, u.full_name AS activated_by,
               COALESCE((SELECT sum(amount_paise) FROM fee_structure_version_items WHERE version_id = v.id), 0) AS total_paise,
               (SELECT count(*) FROM invoices WHERE fee_structure_version_id = v.id) AS invoice_count
          FROM fee_structure_versions v LEFT JOIN users u ON u.id = v.activated_by
         WHERE v.fee_structure_id = ? ORDER BY v.version_no DESC`).bind(structureId).all<Record<string, unknown>>(),
      c.db.prepare(`
        SELECT i.version_id, i.id, i.fee_head_id, h.name AS fee_head, i.instalment_no, i.amount_paise, i.due_on,
               (SELECT pi.amount_paise FROM fee_structure_version_items pi JOIN fee_structure_versions pv ON pv.id = pi.version_id
                 WHERE pv.fee_structure_id = v.fee_structure_id AND pv.version_no < v.version_no
                   AND pi.fee_head_id = i.fee_head_id AND pi.instalment_no = i.instalment_no
                 ORDER BY pv.version_no DESC LIMIT 1) AS previous_paise
          FROM fee_structure_version_items i
          JOIN fee_structure_versions v ON v.id = i.version_id
          JOIN fee_heads h ON h.id = i.fee_head_id
         WHERE v.fee_structure_id = ? ORDER BY i.instalment_no, h.name`).bind(structureId).all<Record<string, unknown>>(),
      loadFeeHeadOptions(c),
    ])
    const byVersion: Record<string, Record<string, unknown>[]> = {}
    for (const l of lines.results) {
      (byVersion[str(l.version_id)] ??= []).push(omit({
        id: str(l.id), fee_head_id: str(l.fee_head_id), fee_head: str(l.fee_head), instalment_no: p(l.instalment_no), amount_paise: p(l.amount_paise),
        due_on: optStr(l.due_on), previous_paise: l.previous_paise === null || l.previous_paise === undefined ? null : p(l.previous_paise),
      }))
    }
    const versions = vrows.results.map((v) => omit({
      id: str(v.id), version_no: p(v.version_no), status: str(v.status), effective_from: str(v.effective_from), effective_to: optStr(v.effective_to),
      revision_note: optStr(v.revision_note), activated_at: optStr(v.activated_at), activated_by: optStr(v.activated_by),
      total_paise: p(v.total_paise), invoice_count: p(v.invoice_count), items: byVersion[str(v.id)] ?? [],
    }))
    return ok({ structure: { id: structureId, name: st.name }, items: versions, heads })
  }))

  r.post('/finance/fee-engine/versions', MASTERS, fin(async (c) => {
    const req = await readJSON<{ structure_id?: string; copy_from_id?: string; effective_from?: string; revision_note?: string }>(c.req)
    const structureId = str(req.structure_id).trim()
    if (!isUUID(structureId)) throw badRequest('structure_id must be a uuid')
    const effectiveFrom = str(req.effective_from).trim()
    if (!isDate(effectiveFrom)) throw badRequest('effective_from must be a date, as YYYY-MM-DD')

    const exists = await c.db.prepare(`SELECT 1 AS x FROM fee_structures WHERE id = ?`).bind(structureId).first()
    if (!exists) throw notFound()
    const state = await c.db.prepare(`
      SELECT EXISTS (SELECT 1 FROM fee_structure_versions WHERE fee_structure_id = ?1 AND status = 'draft') AS draft_exists,
             COALESCE((SELECT max(version_no) FROM fee_structure_versions WHERE fee_structure_id = ?1), 0) + 1 AS next_no,
             (SELECT id FROM fee_structure_versions WHERE fee_structure_id = ?1 AND status = 'active' LIMIT 1) AS active_id`)
      .bind(structureId).first<{ draft_exists: number; next_no: number; active_id: string | null }>()
    if (state?.draft_exists) throw badRequest('this structure already has a draft revision open. Finish or discard it first')
    const versionNo = p(state?.next_no) || 1
    const supersedes = state?.active_id ?? null

    let copyFrom: string | null = null
    const cf = str(req.copy_from_id).trim()
    if (cf !== '') {
      if (!isUUID(cf)) throw badRequest('copy_from_id must be a uuid')
      copyFrom = cf
    } else if (supersedes) copyFrom = supersedes

    const newId = uuid(); const t = now()
    const stmts: D1PreparedStatement[] = [
      c.db.prepare(`INSERT INTO fee_structure_versions (id, institution_id, fee_structure_id, version_no, status, effective_from, revision_note, supersedes_id, created_by, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'draft', ?, NULLIF(?, ''), ?, ?, ?, ?)`)
        .bind(newId, inst(c), structureId, versionNo, effectiveFrom, str(req.revision_note).trim(), supersedes, c.id.userId, t, t),
    ]
    // Seed the draft's lines: explicit source, else the active version, else the structure's live items.
    // Each copied line needs its own id, so the rows are read and inserted one by one.
    const src = copyFrom
      ? await c.db.prepare(`SELECT fee_head_id, instalment_no, amount_paise, due_on FROM fee_structure_version_items WHERE version_id = ?`).bind(copyFrom).all<Record<string, unknown>>()
      : await c.db.prepare(`SELECT fee_head_id, instalment_no, amount_paise, due_on FROM fee_structure_items WHERE fee_structure_id = ?`).bind(structureId).all<Record<string, unknown>>()
    for (const it of src.results) {
      stmts.push(c.db.prepare(`INSERT INTO fee_structure_version_items (id, institution_id, version_id, fee_head_id, instalment_no, amount_paise, due_on) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), inst(c), newId, str(it.fee_head_id), p(it.instalment_no), p(it.amount_paise), optStr(it.due_on)))
    }
    try { await c.db.batch(stmts) } catch (e) {
      if (isUniqueViolation(e)) throw badRequest('that version number is already taken on this structure')
      throw e
    }
    return created({ id: newId, version_no: versionNo, status: 'draft' })
  }))

  r.put('/finance/fee-engine/versions/{id}/items', MASTERS, fin(async (c) => {
    const versionId = uuidParam(c.params.id, 'version id')
    const req = await readJSON<{ items?: { fee_head_id?: string; instalment_no?: number; amount_paise?: unknown; due_on?: string }[] }>(c.req)
    const lines = Array.isArray(req.items) ? req.items : []
    const seen = new Set<string>()
    const parsed = lines.map((it, i) => {
      const amount = paise(it.amount_paise, `line ${i + 1}: amount_paise`)
      if (amount < 0) throw badRequest(`line ${i + 1}: an amount cannot be negative`)
      const head = str(it.fee_head_id).trim()
      if (!isUUID(head)) throw badRequest(`line ${i + 1}: fee_head_id must be a uuid`)
      let instalment = Number(it.instalment_no ?? 0)
      if (!Number.isInteger(instalment) || instalment <= 0) instalment = 1
      return { head, instalment, amount, dueOn: optStr(it.due_on) }
    })
    // fee_structure_version_items_line: one line per head per instalment.
    for (const l of parsed) {
      const k = l.head + '|' + l.instalment
      if (seen.has(k)) throw badRequest('the same fee head appears twice for one instalment')
      seen.add(k)
    }
    const v = await c.db.prepare(`SELECT status FROM fee_structure_versions WHERE id = ?`).bind(versionId).first<{ status: string }>()
    if (!v) throw notFound()
    if (v.status !== 'draft') throw badRequest(`this version is ${v.status}. An invoice may already have been raised under it. Open a new revision instead.`)

    const stmts: D1PreparedStatement[] = [c.db.prepare(`DELETE FROM fee_structure_version_items WHERE version_id = ?`).bind(versionId)]
    for (const l of parsed) {
      stmts.push(c.db.prepare(`INSERT INTO fee_structure_version_items (id, institution_id, version_id, fee_head_id, instalment_no, amount_paise, due_on) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), inst(c), versionId, l.head, l.instalment, l.amount, l.dueOn))
    }
    stmts.push(c.db.prepare(`UPDATE fee_structure_versions SET updated_at = ? WHERE id = ?`).bind(now(), versionId))
    await c.db.batch(stmts)
    return ok({ id: versionId, lines: parsed.length })
  }))

  r.post('/finance/fee-engine/versions/{id}/activate', MASTERS, fin(async (c) => {
    const versionId = uuidParam(c.params.id, 'version id')
    const v = await c.db.prepare(`SELECT fee_structure_id, version_no, status, effective_from,
        (SELECT count(*) FROM fee_structure_version_items WHERE version_id = ?1) AS lines,
        (SELECT count(*) FROM fee_structure_versions WHERE fee_structure_id = fee_structure_versions.fee_structure_id AND status = 'active' AND id <> ?1) AS active_others
      FROM fee_structure_versions WHERE id = ?1`).bind(versionId)
      .first<{ fee_structure_id: string; version_no: number; status: string; effective_from: string; lines: number; active_others: number }>()
    if (!v) throw notFound()
    if (v.status === 'active') throw badRequest('this version is already the active one')
    if (v.status !== 'draft') throw badRequest('only a draft revision can be activated')
    if (p(v.lines) === 0) throw badRequest('this revision has no fee lines. It would bill nothing')

    const dayBefore = addDays(v.effective_from, -1)
    const t = now()
    const res = await c.db.batch([
      // Close the outgoing version the day before this one starts.
      c.db.prepare(`UPDATE fee_structure_versions SET status = 'superseded', effective_to = min(COALESCE(effective_to, ?3), ?3), updated_at = ?4
                     WHERE fee_structure_id = ?1 AND status = 'active' AND id <> ?2`).bind(v.fee_structure_id, versionId, dayBefore, t),
      c.db.prepare(`UPDATE fee_structure_versions SET status = 'active', activated_at = ?2, activated_by = ?3, effective_to = NULL, updated_at = ?2 WHERE id = ?1`)
        .bind(versionId, t, c.id.userId),
    ])
    const superseded = res[0]?.meta?.changes ?? p(v.active_others)
    return ok({ id: versionId, version_no: p(v.version_no), superseded })
  }))

  r.del('/finance/fee-engine/versions/{id}', MASTERS, fin(async (c) => {
    const versionId = uuidParam(c.params.id, 'version id')
    const v = await c.db.prepare(`SELECT status, (SELECT count(*) FROM invoices WHERE fee_structure_version_id = ?1) AS invoices FROM fee_structure_versions WHERE id = ?1`)
      .bind(versionId).first<{ status: string; invoices: number }>()
    if (!v || v.status !== 'draft') throw badRequest('only a draft revision can be discarded. An activated version is part of the record')
    // invoices_fee_structure_version_id_fkey (ON DELETE RESTRICT).
    if (p(v.invoices) > 0) throw badRequest('invoices have been raised under this version, so it cannot be removed')
    await c.db.batch([
      c.db.prepare(`DELETE FROM fee_structure_version_items WHERE version_id = ?`).bind(versionId),
      c.db.prepare(`UPDATE fee_structure_versions SET supersedes_id = NULL WHERE supersedes_id = ?`).bind(versionId),
      c.db.prepare(`DELETE FROM fee_structure_versions WHERE id = ? AND status = 'draft'`).bind(versionId),
    ])
    return noContent()
  }))

  // --- late fine rules engine -------------------------------------------

  r.get('/finance/fee-engine/fine-rules', READ, fin(async (c) => {
    const [rows, heads] = await Promise.all([
      c.db.prepare(`
        SELECT fr.id, fr.name, fr.campus_id, c.name AS campus, fr.fee_structure_id, fs.name AS fee_structure, fr.fee_head_id, h.name AS fee_head,
               fr.kind, fr.grace_days, fr.amount_paise, fr.percent, fr.cap_paise, fr.compound_period, fr.exempt_concession_kinds, fr.apply_mode,
               fr.priority, fr.is_active
          FROM fee_fine_rules fr
          LEFT JOIN campuses c ON c.id = fr.campus_id
          LEFT JOIN fee_structures fs ON fs.id = fr.fee_structure_id
          LEFT JOIN fee_heads h ON h.id = fr.fee_head_id
         ORDER BY fr.is_active DESC, fr.priority, fr.name`).all<Record<string, unknown>>(),
      loadFeeHeadOptions(c),
    ])
    const list = rows.results.map((v) => omit({
      id: str(v.id), name: str(v.name), campus_id: optStr(v.campus_id), campus: optStr(v.campus),
      fee_structure_id: optStr(v.fee_structure_id), fee_structure: optStr(v.fee_structure), fee_head_id: optStr(v.fee_head_id), fee_head: optStr(v.fee_head),
      kind: str(v.kind), grace_days: p(v.grace_days), amount_paise: p(v.amount_paise),
      percent: v.percent === null || v.percent === undefined ? null : String(v.percent),
      cap_paise: v.cap_paise === null || v.cap_paise === undefined ? null : p(v.cap_paise),
      compound_period: str(v.compound_period), exempt_concession_kinds: textArray(v.exempt_concession_kinds), priority: p(v.priority),
      is_active: bool(v.is_active), apply_mode: str(v.apply_mode),
    }))
    return ok({ items: list, heads, kinds: ['fixed', 'per_day', 'percent'], compound_periods: ['none', 'weekly', 'monthly'], concession_kinds: CONCESSION_KINDS })
  }))

  r.post('/finance/fee-engine/fine-rules', MASTERS, fin(async (c) => {
    const req = await readJSON<Record<string, unknown>>(c.req)
    const name = str(req.name).trim()
    const kind = str(req.kind)
    let compound = str(req.compound_period); if (compound === '') compound = 'none'
    let priority = Number(req.priority ?? 0); if (!Number.isInteger(priority)) throw badRequest('priority must be a whole number'); if (priority === 0) priority = 100
    const exemptKinds = Array.isArray(req.exempt_concession_kinds) ? req.exempt_concession_kinds.map(String) : []
    const graceDays = Number(req.grace_days ?? 0)
    if (!Number.isInteger(graceDays)) throw badRequest('grace_days must be a whole number')
    const amountPaise = paise(req.amount_paise)
    const percent = req.percent === null || req.percent === undefined ? 0 : Number(req.percent)
    if (!Number.isFinite(percent)) throw badRequest('percent must be a number')
    const capPaise = req.cap_paise === null || req.cap_paise === undefined ? null : paise(req.cap_paise, 'cap_paise')

    if (name === '') throw badRequest('a rule needs a name. It is how the school finds it again')
    if (kind !== 'fixed' && kind !== 'per_day' && kind !== 'percent') throw badRequest('kind must be fixed, per_day or percent')
    if (graceDays < 0) throw badRequest('a grace period cannot be negative')
    if (kind === 'percent' && (percent <= 0 || percent > 100)) throw badRequest('a percentage rule needs a percent between 0 and 100')
    if (kind !== 'percent' && amountPaise <= 0) throw badRequest('a fixed or per-day rule needs an amount above zero')
    if (compound !== 'none' && compound !== 'weekly' && compound !== 'monthly') throw badRequest('compounding must be none, weekly or monthly')
    if (kind === 'per_day' && compound !== 'none') throw badRequest('a per-day rule already grows with time. Compounding it as well would charge the same days twice')
    if (capPaise !== null && capPaise < 0) throw badRequest('a cap cannot be negative')
    // fee_fine_rules_exempt_kinds_check: the table's own list (without full_payment).
    for (const k of exemptKinds) if (!['scholarship', 'sibling', 'staff_ward', 'rte', 'merit', 'other'].includes(k)) throw badRequest(`exempt_concession_kinds: ${k} is not a concession kind`)

    const active = req.is_active === null || req.is_active === undefined ? true : bool(req.is_active)
    const percentText = kind === 'percent' ? percent.toFixed(2) : null
    let ruleId = ''
    if (str(req.id) !== '') { if (!isUUID(req.id)) throw badRequest('malformed rule id'); ruleId = str(req.id) }
    let applyMode = str(req.apply_mode).trim(); if (applyMode === '') applyMode = 'per_invoice'
    if (applyMode !== 'per_invoice' && applyMode !== 'final_term') throw badRequest('apply_mode must be per_invoice or final_term')

    const campusId = optStr(req.campus_id); const structureId = optStr(req.fee_structure_id); const feeHeadId = optStr(req.fee_head_id)
    for (const [k, v] of [['campus_id', campusId], ['fee_structure_id', structureId], ['fee_head_id', feeHeadId]] as const) {
      if (v !== null && !isUUID(v)) throw badRequest(`${k} must be a uuid`)
    }

    // fee_fine_rules_one_active_per_target (partial unique index in Postgres): pre-checked here.
    if (active) {
      const clash = await c.db.prepare(`SELECT 1 AS x FROM fee_fine_rules WHERE institution_id = ? AND is_active
          AND COALESCE(campus_id, ?) = ? AND COALESCE(fee_structure_id, ?) = ? AND COALESCE(fee_head_id, ?) = ? AND id <> ?`)
        .bind(inst(c), ZERO_UUID, campusId ?? ZERO_UUID, ZERO_UUID, structureId ?? ZERO_UUID, ZERO_UUID, feeHeadId ?? ZERO_UUID, ruleId || ZERO_UUID).first()
      if (clash) throw badRequest('an active rule already covers that campus, structure and head. Edit it, or retire it first')
    }

    const exemptJSON = JSON.stringify(exemptKinds)
    if (ruleId !== '') {
      const res = await c.db.prepare(`UPDATE fee_fine_rules SET name = ?3, campus_id = ?4, fee_structure_id = ?5, fee_head_id = ?6, kind = ?7, grace_days = ?8,
            amount_paise = ?9, percent = ?10, cap_paise = ?11, compound_period = ?12, exempt_concession_kinds = ?13, priority = ?14, is_active = ?15,
            apply_mode = ?16, updated_at = ?17 WHERE id = ?1 AND institution_id = ?2`)
        .bind(ruleId, inst(c), name, campusId, structureId, feeHeadId, kind, graceDays, amountPaise, percentText, capPaise, compound, exemptJSON, priority,
          active ? 1 : 0, applyMode, now()).run()
      if (!res.meta.changes) throw notFound()
      return ok({ id: ruleId })
    }
    ruleId = uuid(); const t = now()
    await c.db.prepare(`INSERT INTO fee_fine_rules (id, institution_id, name, campus_id, fee_structure_id, fee_head_id, kind, grace_days, amount_paise, percent, cap_paise,
          compound_period, exempt_concession_kinds, priority, is_active, apply_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(ruleId, inst(c), name, campusId, structureId, feeHeadId, kind, graceDays, amountPaise, percentText, capPaise, compound, exemptJSON, priority,
        active ? 1 : 0, applyMode, t, t).run()
    return ok({ id: ruleId })
  }))

  r.del('/finance/fee-engine/fine-rules/{id}', MASTERS, fin(async (c) => {
    const ruleId = uuidParam(c.params.id, 'rule id')
    // fee_fine_charges.fee_fine_rule_id is ON DELETE SET NULL.
    const res = await c.db.batch([
      c.db.prepare(`UPDATE fee_fine_charges SET fee_fine_rule_id = NULL WHERE fee_fine_rule_id = ? AND EXISTS (SELECT 1 FROM fee_fine_rules WHERE id = ? AND institution_id = ?)`).bind(ruleId, ruleId, inst(c)),
      c.db.prepare(`DELETE FROM fee_fine_rules WHERE id = ? AND institution_id = ?`).bind(ruleId, inst(c)),
    ])
    if (!res[1].meta.changes) throw notFound()
    return noContent()
  }))

  r.get('/finance/fee-engine/fines/preview', READ, fin(async (c) => {
    const q = c.url.searchParams
    const asOf = parseAsOf(q.get('as_of'), 'as_of must be a date, as YYYY-MM-DD')
    let onlyRule: string | null = null
    const rv = (q.get('rule_id') ?? '').trim()
    if (rv !== '') { if (!isUUID(rv)) throw badRequest('rule_id must be a uuid'); onlyRule = rv }
    const out = await assessDues(c, asOf, onlyRule, null)
    let chargeable = 0, totalPaise = 0, exempt = 0
    for (const a of out) {
      if (a.exempt) exempt++
      else if (a.delta_paise > 0) { chargeable++; totalPaise += a.delta_paise }
    }
    return ok({ items: out, as_of: asOf, assessed: out.length, chargeable, exempt, total_paise: totalPaise })
  }))

  r.post('/finance/fee-engine/fines/apply', LEVY, fin(async (c) => {
    const req = await readJSON<{ as_of?: string; invoice_ids?: unknown; rule_id?: string }>(c.req)
    const ids = Array.isArray(req.invoice_ids) ? req.invoice_ids : []
    if (ids.length === 0) throw badRequest('name the invoices to fine. Applying to everything at once is not offered')
    const asOf = parseAsOf(req.as_of, 'as_of must be a date, as YYYY-MM-DD')
    const invoiceIds: string[] = []
    for (const v of ids) { const s = str(v).trim(); if (!isUUID(s)) throw badRequest('invoice_ids must all be uuids'); invoiceIds.push(s) }
    let onlyRule: string | null = null
    const rv = str(req.rule_id).trim()
    if (rv !== '') { if (!isUUID(rv)) throw badRequest('rule_id must be a uuid'); onlyRule = rv }

    const out = await assessDues(c, asOf, onlyRule, invoiceIds)
    const rules = await loadFineRuleSet(c, onlyRule)
    const finalTerm = new Set(rules.filter((ru) => ru.applyMode === 'final_term').map((ru) => ru.id))

    // fee_fine_charges_once_per_day: what is already applied today, so a second click inserts nothing.
    const todayKeys = new Set<string>()
    if (invoiceIds.length) {
      const l = inList('invoice_id', invoiceIds)
      const ex = await c.db.prepare(`SELECT invoice_id, COALESCE(fee_fine_rule_id, ?) AS rule_id FROM fee_fine_charges WHERE ${l.sql} AND as_of = ? AND status = 'applied'`)
        .bind(ZERO_UUID, ...l.args, asOf).all<{ invoice_id: string; rule_id: string }>()
      for (const r of ex.results) todayKeys.add(chargeKey(r.invoice_id, r.rule_id))
    }

    let applied = 0, skipped = 0, totalPaise = 0
    const stmts: D1PreparedStatement[] = []
    const touched = new Set<string>()
    for (const a of out) {
      if (a.delta_paise <= 0 || !a.rule_id) { skipped++; continue }
      if (todayKeys.has(chargeKey(a.invoice_id, a.rule_id))) { skipped++; continue }
      const working = JSON.stringify({
        reason: a.reason, days_overdue: a.days_overdue, basis_paise: a.basis_paise, total_paise: a.amount_paise, delta_paise: a.delta_paise,
        periods: a.periods, was_capped: a.was_capped, steps: a.steps ?? null, version: a.version_label ?? '',
      })
      // A final-term rule puts the money on the student's last instalment of the year; the charge row keeps the late invoice.
      let chargeOn = a.invoice_id
      if (finalTerm.has(a.rule_id)) {
        const last = await c.db.prepare(`SELECT i2.id FROM invoices i2 JOIN invoices i1 ON i1.id = ?
            WHERE i2.student_id = i1.student_id AND i2.academic_year_id = i1.academic_year_id AND i2.status <> 'cancelled'
            ORDER BY (i2.due_on IS NULL), i2.due_on DESC, i2.invoice_no DESC LIMIT 1`).bind(a.invoice_id).first<{ id: string }>()
        if (last?.id) chargeOn = last.id
      }
      stmts.push(c.db.prepare(`INSERT INTO fee_fine_charges (id, institution_id, invoice_id, fee_fine_rule_id, rule_name, fee_head_id, fee_structure_version_id,
            as_of, days_overdue, basis_paise, amount_paise, was_capped, periods, working, status, applied_at, applied_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)`)
        .bind(uuid(), inst(c), a.invoice_id, a.rule_id, a.rule_name ?? '', a.fee_head_id ?? null, a.version_id ?? null, asOf, a.days_overdue, a.basis_paise,
          a.delta_paise, a.was_capped ? 1 : 0, a.periods, working, now(), c.id.userId))
      // net_paise was GENERATED in Postgres; here it follows fine_paise in the same statement.
      stmts.push(c.db.prepare(`UPDATE invoices SET fine_paise = fine_paise + ?2, ${NET_SQL}, updated_at = ?3 WHERE id = ?1`).bind(chargeOn, a.delta_paise, now()))
      touched.add(chargeOn)
      // The family is told, with the reason.
      const amount = '₹' + rupeesFixed(a.delta_paise)
      const body = (a.rule_name ?? '') + ' · ' + a.reason + '. It has been added to the bill; the total on your fees page is up to date.'
      for (const u of await householdUserIds(c, a.student_id)) {
        stmts.push(notifyStmt(c, u, null, 'fee_penalty', amount + ' late fee added', body, '/go/fees_payments', 'invoice', a.invoice_id))
      }
      applied++
      totalPaise += a.delta_paise
    }
    // Status follows the sync_invoice_paid rule once the net has moved.
    for (const id of touched) stmts.push(...syncInvoice(c, id))
    if (stmts.length) await c.db.batch(stmts)
    return ok({ applied, skipped, total_paise: totalPaise, as_of: asOf })
  }))

  r.get('/finance/fee-engine/fines/charges', READ, fin(async (c) => {
    const rows = await c.db.prepare(`
      SELECT fc.id, i.invoice_no, TRIM(st.first_name || ' ' || COALESCE(st.last_name,'')) AS student_name, st.admission_no,
             fc.rule_name, h.name AS fee_head,
             CASE WHEN v.id IS NULL THEN NULL ELSE COALESCE(fs.name,'') || ' v' || v.version_no END AS version,
             fc.as_of, fc.days_overdue, fc.basis_paise, fc.amount_paise, fc.was_capped, fc.status, fc.waived_reason, fc.applied_at, u.full_name AS applied_by
        FROM fee_fine_charges fc
        JOIN invoices i ON i.id = fc.invoice_id
        JOIN students st ON st.id = i.student_id
        LEFT JOIN fee_heads h ON h.id = fc.fee_head_id
        LEFT JOIN fee_structure_versions v ON v.id = fc.fee_structure_version_id
        LEFT JOIN fee_structures fs ON fs.id = v.fee_structure_id
        LEFT JOIN users u ON u.id = fc.applied_by
       ORDER BY fc.applied_at DESC LIMIT 500`).all<Record<string, unknown>>()
    return ok(items(rows.results.map((v) => omit({
      id: str(v.id), invoice_no: str(v.invoice_no), student_name: str(v.student_name), admission_no: str(v.admission_no), rule_name: str(v.rule_name),
      fee_head: optStr(v.fee_head), version: optStr(v.version), as_of: str(v.as_of), days_overdue: p(v.days_overdue), basis_paise: p(v.basis_paise),
      amount_paise: p(v.amount_paise), was_capped: bool(v.was_capped), status: str(v.status), waived_reason: optStr(v.waived_reason),
      applied_at: str(v.applied_at), applied_by: optStr(v.applied_by),
    }))))
  }))

  r.post('/finance/fee-engine/fines/charges/{id}/waive', LEVY, fin(async (c) => {
    const chargeId = uuidParam(c.params.id, 'charge id')
    const req = await readJSON<{ reason?: string }>(c.req)
    const reason = str(req.reason).trim()
    if (reason === '') throw badRequest('a waiver needs a reason. It reverses money a parent was told they owed')
    const ch = await c.db.prepare(`SELECT invoice_id, amount_paise FROM fee_fine_charges WHERE id = ? AND status = 'applied'`).bind(chargeId)
      .first<{ invoice_id: string; amount_paise: number }>()
    if (!ch) throw notFound()
    const amount = p(ch.amount_paise)
    await c.db.batch([
      c.db.prepare(`UPDATE fee_fine_charges SET status = 'waived', waived_reason = ? WHERE id = ? AND status = 'applied'`).bind(reason, chargeId),
      // max() guards the CHECK (fine_paise >= 0).
      c.db.prepare(`UPDATE invoices SET fine_paise = max(fine_paise - ?2, 0), ${NET_SQL}, updated_at = ?3 WHERE id = ?1`).bind(ch.invoice_id, amount, now()),
      ...syncInvoice(c, ch.invoice_id),
    ])
    return ok({ id: chargeId, status: 'waived' })
  }))

  // --- GST compliant receipt numbering ----------------------------------

  r.get('/finance/fee-engine/receipt-series', READ, fin(async (c) => {
    const [srows, yrows, heads] = await Promise.all([
      c.db.prepare(`SELECT kind, prefix, suffix, padding, next_value, reset_yearly, current_fy, format, last_number, last_issued_at
                      FROM numbering_schemes WHERE campus_id IS NULL ORDER BY kind`).all<Record<string, unknown>>(),
      c.db.prepare(`SELECT COALESCE(receipt_fy, '-') AS fy, count(*) AS issued, min(receipt_seq) AS first_seq, max(receipt_seq) AS last_seq,
                           max(receipt_seq) - min(receipt_seq) + 1 - count(*) AS gaps
                      FROM payments WHERE receipt_seq IS NOT NULL GROUP BY receipt_fy ORDER BY 1 DESC`).all<Record<string, unknown>>(),
      loadFeeHeadOptions(c),
    ])
    const fy = financialYear(today())
    const series = srows.results.map((v) => {
      const row = {
        kind: str(v.kind), prefix: str(v.prefix), suffix: str(v.suffix), padding: p(v.padding), next_value: p(v.next_value), reset_yearly: bool(v.reset_yearly),
        current_fy: optStr(v.current_fy), format: str(v.format), last_number: optStr(v.last_number), last_issued_at: optStr(v.last_issued_at), next_preview: '',
      }
      let useFY = ''
      if (row.reset_yearly) {
        useFY = fy
        // A counter about to roll into a new year restarts at 1.
        if (row.current_fy !== null && row.current_fy !== '' && row.current_fy !== fy) row.next_value = 1
      }
      row.next_preview = renderPreview(row, useFY)
      return omit(row)
    })
    const years = yrows.results.map((v) => ({ fy: str(v.fy), issued: p(v.issued), first_seq: p(v.first_seq), last_seq: p(v.last_seq), gaps: p(v.gaps) }))
    return ok({ items: series, years, heads, current_fy: fy })
  }))

  r.put('/finance/fee-engine/receipt-series/{kind}', MASTERS, fin(async (c) => {
    const kind = str(c.params.kind).trim()
    if (kind === '') throw badRequest('which series?')
    const req = await readJSON<{ prefix?: string; suffix?: string; padding?: number; format?: string; reset_yearly?: boolean }>(c.req)
    let padding = Number(req.padding ?? 0)
    if (!Number.isInteger(padding)) throw badRequest('padding must be a whole number')
    if (padding <= 0) padding = 5
    if (padding > 12) throw badRequest('padding above 12 digits is not a receipt number anybody reads')
    let format = str(req.format).trim()
    if (format === '') format = '{prefix}{fy}/{seq}{suffix}'
    // numbering_schemes_format_has_seq
    if (!format.includes('{seq}')) throw badRequest('the format must contain {seq}, or every receipt in the year renders identically')
    const reset = req.reset_yearly === null || req.reset_yearly === undefined ? true : bool(req.reset_yearly)
    const prefix = str(req.prefix); const suffix = str(req.suffix)
    const t = now()
    // Upsert on (institution_id, kind) WHERE campus_id IS NULL: SQLite's UNIQUE treats NULLs as distinct, so it is an UPDATE then a guarded INSERT.
    await c.db.batch([
      c.db.prepare(`UPDATE numbering_schemes SET prefix = ?3, suffix = ?4, padding = ?5, format = ?6, reset_yearly = ?7, updated_at = ?8
                     WHERE institution_id = ?1 AND kind = ?2 AND campus_id IS NULL`).bind(inst(c), kind, prefix, suffix, padding, format, reset ? 1 : 0, t),
      c.db.prepare(`INSERT INTO numbering_schemes (id, institution_id, kind, prefix, suffix, padding, format, reset_yearly, next_value, updated_at)
                    SELECT ?9, ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8
                     WHERE NOT EXISTS (SELECT 1 FROM numbering_schemes WHERE institution_id = ?1 AND kind = ?2 AND campus_id IS NULL)`)
        .bind(inst(c), kind, prefix, suffix, padding, format, reset ? 1 : 0, t, uuid()),
    ])
    return ok({ kind })
  }))

  r.put('/finance/fee-engine/gst-heads/{id}', MASTERS, fin(async (c) => {
    const headId = uuidParam(c.params.id, 'fee head id')
    const req = await readJSON<{ is_taxable?: boolean; gst_rate_bp?: number; hsn_sac?: string }>(c.req)
    const taxable = bool(req.is_taxable)
    const rate = Number(req.gst_rate_bp ?? 0)
    if (!Number.isInteger(rate)) throw badRequest('gst_rate_bp must be a whole number')
    if (rate < 0 || rate > 10000) throw badRequest('a GST rate is between 0 and 10000 basis points (0% to 100%)')
    if (taxable && rate === 0) throw badRequest('a taxable head needs a rate. Zero-rated and exempt are not the same thing on a return')
    const hsn = str(req.hsn_sac).trim().toUpperCase()
    if (taxable && hsn === '') throw badRequest('a taxable head needs its HSN/SAC code. The invoice cannot be filed without one')
    const res = await c.db.prepare(`UPDATE fee_heads SET is_taxable = ?2, gst_rate_bp = ?3, hsn_sac = NULLIF(?4, '') WHERE id = ?1`)
      .bind(headId, taxable ? 1 : 0, rate, hsn).run()
    if (!res.meta.changes) throw notFound()
    return ok({ id: headId })
  }))
}

