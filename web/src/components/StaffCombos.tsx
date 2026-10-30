import { NavLink, useLocation } from 'react-router-dom'
import { featurePath, useActiveRole, type ApiSection } from '@/lib/catalog'
import { TAB_BAR, tabClass } from '@/components/ui'

/* RELATED SCREENS AS ONE MENU ITEM WITH TABS (Yajur, 2026-10-22), in the staff
   layout only. Each group shows in the menu once, under its first screen the
   person holds; the others open as tabs at the top of the page. Each tab is
   still its own screen and its own grant, so a role without one simply has no
   tab for it. */
export const COMBOS: { slugs: string[]; tabs: string[] }[] = [
  { slugs: ['remarks', 'behaviour', 'anecdotal_records'], tabs: ['Remarks', 'Behaviour', 'Anecdotal records'] },
  // Mail is its own menu item, no longer a tab of Messages (owner, 2026-10-27).
  { slugs: ['report_cards', 'class_teacher_remarks'], tabs: ['Report cards', 'Class teacher remarks'] },
]

/* Screens shown under another group than the catalogue's: marks and report
   cards with Exams, a child's leave with Attendance. */
export const MOVES: Record<string, string> = {
  marks_entry: 'exams',
  report_cards: 'exams',
  class_teacher_remarks: 'exams',
  student_leave_requests: 'attendance',
  concerns_from_parents: 'my_classes',
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

/* THE INSTITUTION ADMIN'S MENU, GROUPED BY KIND OF WORK (owner, 2026-10-30:
   "why in Staff ... and mainly why Branding"). Only the menu changes: each
   screen keeps its key, grants and address, and an old address still opens it
   (lib/catalog useFeature). Screens not named here stay in their own group. */
const ADMIN_GROUPS: [string, string, string[]][] = [
  ['home', 'Home', ['Dashboard']],
  ['home_more', 'Home', ['Approvals', 'School activity', 'Helpdesk']],
  ['school_settings', 'School settings', ['School setup', 'Rules', 'Move from MyClassBoard', 'Branding', 'Roles & permissions', 'Logins & access', 'Privacy', 'Class Setup', 'Year Rollover', 'Mail addresses', 'Message Channels']],
  ['students', 'Students', ['Student 360', 'Class 360', 'Student photographs', 'Groups & lists', 'Certificates & transfers', 'Class Promotion', 'Admissions Pipeline']],
  ['academics', 'Academics', ['Master Timetable', 'Substitutions', 'School Calendar', 'Teacher Assignment', 'Subject overview', 'Curriculum Roadmap', 'Lesson Plans', 'Syllabus Progress', 'Activities & Electives', 'Department academics']],
  ['attendance', 'Attendance', ['Present & absent', 'Attendance Audit']],
  ['exams_all', 'Exams', ['Exams & results', 'Exams & papers', 'Question paper approval', 'Mark moderation', 'Exam seating plan', 'Performance overview']],
  ['fees', 'Fees', ['Fee Dashboard', 'Fee Collection', 'Fee Default', 'Student wallets', 'Period Close']],
  ['communication', 'Communication', ['Messages', 'All messages', 'Inbox', 'Circulars', 'Complaints', 'Class Status', 'Interaction log', 'School Achievements Showcase', 'School Gallery']],
  ['staff', 'Staff', ['Staff groups & lists', 'Staff attendance register', 'Biometric Readers', 'Staff Working Hours', 'Staff Hours This Month', 'Leave Rules & LOP', 'Staff attendance reports', 'Appraisals', 'My pay']],
  ['reports', 'Reports', ['Reports', 'Custom Report Builder', 'Department reports', 'Performance analytics', 'Returns readiness', 'Scheduled digests', 'Instruction Hours']],
]

export function regroupAdmin<W extends { slug: string; name: string; sections: ApiSection[] }>(workspaces: W[]): { slug: string; name: string; sections: ApiSection[] }[] {
  const all = workspaces.flatMap((w) => w.sections.flatMap((s) => s.features.map((f) => ({ s, f }))))
  const placed = new Set<string>()
  const out: { slug: string; name: string; sections: ApiSection[] }[] = []
  for (const [slug, name, names] of ADMIN_GROUPS) {
    const features = names.flatMap((n) => all.filter((x) => x.f.name === n && !placed.has(x.f.key))).map((x) => { placed.add(x.f.key); return x.f })
    if (!features.length) continue
    const section = { ...all.find((x) => x.f.key === features[0].key)!.s, slug, name, workspace: name, features }
    const ws = out.find((w) => w.name === name)
    if (ws) ws.sections.push(section)
    else out.push({ slug, name, sections: [section] })
  }
  for (const w of workspaces) {
    const sections = w.sections.map((s) => ({ ...s, features: s.features.filter((f) => !placed.has(f.key)) })).filter((s) => s.features.length)
    if (sections.length) out.push({ slug: w.slug, name: w.name, sections })
  }
  return out
}
