import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/* NO HAND-ROLLED DROPDOWNS (owner, 2026-10-24: "NEXT TIME I SHOULD NOT SEE
   THIS TYPE OF BUG"). Every dropdown goes through Select / PickerMenu, which
   open the shared OptionSheet on phones. A new native <select>, <datalist>,
   combobox or listbox outside these files fails this test. Before adding to
   the allowlist, use the shared component instead. */
const ALLOWED: Record<string, string> = {
  'components/ui.tsx': 'the shared Select (desktop combobox)',
  'components/PickerMenu.tsx': 'the shared PickerMenu',
  'components/OptionSheet.tsx': 'the shared phone sheet',
  'features/bento/SettingsRows.tsx': 'DropdownRow, uses OptionSheet on phones',
  'features/admissions/FrontDesk.tsx': 'inline result list, not a dropdown',
  'features/students/StudentPhotos.tsx': 'photo grid selection, not a dropdown',
  'features/super_admin/TriggerRules.tsx': 'vendor-only free-text code field with suggestions',
}
const BAD = /<select[\s>]|<datalist[\s>]|role=["']combobox["']|role=["']listbox["']/

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p)
  }
  return out
}

describe('dropdown guard', () => {
  it('has no hand-rolled dropdowns outside the shared components', () => {
    const root = join(__dirname, '..')
    const hits: string[] = []
    for (const f of walk(root)) {
      const rel = relative(root, f).split(sep).join('/')
      if (ALLOWED[rel]) continue
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (BAD.test(code)) hits.push(rel)
    }
    expect(hits, 'Use Select or PickerMenu from components/ (see CLAUDE.md "Dropdowns")').toEqual([])
  })
})
