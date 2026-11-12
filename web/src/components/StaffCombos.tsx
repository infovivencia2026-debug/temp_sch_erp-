import { NavLink, useLocation } from 'react-router-dom'
import { featurePath, useActiveRole, type ApiSection } from '@/lib/catalog'
import { TAB_BAR, tabClass } from '@/components/ui'

/* RELATED SCREENS AS ONE MENU ITEM WITH TABS (Yajur, 2026-10-22), in the staff
   layout only. Each group shows in the menu once, under its first screen the
   person holds; the others open as tabs at the top of the page. Each tab is
   still its own screen and its own grant, so a role without one simply has no
   tab for it. */
export const COMBOS: { slugs: string[]; tabs: string[] }[] = [
  { slugs: ['remarks', 'behaviour'], tabs: ['Remarks', 'Behaviour'] },
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
  ['home_more', 'Home', ['Today at school', 'Approvals', 'School activity', 'Helpdesk']],
  ['school_settings', 'School settings', ['School setup', 'Rules', 'Move from MyClassBoard', 'Branding', 'Roles & permissions', 'Logins & access', 'Privacy', 'Mail addresses', 'Message Channels']],
  ['students', 'Students', ['Student 360', 'Class 360', 'Student photographs', 'Groups & lists', 'Certificates & transfers', 'Class Promotion', 'Student council', 'Admissions Pipeline']],
  ['academics', 'Academics', ['Class Setup', 'Year Rollover', 'Master Timetable', 'Substitutions', 'School Calendar', 'Teacher Assignment', 'Subject overview', 'Curriculum Roadmap', 'Lesson Plans', 'Syllabus Progress', 'Activities & Electives', 'Department academics']],
  ['attendance', 'Attendance', ['Present & absent', 'Attendance Audit']],
  ['exams_all', 'Exams', ['Exams & results', 'Exams & papers', 'Question paper approval', 'Mark moderation', 'Exam seating plan', 'Performance overview']],
  ['fees', 'Fees', ['Fee Dashboard', 'Fee Collection', 'Fee Default', 'Student wallets', 'Period Close']],
  ['communication', 'Communication', ['Messages', 'All messages', 'Inbox', 'Circulars', 'Complaints', 'Class Status', 'Interaction log', 'School Achievements Showcase', 'School Gallery']],
  ['staff', 'Staff', ['Staff groups & lists', 'Staff attendance register', 'Biometric Readers', 'Staff Working Hours', 'Staff Hours This Month', 'Leave Rules & LOP', 'Staff attendance reports', 'Appraisals', 'My pay']],
  ['reports', 'Reports', ['Reports', 'Custom Report Builder', 'Department reports', 'Performance analytics', 'Returns readiness', 'Scheduled digests', 'Instruction Hours', 'Child Info reconciliation', 'SQAA compliance', 'Mid-day meal return']],
]

export function regroupAdmin<W extends { slug: string; name: string; sections: ApiSection[] }>(workspaces: W[]): { slug: string; name: string; sections: ApiSection[] }[] {
  const all = workspaces.flatMap((w) => w.sections.flatMap((s) => s.features.map((f) => ({ s, f }))))
  const placed = new Set<string>()
  const out: { slug: string; name: string; sections: ApiSection[] }[] = []
  for (const [slug, name, names] of ADMIN_GROUPS) {
    /* Once per screen: a screen listed under several sections (Messages is in
       four) was placed once per listing, and the whole group drew four times. */
    const features = names.flatMap((n) => all.filter((x) => x.f.name === n)).filter((x) => {
      if (placed.has(x.f.key)) return false
      placed.add(x.f.key)
      return true
    }).map((x) => x.f)
    if (!features.length) continue
    const section = { ...all.find((x) => x.f.key === features[0].key)!.s, slug, name, workspace: name, features }
    const ws = out.find((w) => w.name === name)
    if (ws) ws.sections.push(section)
    else out.push({ slug, name, sections: [section] })
  }
  for (const w of workspaces) {
    const sections = w.sections.map((s) => ({ ...s, features: s.features.filter((f) => !placed.has(f.key)) })).filter((s) => s.features.length)
    if (!sections.length) continue
    /* A leftover with a group's name (Mail under Communication) joins that
       group; pushed as its own, the menu drew Communication five times. */
    const same = out.find((o) => o.name === w.name)
    if (same) same.sections.push(...sections)
    else out.push({ slug: w.slug, name: w.name, sections })
  }
  /* One section per slug: the menu files screens by section slug, and several
     sections sharing 'communication' each drew the whole merged list. */
  for (const w of out) {
    const bySlug = new Map<string, ApiSection>()
    for (const sec of w.sections) {
      const have = bySlug.get(sec.slug) ?? [...bySlug.values()].find((x) => x.name === sec.name)
      if (have) have.features = [...have.features, ...sec.features.filter((f) => !have.features.some((x) => x.key === f.key))]
      else bySlug.set(sec.slug, { ...sec, features: [...sec.features] })
    }
    w.sections = [...bySlug.values()]
  }
  return out
}

/* Other roles: a few screens filed under the wrong group (owner, 2026-10-31).
   Feature slug -> [group slug, group name]; an existing group of that slug
   takes it, otherwise a new group is added at the end. */
const ROLE_MOVES: Record<string, Record<string, [string, string]>> = {
  finance: { store_catalogue: ['stores', 'Stores'] },
  super_admin: { white_label_branding: ['institution_setup', 'Institution Setup'] },
}

/** One group per section slug (HOD had "My Profile" twice), then the role's moves. */
export function regroupRole<W extends { slug: string; name: string; sections: ApiSection[] }>(roleKey: string, workspaces: W[]): { slug: string; name: string; sections: ApiSection[] }[] {
  const seen = new Map<string, ApiSection>()
  const out: { slug: string; name: string; sections: ApiSection[] }[] = []
  for (const w of workspaces) {
    const sections: ApiSection[] = []
    for (const s of w.sections) {
      const first = seen.get(s.slug)
      if (first) { first.features = [...first.features, ...s.features]; continue }
      const copy = { ...s, features: [...s.features] }
      seen.set(s.slug, copy)
      sections.push(copy)
    }
    if (sections.length) out.push({ slug: w.slug, name: w.name, sections })
  }
  const moves = ROLE_MOVES[roleKey]
  if (!moves) return out
  for (const [slug, [to, name]] of Object.entries(moves)) {
    const from = out.flatMap((w) => w.sections).find((s) => s.features.some((f) => f.slug === slug))
    if (!from || from.slug === to) continue
    const f = from.features.find((x) => x.slug === slug)!
    from.features = from.features.filter((x) => x.slug !== slug)
    const target = out.flatMap((w) => w.sections).find((s) => s.slug === to)
    if (target) target.features = [...target.features, f]
    else out.push({ slug: to, name, sections: [{ ...from, slug: to, name, workspace: name, features: [f] }] })
  }
  return out.map((w) => ({ ...w, sections: w.sections.filter((s) => s.features.length) })).filter((w) => w.sections.length)
}
