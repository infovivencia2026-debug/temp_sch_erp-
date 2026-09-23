import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/* EVERY WIRED SCREEN HANGS OFF A KEY THE CATALOGUE STILL HAS.
 *
 * A screen reaches a person through a catalogue key: `'role.section.slug':
 * screen(() => import('./Thing'))` in registry.ts or one of the `*-keys.ts`
 * files. reachable.test.ts guards the other half -- a screen file nobody
 * imports -- and cannot see this one, because these screens ARE imported.
 * Their key simply no longer exists in catalog.gen.ts: the feature was
 * renamed, re-sectioned or dropped from docs/edu_features.csv, and the SPA
 * went on mapping a key the menu will never emit. The screen compiles,
 * type-checks, and is dead; even a direct URL answers "not in your
 * workspace". live-tracking-keys.ts records this happening once already.
 *
 * 20 keys were in that state when this test was written, nine of them
 * the only door to a finished screen with live endpoints behind it. They are
 * frozen below. Wire one to a real key, or delete it, and take it out of
 * KNOWN. Add a new dead key and this fails, naming it.
 */

const SRC = resolve(process.cwd(), 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return walk(p)
    return p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : []
  })
}

/** Keys the catalogue actually defines. */
function catalogKeys(): Set<string> {
  const src = readFileSync(join(SRC, 'catalog.gen.ts'), 'utf8')
  return new Set([...src.matchAll(/\bkey:\s*'([^']+)'/g)].map((m) => m[1]))
}

/** Every key mapped to a screen, and the file that maps it. */
function mappedKeys(): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of walk(join(SRC, 'features'))) {
    if (!(file.endsWith('registry.ts') || file.endsWith('-keys.ts'))) continue
    const src = readFileSync(file, 'utf8')
    // Both spellings a keys file uses: screen(() => import(...)) and the
    // older bare lazy(() => import(...)).
    for (const m of src.matchAll(/'([a-z_]+\.[a-z_0-9]+\.[a-z_0-9]+)':\s*(?:screen|lazy)\(/g)) {
      out.set(m[1], file.slice(SRC.length + 1))
    }
  }
  return out
}

/* Dead as of the day this test landed. Shrink it; never grow it. */
const KNOWN = new Set<string>([
  'finance.export.tally_prime_xml_export',
  'finance.student_dues.automated_fee_reminders',
  'hr.reports.hr_reports',
  'institution_admin.analysis.custom_report_builder',
  'institution_admin.analysis.department_reports',
  'institution_admin.analysis.performance_analytics',
  'institution_admin.department.department_academics',
  'institution_admin.department.department_timetable',
  'institution_admin.directory_workload.faculty_directory',
  'institution_admin.directory_workload.teacher_workload_timetable_overview',
  'institution_admin.evaluation.appraisals',
  'institution_admin.library.annual_book_stock_verification',
  'institution_admin.library.digital_library_usage',
  'institution_admin.library.fine_penalty_summary',
  'institution_admin.library.new_session_textbook_orders',
  'institution_admin.statutory_returns.govt_returns',
  'institution_admin.statutory_returns.instruction_hours',
  'institution_admin.stores.department_stock_issuance',
  'institution_admin.stores.item_category_store_setup',
  'institution_admin.stores.purchase_order_workflow',
])

describe('every wired screen key exists in the catalogue', () => {
  const catalog = catalogKeys()
  const mapped = mappedKeys()
  const dead = [...mapped.keys()].filter((k) => !catalog.has(k)).sort()

  it('adds no new dead key', () => {
    expect(dead.filter((k) => !KNOWN.has(k))).toEqual([])
  })

  it('does not list a key that has since been fixed', () => {
    const live = new Set(dead)
    expect([...KNOWN].filter((k) => !live.has(k)).sort()).toEqual([])
  })
})
