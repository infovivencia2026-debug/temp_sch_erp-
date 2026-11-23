import { useState, type ReactNode } from 'react'
import { Badge, Card, Select, Switch, SEG_BAR, segClass } from '@/components/ui'
import { SearchBox } from '@/components/rows'
import { cn } from '@/lib/utils'

/* One grantable screen, as served by GET /api/v1/admin/features: one item per
   catalogue KEY. The same name in two workspaces is usually two screens ("Take
   attendance" for a teacher is their register; for the office it is the
   school's register with import and export), so it is listed, held and
   granted by its exact key, with the workspace it belongs to beside it. */
export interface FeatureItem {
  key: string
  name: string
  summary: string
  unlocks: string[]
  role_key: string
  role_name: string
  section: string
}

/* GENERAL: the self-service screens that are one screen in every workspace.
   Each slug below is served under 5 to 21 workspaces and every one of those
   keys opens the same component in features/registry.ts (comms/Inbox,
   comms/StaffMessages, hr/Leave, me/MyPay), showing the person's own mail,
   threads, leave or payslips whichever workspace they open it from. Listed
   once; granting it grants every variant key so it works wherever they are.
   subject_overview also shares one component across three workspaces but is
   scoped to the subjects a person heads, so it stays with its workspace. */
const GENERAL_SLUGS = ['inbox', 'messages', 'leave_self_service', 'my_pay']

/** One screen as the person sees it: a single key, or a General screen covering many. */
interface Entry {
  id: string
  name: string
  summary: string
  workspace: string
  keys: string[]
}

function entries(items: FeatureItem[]): Entry[] {
  const general: Entry[] = []
  const rest: Entry[] = []
  for (const f of items) {
    const slug = f.key.split('.').pop() ?? ''
    if (GENERAL_SLUGS.includes(slug)) {
      const e = general.find((g) => g.id === slug)
      if (e) e.keys.push(f.key)
      else general.push({ id: slug, name: f.name, summary: f.summary, workspace: 'General', keys: [f.key] })
      continue
    }
    rest.push({ id: f.key, name: f.name, summary: f.summary, workspace: f.role_name, keys: [f.key] })
  }
  return [...general, ...rest]
}

type Status = 'all' | 'active' | 'role' | 'direct' | 'none'

/* VIEW vs EDIT FOR EVERY SCREEN THAT HAS AN EDIT (Yajur, 2026-11-21: "all who
   has view options there should also be edit too, and can choose that while
   giving in Login & access"). A screen on its own is View. The "edit action"
   is the single permission key that turns that page's buttons on — e.g. Student
   360's Edit is students.write, Take fee payment's is finance.payments.write.

   A feature key reads role.section.slug, so the SECTION (middle) tells us the
   domain, and the table below maps each editable section to the exact write
   key the screens actually check (these are the real, domain-prefixed keys,
   confirmed against the code — not guessed). A section that is missing here is
   read-only (reports, dashboards, home) and gets no Edit switch. Granting Edit
   never happens on its own: the admin chooses it per login, and nobody who
   already holds a permission is touched. */
const WRITE_BY_SECTION: Record<string, { editKey: string; label: string }> = {
  students: { editKey: 'students.write', label: 'Student records' },
  academics: { editKey: 'academics.write', label: 'Academics' },
  staff: { editKey: 'hr.employees.write', label: 'Staff records' },
  employees: { editKey: 'hr.employees.write', label: 'Staff records' },
  attendance: { editKey: 'academics.attendance.write', label: 'Attendance' },
  /* The `communication` section is a grab-bag: circulars, grievances, Connect
     and plain mail each gate on a DIFFERENT permission, so it is NOT mapped by
     section — every communication screen's edit key is pinned by slug in
     WRITE_BY_SLUG below, and a slug that isn't listed there gets no Edit switch
     rather than a wrong one. */
  fees: { editKey: 'finance.fees.write', label: 'Fees' },
  payments: { editKey: 'finance.payments.write', label: 'Payments' },
  invoices: { editKey: 'finance.invoices.write', label: 'Invoices' },
  refunds: { editKey: 'finance.refunds.write', label: 'Refunds' },
  wallet: { editKey: 'finance.wallet.manage', label: 'Wallet' },
  announcements: { editKey: 'comms.announcements.write', label: 'Announcements' },
  connect: { editKey: 'comms.connect.write', label: 'Connect' },
  homework: { editKey: 'academics.homework.write', label: 'Homework' },
  marks: { editKey: 'academics.marks.write', label: 'Marks' },
  marks_report_cards: { editKey: 'academics.marks.write', label: 'Marks' },
  reportcards: { editKey: 'academics.marks.write', label: 'Marks' },
  exams_results: { editKey: 'academics.marks.write', label: 'Marks' },
  exams: { editKey: 'academics.exams.write', label: 'Exams' },
  examinations: { editKey: 'academics.exams.write', label: 'Exams' },
  board_exams: { editKey: 'academics.exams.write', label: 'Exams' },
  assessment_schemes: { editKey: 'academics.exams.write', label: 'Exams' },
  timetable: { editKey: 'academics.timetable.write', label: 'Timetable' },
  discipline: { editKey: 'welfare.discipline.write', label: 'Discipline' },
  health: { editKey: 'welfare.health.write', label: 'Health' },
  clinic: { editKey: 'welfare.health.write', label: 'Health' },
  library: { editKey: 'operations.library.write', label: 'Library' },
  transport: { editKey: 'operations.transport.write', label: 'Transport' },
  hostel: { editKey: 'operations.hostel.write', label: 'Hostel' },
  inventory: { editKey: 'operations.inventory.write', label: 'Inventory' },
  stores: { editKey: 'operations.inventory.write', label: 'Inventory' },
  store: { editKey: 'operations.inventory.write', label: 'Inventory' },
  assets: { editKey: 'operations.assets.write', label: 'Assets' },
  admissions: { editKey: 'admissions.write', label: 'Admissions' },
  enquiries: { editKey: 'admissions.write', label: 'Admissions' },
  applications: { editKey: 'admissions.write', label: 'Admissions' },
  payroll: { editKey: 'hr.payroll.write', label: 'Payroll' },
  front_desk: { editKey: 'office.front_desk.write', label: 'Front desk' },
  desk: { editKey: 'office.front_desk.write', label: 'Front desk' },
  roles: { editKey: 'access.roles.write', label: 'Roles' },
  access: { editKey: 'access.users.write', label: 'Logins' },
  access_security: { editKey: 'access.users.write', label: 'Logins' },
  settings: { editKey: 'institution.settings.write', label: 'Settings' },
  institution_setup: { editKey: 'institution.settings.write', label: 'Settings' },
  integrations: { editKey: 'institution.integrations.write', label: 'Integrations' },
  campuses: { editKey: 'institution.campuses.write', label: 'Campuses' },
  campuses_academic_year: { editKey: 'institution.campuses.write', label: 'Campuses' },
  plans: { editKey: 'platform.plans.write', label: 'Plans' },
  tenants: { editKey: 'platform.tenants.write', label: 'Schools' },
  my_profile: { editKey: 'self.profile.write', label: 'Own profile' },
  profile: { editKey: 'self.profile.write', label: 'Own profile' },
}

/* A few screens sit in a broad section but gate on their OWN permission, so the
   slug is checked before the section. Website forms lives under `communication`
   but needs comms.website_forms.write — without this it would wrongly offer the
   Messages (comms.mail.write) key and the screen would stay shut. (Yajur,
   2026-11-21: a receptionist granted "Edit" on Website forms could open
   nothing.) Add a row here whenever a screen's edit key differs from its
   section's. */
const WRITE_BY_SLUG: Record<string, { editKey: string; label: string }> = {
  website_forms: { editKey: 'comms.website_forms.write', label: 'Edit forms' },
  /* Communication screens, each pinned to the permission its own route checks
     (confirmed in worker/src/routes/comms). Circulars and the achievements
     showcase are announcements; grievances and parent concerns are the front
     desk; Yajur Connect is its own; the address book is mail.manage. Plain
     mail/inbox screens are self-service and carry no admin Edit. */
  circulars: { editKey: 'comms.announcements.write', label: 'Circulars' },
  circulars_from_school: { editKey: 'comms.announcements.write', label: 'Circulars' },
  /* The showcase is a students-domain screen: its entries read students.read
     and edit students.write (only publish/unpublish uses announcements.write),
     so Edit here is students.write. The person also needs Student records view
     to open the list, since write does not imply read. */
  school_achievements_showcase: { editKey: 'students.write', label: 'Student records' },
  grievances: { editKey: 'office.front_desk.write', label: 'Grievances' },
  concerns: { editKey: 'office.front_desk.write', label: 'Concerns' },
  concerns_from_parents: { editKey: 'office.front_desk.write', label: 'Concerns' },
  parent_concerns: { editKey: 'office.front_desk.write', label: 'Concerns' },
  yajur_connect: { editKey: 'comms.connect.write', label: 'Connect' },
  mail_addresses: { editKey: 'comms.mail.manage', label: 'Address book' },
  /* STAFF-WORKSPACE ADMIN SCREENS. They sit under the `staff` section but are
     NOT employee-record edits, so hr.employees.write is the wrong key — each
     gates on its own permission (audited against worker/src/routes, 2026-11-21). */
  logins_access: { editKey: 'access.users.write', label: 'Logins' },
  roles_permissions: { editKey: 'access.roles.write', label: 'Roles' },
  privacy: { editKey: 'access.users.write', label: 'Privacy' },
  branding: { editKey: 'institution.settings.write', label: 'Branding' },
  leaves_subs: { editKey: 'hr.leave.approve', label: 'Leave approvals' },
  /* FEES GRAB-BAG. Taking a payment, topping up a wallet and correcting a
     receipt are NOT finance.fees.write — they are their own powers. */
  take_fee_payment: { editKey: 'finance.payments.write', label: 'Take payment' },
  fee_corrections: { editKey: 'finance.payments.write', label: 'Corrections' },
  student_wallets: { editKey: 'finance.wallet.manage', label: 'Wallet' },
  period_close: { editKey: 'institution.settings.write', label: 'Period close' },
  /* Report cards are generated/published, not marks-entered. */
  report_cards: { editKey: 'academics.reportcards.generate', label: 'Report cards' },
}

/* Screens that are read-only, or whose edit power we have not verified: they get
   NO Edit switch at all, rather than a wrong one. The interaction log is an
   audit view (admin.audit.read, no write); teacher remarks' write key is
   ambiguous between marks and conduct, so it is left off until confirmed. */
const NO_EDIT_SLUGS = new Set(['interaction_log', 'teacher_remarks'])

/* The edit action for a feature: its own slug wins, else its section. The key
   is role.section.slug. `attendance` is the one section serving two screens —
   the class register (academics) and the staff register (HR) — so a staff/HR
   workspace swaps in the HR write key. */
function editActionFor(key: string, workspace: string): { editKey: string; label: string } | undefined {
  const parts = key.split('.')
  const slug = parts[parts.length - 1] ?? ''
  if (NO_EDIT_SLUGS.has(slug)) return undefined
  const bySlug = WRITE_BY_SLUG[slug]
  if (bySlug) return bySlug
  const section = parts[1] ?? ''
  const a = WRITE_BY_SECTION[section]
  if (!a) return undefined
  if (section === 'attendance' && /staff|hr|employee|payroll/i.test(workspace))
    return { editKey: 'hr.attendance.write', label: 'Staff attendance' }
  return a
}

/* Every built feature as one flat list, each with a switch: on means the
   person can open it. From a role: on and locked, the role is what to change.
   Direct: on, can be turned off. Inactive: off, turning it on grants it to
   this person directly. `roleGrants` maps a key to the names of the roles
   granting it; `direct` is their direct set. `header` receives the counts so
   the card above can say how many they hold. */
export function FeatureAccess({ items, roleGrants, direct, busy, onChange, header }: {
  items: FeatureItem[]
  roleGrants: Map<string, string[]>
  direct: Set<string>
  busy: boolean
  onChange: (keys: string[], on: boolean) => void
  header: (held: number, total: number) => ReactNode
}) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<Status>('all')
  const [workspace, setWorkspace] = useState('')
  const list = entries(items)
  const workspaces = [...new Set(list.map((e) => e.workspace))]

  const fromRoles = (e: Entry) => [...new Set(e.keys.flatMap((k) => roleGrants.get(k) ?? []))]
  const stateOf = (e: Entry): Exclude<Status, 'all' | 'active'> =>
    fromRoles(e).length ? 'role' : e.keys.some((k) => direct.has(k)) ? 'direct' : 'none'
  const count = (s: Status) => list.filter((e) => s === 'all' || (s === 'active' ? stateOf(e) !== 'none' : stateOf(e) === s)).length
  const tabs: { key: Status; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: `Active (${count('active')})` },
    { key: 'role', label: `From role (${count('role')})` },
    { key: 'direct', label: `Direct (${count('direct')})` },
    { key: 'none', label: `Inactive (${count('none')})` },
  ]

  const q = search.trim().toLowerCase()
  const shown = list.filter((e) => {
    if (workspace && e.workspace !== workspace) return false
    const s = stateOf(e)
    if (status === 'active' ? s === 'none' : status !== 'all' && s !== status) return false
    return !q || e.name.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || e.workspace.toLowerCase().includes(q)
  })

  return (
    <div className="min-w-0 space-y-3">
      {header(count('active'), list.length)}
      <div className="rounded-xl border border-warning/30 bg-warning/[0.07] px-4 py-3 text-[13px]">
        Access normally comes from roles. Use this screen only for one-off extras.
      </div>
      <Card className="min-w-0">
        <div className="flex min-w-0 flex-wrap gap-2 p-[var(--card-pad)]">
          <SearchBox value={search} onChange={setSearch} placeholder="Search features" className="w-full min-w-0 flex-1 sm:min-w-[200px]" />
          <div className="w-full sm:w-56">
            <Select value={workspace} onChange={setWorkspace} options={[{ value: '', label: 'All workspaces' }, ...workspaces.map((w) => ({ value: w, label: w }))]} />
          </div>
        </div>
      </Card>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className={SEG_BAR} role="group" aria-label="Show">
            {tabs.map((s) => (
              <button key={s.key} type="button" aria-pressed={status === s.key} onClick={() => setStatus(s.key)} className={cn(segClass(status === s.key), 'whitespace-nowrap')}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <span className="shrink-0 text-[12.5px] text-muted-foreground">{list.length} total</span>
      </div>
      <Card className="min-w-0">
        {shown.length === 0 ? (
          <p className="p-[var(--card-pad)] text-[13px] text-muted-foreground">No features match.</p>
        ) : (
          <ul className="divide-y">
            {shown.map((e) => {
              const s = stateOf(e)
              const roles = fromRoles(e)
              /* The edit action for this screen, when it has one and the person
                 can actually open the screen (an Edit switch on a screen they
                 cannot reach would grant a power with nowhere to use it). */
              const action = s !== 'none' ? editActionFor(e.keys[0] ?? e.id, e.workspace) : undefined
              const editFromRole = action ? (roleGrants.get(action.editKey) ?? []) : []
              const editOn = action ? (editFromRole.length > 0 || direct.has(action.editKey)) : false
              const editLocked = editFromRole.length > 0
              return (
                <li key={e.id} className="px-[var(--card-pad)] py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">{e.name}</span>
                      <span className="block truncate text-[12.5px] text-muted-foreground">
                        {s === 'role' ? `From ${roles.join(', ')}` : e.summary || e.workspace}
                      </span>
                      <span className="block truncate text-[12px] text-muted-foreground">{e.workspace}</span>
                    </span>
                    <Badge tone={s === 'role' ? 'success' : s === 'direct' ? 'primary' : 'neutral'}>
                      {s === 'role' ? 'From role' : s === 'direct' ? 'Direct' : 'Inactive'}
                    </Badge>
                    <Switch
                      on={s !== 'none'}
                      disabled={s === 'role' || busy}
                      label={e.name}
                      title={s === 'role' ? 'Given by a role. Change their roles to remove it.' : undefined}
                      onChange={(on) => onChange(e.keys, on)}
                    />
                  </div>
                  {/* View vs Edit for a screen that carries an action. View =
                      can open, cannot change; Edit = can change. The admin
                      flips it here unless a role already grants the edit. */}
                  {action && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 pl-0.5">
                      <span className="text-[12px] text-muted-foreground">{action.label}:</span>
                      <div className={SEG_BAR} role="group" aria-label={`${e.name}: view or edit`}>
                        <button
                          type="button" aria-pressed={!editOn} disabled={busy || editLocked}
                          onClick={() => onChange([action.editKey], false)}
                          className={cn(segClass(!editOn), 'whitespace-nowrap')}
                        >View only</button>
                        <button
                          type="button" aria-pressed={editOn} disabled={busy || editLocked}
                          onClick={() => onChange([action.editKey], true)}
                          className={cn(segClass(editOn), 'whitespace-nowrap')}
                        >Edit</button>
                      </div>
                      {editLocked && (
                        <span className="text-[11.5px] text-muted-foreground">
                          Edit from {editFromRole.join(', ')} — change their roles to remove
                        </span>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
