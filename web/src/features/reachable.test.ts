import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative, normalize, dirname } from 'node:path'

/* EVERY FEATURE SCREEN IS REACHABLE FROM SOMETHING.
 *
 * A screen reaches a person one way: a catalogue key in one of the `*-keys.ts`
 * files maps to `screen(() => import('./Thing'))`, and App.tsx looks the key up
 * through `componentFor`. Miss that one line and the file still compiles, still
 * type-checks, still passes its own tests -- and is dead. `componentFor`
 * returns undefined and App renders `CataloguedStub`, the "catalogued but not
 * built" placeholder, for something that is very much built.
 *
 * Forty-four components were in that state when this test was written. Twelve
 * have since been deleted: every endpoint each of them called was already
 * served by a screen that IS wired, so they were duplicates of live work
 * rather than work waiting for a door -- portal/Alerts against the wired
 * Notifications, ops2/Hostel against WardenDay, and so on.
 *
 * The thirty-two left are not duplicates. Each one is the ONLY caller of at
 * least one endpoint the server actually serves, so deleting it would strand
 * a working API with nothing to reach it. Whether each gets a catalogue key
 * or goes is a product decision a test cannot make, so this freezes them.
 *
 * The number can only go down. Wire one, or delete one, and take it out of
 * KNOWN. Add a new unreachable screen and this fails, naming it -- which is
 * the whole point, because the failure mode is silent everywhere else.
 */

const SRC = resolve(process.cwd(), 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return walk(p)
    return p.endsWith('.ts') || p.endsWith('.tsx') ? [p] : []
  })
}

/** Every module path imported anywhere, statically or lazily, without extension. */
function importedModules(files: string[]): Set<string> {
  const out = new Set<string>()
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    const here = dirname(file)
    for (const re of [
      /import\(\s*['"]([^'"]+)['"]\s*\)/g,
      /from\s+['"]([^'"]+)['"]/g,
    ]) {
      for (const m of src.matchAll(re)) {
        const spec = m[1]
        if (spec.startsWith('.')) out.add(normalize(join(here, spec)))
        else if (spec.startsWith('@/')) out.add(normalize(join(SRC, spec.slice(2))))
      }
    }
  }
  return out
}

/* Unreachable as of the day this test landed. Sorted, repo-relative, no
   extension. Shrink it; never grow it. */
const KNOWN = new Set([
  'features/academics/ExamMonitoring',
  'features/academics/Outcomes',
  'features/admissions/CampaignSequences',
  'features/admissions/FormBuilder',
  'features/analytics/Today',
  'features/bento/BentoMenuBar',
  'features/communication/AbsenceAlerts',
  'features/compliance/BoardLOC',
  'features/compliance/ChildInfoReconciliation',
  'features/compliance/SQAACompliance',
  'features/exams/BaselineAnalysis',
  'features/exams/BoardResultImport',
  'features/exams/HolisticCard',
  'features/exams/IntermediateRegistration',
  'features/exams/SSCRegistration',
  'features/faculty/ExamGrading',
  'features/faculty/MontessoriTracking',
  'features/faculty/PortfolioBuilder',
  'features/faculty/VirtualClasses',
  'features/learning/CreditBank',
  'features/operations/FeeFiling',
  'features/operations/MDMRegister',
  'features/operations/MDMUtilisation',
  'features/operations/Workspace',
  'features/portal/Concerns',
  'features/portal/Forum',
  'features/setup/PeriodUpload',
  'features/students/Alumni',
  'features/students/CertificateTemplates',
  'features/students/DepartmentStudents',
  'features/students/StudentCouncil',
  'features/super_admin/Leads',
])

describe('every feature screen is reachable', () => {
  const files = walk(SRC)
  const imported = importedModules(files)

  const unreachable = files
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
    .filter((f) => f.startsWith(join(SRC, 'features')))
    .map((f) => f.slice(0, -4))
    .filter((f) => !imported.has(normalize(f)))
    .map((f) => relative(SRC, f).split('\\').join('/'))
    .sort()

  it('adds no new unreachable screen', () => {
    expect(unreachable.filter((f) => !KNOWN.has(f))).toEqual([])
  })

  it('does not list a screen that has since been wired or deleted', () => {
    const live = new Set(unreachable)
    expect([...KNOWN].filter((f) => !live.has(f)).sort()).toEqual([])
  })
})
