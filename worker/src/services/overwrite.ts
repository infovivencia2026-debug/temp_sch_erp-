import { HttpError } from '../http'

/* Identifying codes are not overwritten without being asked (owner, 2026-10-14).

   A staff code, a reader id, a PAN or an admission number is how other
   records, registers and outside systems find a person. Typing over one by
   mistake breaks those links silently, so a write that would REPLACE a
   non-empty code is refused with 409 'confirm_overwrite' and the list of
   {field, label, from, to}; the web client (lib/confirm-overwrite.tsx) shows
   one dialog and resends with `confirm_overwrite: true` (or
   `overwrite: ['field', ...]`). Filling an empty code is never asked about.
   A value another record already holds is a different refusal,
   'already_used', and no flag gets past it. */

export interface CodeChange { field: string; label: string; from: string | null; to: string | null }

const blank = (v: unknown): boolean => v === null || v === undefined || String(v).trim() === ''
const norm = (v: unknown): string => (blank(v) ? '' : String(v).trim())

/** True when the body says this field may be replaced. */
export function overwriteAllowed(req: unknown, field: string): boolean {
  const r = req as { confirm_overwrite?: unknown; overwrite?: unknown } | null
  if (!r || typeof r !== 'object') return false
  if (r.confirm_overwrite === true) return true
  return Array.isArray(r.overwrite) && r.overwrite.includes(field)
}

/** Takes the flags off a body so routes that reject unknown keys never see them. */
export function stripOverwriteFlags(req: Record<string, unknown>): void {
  delete req.confirm_overwrite
  delete req.overwrite
}

/** The changes that replace a non-empty value with a different one (or clear it).
    `ci` compares without case: PAN and IFSC are stored upper-cased. */
export function replacements(changes: CodeChange[], ci = false): CodeChange[] {
  return changes.filter((c) => {
    const a = norm(c.from), b = norm(c.to)
    if (a === '') return false
    return ci ? a.toUpperCase() !== b.toUpperCase() : a !== b
  })
}

/** Throws 409 confirm_overwrite unless every replacement was confirmed. */
export function guardOverwrite(req: unknown, changes: CodeChange[], ci = false): void {
  const pending = replacements(changes, ci).filter((c) => !overwriteAllowed(req, c.field))
  if (pending.length === 0) return
  const say = pending.map((c) => norm(c.to) === ''
    ? `Clear ${c.label} ${norm(c.from)}?`
    : `Replace ${c.label} ${norm(c.from)} with ${norm(c.to)}?`).join(' ')
  throw new HttpError(409, say, {
    code: 'confirm_overwrite',
    changes: pending.map((c) => ({ field: c.field, label: c.label, from: norm(c.from), to: norm(c.to) || null })),
  })
}

/** 409 already_used: the value belongs to another record of the same kind. */
export function alreadyUsed(field: string, label: string, value: string, holder: string): HttpError {
  return new HttpError(409, `${label} ${value} already belongs to ${holder || 'another record'}`, {
    code: 'already_used', field, value, holder,
  })
}

/** "will replace phone 98… with 97…; PAN ABCDE1234F with nothing" for one row. */
export function describeReplacements(changes: CodeChange[]): string {
  return 'will replace ' + changes.map((c) => (c.to === null || String(c.to).trim() === ''
    ? `${c.label} ${c.from} with nothing` : `${c.label} ${c.from} with ${String(c.to).trim()}`)).join('; ')
}
