import { NavLink, useLocation } from 'react-router-dom'
import { featurePath, useActiveRole } from '@/lib/catalog'
import { TAB_BAR, tabClass } from '@/components/ui'

/* RELATED SCREENS AS ONE MENU ITEM WITH TABS (Yajur, 2026-10-22), in the staff
   layout only. Each group shows in the menu once, under its first screen the
   person holds; the others open as tabs at the top of the page. Each tab is
   still its own screen and its own grant, so a role without one simply has no
   tab for it. */
export const COMBOS: { slugs: string[]; tabs: string[] }[] = [
  { slugs: ['remarks', 'behaviour', 'anecdotal_records'], tabs: ['Remarks', 'Behaviour', 'Anecdotal records'] },
  { slugs: ['messages', 'inbox'], tabs: ['Messages', 'Inbox'] },
  { slugs: ['report_cards', 'class_teacher_remarks'], tabs: ['Report cards', 'Class teacher remarks'] },
]

/* Screens shown under another group than the catalogue's: marks and report
   cards with Exams, a child's leave with Attendance. */
export const MOVES: Record<string, string> = {
  marks_entry: 'exams',
  report_cards: 'exams',
  class_teacher_remarks: 'exams',
  student_leave_requests: 'attendance',
}

export const comboOf = (slug: string) => COMBOS.find((c) => c.slugs.includes(slug))

/** Where each of the role's screens lives: slug -> path. */
function usePaths(): Map<string, string> {
  const role = useActiveRole()
  const out = new Map<string, string>()
  for (const s of role.sections ?? []) for (const f of s.features) if (f.in_scope && f.live && !out.has(f.slug)) out.set(f.slug, featurePath(role.key, s.slug, f.slug))
  return out
}

/** The tabs over a screen that belongs to a group; nothing for any other screen. */
export function ComboTabs() {
  const { pathname } = useLocation()
  const paths = usePaths()
  const slug = pathname.split('/')[3] ?? ''
  const combo = comboOf(slug)
  if (!combo) return null
  const tabs = combo.slugs.map((s, i) => ({ slug: s, label: combo.tabs[i], to: paths.get(s) })).filter((t) => t.to)
  if (tabs.length < 2) return null
  return (
    <div className={`${TAB_BAR} mb-4`} role="tablist">
      {tabs.map((t) => (
        <NavLink key={t.slug} to={t.to!} role="tab" aria-selected={t.slug === slug} className={tabClass(t.slug === slug)}>{t.label}</NavLink>
      ))}
    </div>
  )
}
