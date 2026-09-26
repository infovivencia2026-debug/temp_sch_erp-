import type { Ctx } from '../../router'
import { now, uuid } from '../../http'
import { assertInBatch, financialYear, today } from './common'
import { school } from '../school'

/* Port of fees.NextNumberOn: the gapless, per-financial-year receipt and
   invoice series. Postgres serialised cashiers with SELECT ... FOR UPDATE; D1
   has no row locks, so the number is computed from a read and the batch that
   writes the document carries a guard asserting the counter has not moved
   since. A concurrent cashier who took the same number makes the guard fail,
   the whole batch rolls back, and the client retries — the series stays
   gapless and unique, which is what the auditor reads it for. */

export interface Numbered {
  text: string
  seq: number
  fy: string
  /** Statements to prepend to the batch that writes the numbered document. */
  stmts: D1PreparedStatement[]
}

const DEFAULT_PREFIX: Record<string, string> = { receipt: 'RCPT/', invoice: 'INV/' }

function renderNumber(format: string, prefix: string, fy: string, seq: number, padding: number, suffix: string): string {
  if (!format) format = '{prefix}{fy}/{seq}{suffix}'
  if (!fy) for (const d of ['{fy}/', '{fy}-', '/{fy}', '-{fy}']) format = format.split(d).join('')
  return format.split('{prefix}').join(prefix).split('{fy}').join(fy)
    .split('{seq}').join(String(seq).padStart(padding, '0')).split('{suffix}').join(suffix)
}

interface Scheme { prefix: string; suffix: string; padding: number; next_value: number; reset_yearly: number; current_fy: string | null; format: string }

export async function nextNumber(c: Ctx, kind: string, on: string = today()): Promise<Numbered> {
  const inst = school(c).id
  const sel = `SELECT prefix, suffix, padding, next_value, reset_yearly, current_fy, format FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`
  let scheme = await c.db.prepare(sel).bind(inst, kind).first<Scheme>()
  if (!scheme) {
    // Ensure the row exists. A concurrent first caller hits the unique key and
    // we re-read; either way there is exactly one scheme row afterwards.
    try {
      await c.db.prepare(`INSERT INTO numbering_schemes (id, institution_id, kind, prefix, padding, next_value, reset_yearly, updated_at) VALUES (?, ?, ?, ?, 5, 1, 1, ?)`)
        .bind(uuid(), inst, kind, DEFAULT_PREFIX[kind] ?? '', now()).run()
    } catch { /* already there */ }
    scheme = await c.db.prepare(sel).bind(inst, kind).first<Scheme>()
    if (!scheme) throw new Error(`numbering scheme ${kind} missing`)
  }

  const stmts: D1PreparedStatement[] = []
  const resetYearly = !!scheme.reset_yearly
  let seq = Number(scheme.next_value)
  let fy = ''
  const currentFY = scheme.current_fy ?? ''

  if (resetYearly) {
    fy = financialYear(on)
    let seed = 1
    if (currentFY === '' || currentFY === fy) seed = Number(scheme.next_value)
    else if (kind === 'receipt') {
      const last = await c.db.prepare(`SELECT max(receipt_seq) AS n FROM payments WHERE institution_id = ? AND receipt_fy = ?`).bind(inst, fy).first<{ n: number | null }>()
      if (last?.n !== null && last?.n !== undefined) seed = Number(last.n) + 1
    }
    const counter = await c.db.prepare(`SELECT next_value FROM numbering_fy_counters WHERE institution_id = ? AND kind = ? AND fy = ?`)
      .bind(inst, kind, fy).first<{ next_value: number }>()
    if (counter) {
      seq = Number(counter.next_value)
      stmts.push(assertInBatch(c, `(SELECT next_value FROM numbering_fy_counters WHERE institution_id = ? AND kind = ? AND fy = ?) = ?`, [inst, kind, fy, seq]))
      stmts.push(c.db.prepare(`UPDATE numbering_fy_counters SET next_value = ? WHERE institution_id = ? AND kind = ? AND fy = ?`).bind(seq + 1, inst, kind, fy))
    } else {
      seq = seed
      // The primary key makes a concurrent first insert fail the batch.
      stmts.push(c.db.prepare(`INSERT INTO numbering_fy_counters (institution_id, kind, fy, next_value) VALUES (?, ?, ?, ?)`).bind(inst, kind, fy, seq + 1))
    }
  } else {
    stmts.push(assertInBatch(c, `(SELECT next_value FROM numbering_schemes WHERE institution_id = ? AND kind = ? AND campus_id IS NULL) = ?`, [inst, kind, seq]))
  }

  const text = renderNumber(scheme.format, scheme.prefix, fy, seq, Number(scheme.padding), scheme.suffix)
  const t = now()
  if (!resetYearly || currentFY === '' || currentFY <= fy) {
    stmts.push(c.db.prepare(`UPDATE numbering_schemes SET next_value = ?, current_fy = NULLIF(?, ''), last_number = ?, last_issued_at = ?, updated_at = ?
                              WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`).bind(seq + 1, fy, text, t, t, inst, kind))
  } else {
    stmts.push(c.db.prepare(`UPDATE numbering_schemes SET last_number = ?, last_issued_at = ?, updated_at = ? WHERE institution_id = ? AND kind = ? AND campus_id IS NULL`)
      .bind(text, t, t, inst, kind))
  }
  return { text, seq, fy, stmts }
}
