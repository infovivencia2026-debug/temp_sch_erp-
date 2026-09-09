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
 * Forty-four components were in that state when this test was written: about
 * twelve thousand lines that nothing imports, lazily or otherwise. Some are
 * superseded twins of a screen that IS wired (SQAACompliance beside the wired
 * SQAAFramework); some look like finished work that never got its line. Which
 * is which is a product decision and not one a test can make, so this does not
 * try to: it freezes the list.
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
  'features/communication/PTMReminders',
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
  'features/faculty/StudyMaterials',
  'features/faculty/VirtualClasses',
  'features/learning/CreditBank',
  'features/operations/FeeFiling',
  'features/operations/MDMRegister',
  'features/operations/MDMUtilisation',
  'features/operations/Workspace',
  'features/ops2/Hostel',
  'features/ops2/Inventory',
  'features/portal/Alerts',
  'features/portal/Concerns',
  'features/portal/Documents',
  'features/portal/DriverCall',
  'features/portal/Forum',
  'features/portal/ParentAttention',
  'features/portal/Reminders',
  'features/portal/TransportSnapshot',
  'features/principal/StaffWorkload',
  'features/setup/Checklist',
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
