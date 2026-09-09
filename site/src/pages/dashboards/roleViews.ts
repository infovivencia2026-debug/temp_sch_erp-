import {
  BookOpen, CalendarCheck, ClipboardList, Wallet, Users, Bus, Library, GraduationCap,
  Receipt, Target, HeartHandshake, TrendingUp, AlertTriangle, Boxes,
} from 'lucide-react'
import { homePathFor } from '@/industries'
import type { DashboardConfig, IndustryDef, KpiDef, Role } from '@/industries/types'

/* ===========================================================================
   ONE DASHBOARD PER PERSON

   A librarian and a finance officer were being shown the same page. What each
   role actually opens the morning on is different, so the config is rewritten
   per role before any layout sees it — which means all twenty-one layouts and
   all five verticals get role-specific dashboards without a single one of them
   knowing that roles exist.

   Two mechanisms, in order:

   1. Personas. The individual-facing roles — student, parent, faculty and the
      single-desk specialists — do not want a scaled-down executive dashboard,
      they want their own numbers. Those are written out.

   2. Re-ranking. Every other role keeps the full config but has the parts it
      can actually reach lifted to the front, and its greeting, primary action
      and alerts rewritten to its scope.

   Re-ranking rather than filtering is deliberate: the layouts index the config
   positionally — cfg.kpis[0], cfg.kpis.slice(2, 5), cfg.secondary[0] — so a
   shorter array would leave holes in ten of them. Reordering changes what
   leads without changing what exists.
   =========================================================================== */

type Persona = {
  greeting: (i: IndustryDef) => string
  action?: { label: string; to: string }
  kpis: KpiDef[]
  alerts?: DashboardConfig['alerts']
  tasks?: DashboardConfig['tasks']
}

const k = (label: string, value: string, delta: string, up: boolean, icon: any, to: string): KpiDef =>
  ({ label, value, delta, up, icon, to })

/** The module a link belongs to: '/finance/invoices' → 'finance'. */
const modOf = (to: string) => to.split('/').filter(Boolean)[0] ?? ''

const PERSONAS: Record<string, Persona> = {
  student: {
    greeting: () => 'Today’s classes, assignments and fees',
    action: { label: 'Open today’s classes', to: '/student-portal' },
    kpis: [
      k('My attendance', '91.4%', '+1.2%', true, CalendarCheck, '/student-portal'),
      k('Current CGPA', '8.42', '+0.18', true, GraduationCap, '/student-portal'),
      k('Assignments due', '3', '2 this week', false, ClipboardList, '/lms'),
      k('Fee balance', '₹18,400', 'Due 20 Aug', false, Wallet, '/student-portal'),
      k('Classes today', '6', '2 labs', true, BookOpen, '/student-portal'),
      k('Library books', '2', '1 due Friday', false, Library, '/library'),
      k('Placement drives', '4', 'Eligible for 3', true, Target, '/placements'),
    ],
    alerts: [
      { tone: 'amber', title: 'Data Structures assignment due in 2 days', detail: 'Submit through the LMS before Friday 5pm.' },
      { tone: 'red', title: 'Semester fee instalment due 20 August', detail: '₹18,400 outstanding. Late fee applies after the due date.' },
      { tone: 'blue', title: 'Placement drive — Infosys, 18 August', detail: 'You meet the eligibility criteria. Registration closes Thursday.' },
    ],
    tasks: [
      { title: 'Submit Data Structures assignment', due: 'Friday', done: false },
      { title: 'Register for the Infosys drive', due: 'Thursday', done: false },
      { title: 'Return Operating Systems (library)', due: 'Friday', done: false },
      { title: 'Complete course feedback', due: 'Next week', done: true },
    ],
  },

  parent: {
    greeting: () => 'Attendance, fees and circulars for your child',
    action: { label: 'Pay fees', to: '/parent-portal' },
    kpis: [
      k('Attendance', '94.2%', '+0.8%', true, CalendarCheck, '/parent-portal'),
      k('Fee due', '₹24,000', 'Due 20 Aug', false, Wallet, '/parent-portal'),
      k('Last term result', '86%', '+4%', true, GraduationCap, '/parent-portal'),
      k('Homework pending', '2', 'Due this week', false, ClipboardList, '/parent-portal'),
      k('Bus status', 'On time', 'Route 12', true, Bus, '/transport'),
      k('Circulars unread', '3', 'This week', false, HeartHandshake, '/communication'),
      k('PTM slot', '16 Aug', 'Booking open', true, Users, '/parent-portal'),
    ],
    alerts: [
      { tone: 'red', title: 'Term 2 fee instalment due 20 August', detail: '₹24,000 outstanding for Aarav Sharma.' },
      { tone: 'amber', title: 'Parent-teacher meeting on 16 August', detail: 'Slots are open with the class teacher.' },
      { tone: 'blue', title: 'Field trip consent pending', detail: 'Science museum visit on 22 August needs your acknowledgement.' },
    ],
    tasks: [
      { title: 'Pay the term 2 instalment', due: '20 Aug', done: false },
      { title: 'Give field-trip consent', due: '18 Aug', done: false },
      { title: 'Book a PTM slot', due: '16 Aug', done: false },
    ],
  },

  faculty: {
    greeting: () => 'Attendance, marks and assignments',
    action: { label: 'Mark attendance', to: '/attendance' },
    kpis: [
      k('Classes today', '5', '1 lab', true, BookOpen, '/timetable'),
      k('Attendance pending', '2', 'Periods 4 and 6', false, CalendarCheck, '/attendance'),
      k('Marks to enter', '68', 'Internal 2', false, ClipboardList, '/examinations'),
      k('Assignments to grade', '34', '12 overdue', false, ClipboardList, '/lms'),
      k('My students', '284', 'Across 6 sections', true, Users, '/students'),
      k('Syllabus covered', '72%', '+6%', true, TrendingUp, '/academics'),
      k('Students at risk', '9', 'Below 75% attendance', false, AlertTriangle, '/students'),
    ],
    alerts: [
      { tone: 'red', title: 'Internal 2 marks close on Friday', detail: '68 entries pending across Data Structures and DBMS.' },
      { tone: 'amber', title: '9 students below the attendance threshold', detail: 'They become ineligible for the end-semester exam at 75%.' },
      { tone: 'blue', title: 'You are invigilating on 19 August', detail: 'Forenoon session, Hall B-204.' },
    ],
    tasks: [
      { title: 'Submit Internal 2 marks', due: 'Friday', done: false },
      { title: 'Mark period 4 attendance', due: 'Today', done: false },
      { title: 'Upload lecture notes — Unit 4', due: 'This week', done: false },
    ],
  },

  librarian: {
    greeting: () => 'Circulation, overdues and reservations',
    action: { label: 'Issue a book', to: '/library' },
    kpis: [
      k('Issued today', '148', '+12', true, Library, '/library'),
      k('Overdue', '86', '₹4,300 in fines', false, AlertTriangle, '/library'),
      k('Returns due today', '52', 'Across 4 blocks', false, CalendarCheck, '/library'),
      k('Reservations', '24', '6 ready for pickup', true, ClipboardList, '/library'),
      k('Active members', '2,840', '+64', true, Users, '/library'),
      k('Titles in catalogue', '18,420', '+120 this month', true, BookOpen, '/library'),
      k('Fines collected', '₹18,600', 'This month', true, Receipt, '/library'),
    ],
    alerts: [
      { tone: 'amber', title: '86 books overdue by more than a week', detail: 'Reminders have gone out twice.' },
      { tone: 'blue', title: '6 reserved titles ready for pickup', detail: 'Holds expire after three days.' },
    ],
  },

  'transport-manager': {
    greeting: () => 'Routes running now, fitness and fees',
    action: { label: 'Log a trip', to: '/transport' },
    kpis: [
      k('Routes running', '26 / 28', '2 on standby', true, Bus, '/transport'),
      k('On-time arrivals', '94.1%', '+2.4%', true, CalendarCheck, '/transport'),
      k('Students on board', '1,842', '+38', true, Users, '/transport'),
      k('Vehicles in workshop', '3', '1 overdue', false, AlertTriangle, '/transport'),
      k('Fitness due (30 days)', '4', 'Renew this month', false, ClipboardList, '/transport'),
      k('Fuel spend', '₹6.84L', '+3.1%', false, Receipt, '/transport'),
      k('Transport fees due', '₹12.4L', '128 students', false, Wallet, '/finance'),
    ],
    alerts: [
      { tone: 'red', title: 'KA-01-HF-8842 fitness certificate expires in 9 days', detail: 'The vehicle cannot run beyond the expiry date.' },
      { tone: 'amber', title: 'Route 12 has run late on 4 of the last 5 days', detail: 'Average delay 14 minutes at the second stop.' },
    ],
  },

  accountant: {
    greeting: () => 'Collections, outstanding and payables',
    action: { label: 'Record a payment', to: '/finance' },
    kpis: [
      k('Collected today', '₹8.42L', '+12.4%', true, Wallet, '/finance'),
      k('Outstanding', '₹1.47Cr', '284 students', false, AlertTriangle, '/finance'),
      k('Receipts issued', '164', 'Today', true, Receipt, '/finance'),
      k('Payables due (7 days)', '₹18.4L', '22 invoices', false, Boxes, '/procurement'),
      k('Gateway unmatched', '6', 'Needs reconciliation', false, ClipboardList, '/finance'),
      k('Refunds pending', '11', '₹2.840L', false, Receipt, '/finance'),
      k('Budget used', '68%', 'Of annual plan', true, TrendingUp, '/finance'),
    ],
    alerts: [
      { tone: 'red', title: '284 students past the fee due date', detail: '₹1.47Cr outstanding, ₹62L of it beyond 90 days.' },
      { tone: 'amber', title: '6 gateway settlements unmatched', detail: 'Three days of transactions await reconciliation.' },
      { tone: 'blue', title: '22 vendor invoices due within a week', detail: 'Approve before Friday to keep terms.' },
    ],
  },

  'hr-manager': {
    greeting: () => 'Attendance, hiring and payroll',
    action: { label: 'Add an employee', to: '/hr' },
    kpis: [
      k('Present today', '96.5%', '+0.6%', true, Users, '/attendance'),
      k('On leave', '28', '6 unplanned', false, CalendarCheck, '/hr'),
      k('Open positions', '14', '5 at offer stage', true, Target, '/recruitment'),
      k('Payroll run', '3 days', 'Cut-off 25th', false, Wallet, '/payroll'),
      k('Documents expiring', '12', 'This month', false, ClipboardList, '/documents'),
      k('Appraisals due', '38', 'Cycle closes 31 Aug', false, TrendingUp, '/hr'),
      k('Attrition (12m)', '7.4%', '-1.1%', true, Users, '/hr'),
    ],
    alerts: [
      { tone: 'amber', title: '12 employee documents expire this month', detail: 'Contracts and verification records need renewal.' },
      { tone: 'blue', title: 'Payroll cut-off in 3 days', detail: 'Attendance corrections must be in before the 25th.' },
    ],
  },

  'admission-counselor': {
    greeting: () => 'Leads, follow-ups and conversion',
    action: { label: 'Add a lead', to: '/admissions' },
    kpis: [
      k('My open leads', '128', '+18 today', true, Target, '/admissions'),
      k('Follow-ups due', '34', '9 overdue', false, CalendarCheck, '/admissions'),
      k('Applications', '842', '+64 this week', true, ClipboardList, '/admissions'),
      k('Offers issued', '286', '68% accepted', true, GraduationCap, '/admissions'),
      k('Enrolments', '194', '+22', true, Users, '/admissions'),
      k('Conversion', '23.1%', '+2.4%', true, TrendingUp, '/admissions'),
      k('Fee collected at admission', '₹2.84Cr', '+14%', true, Wallet, '/finance'),
    ],
    alerts: [
      { tone: 'red', title: '9 follow-ups are overdue', detail: 'Leads go cold after roughly four days without contact.' },
      { tone: 'amber', title: '42 applications missing documents', detail: 'They cannot move to the offer stage until complete.' },
    ],
  },
}

/* -------------------------------------------------------------------------- */

/** Rewrite a dashboard config for one role. */
export function roleDashboard(cfg: DashboardConfig, role: Role | undefined, industry: IndustryDef): DashboardConfig {
  if (!role) return cfg

  const persona = PERSONAS[role.id]
  if (persona) {
    // Personas supply their own leading figures. The originals are kept on the
    // end so the layouts that reach past the seventh slot still find something.
    const kpis = [...persona.kpis, ...cfg.kpis].slice(0, Math.max(cfg.kpis.length, persona.kpis.length))
    // The tail is the original admin config, which links where this persona
    // cannot follow.
    const allowed = new Set(role.modules === '*' ? [] : (role.modules as string[]))
    const home = homePathFor(role.id)
    const safe = role.modules === '*' ? kpis
      : kpis.map((x) => (allowed.has(modOf(x.to)) ? x : { ...x, to: home }))
    return {
      ...cfg,
      recent: { ...cfg.recent, to: home },
      greeting: persona.greeting(industry),
      primaryAction: persona.action ?? cfg.primaryAction,
      kpis: safe,
      alerts: persona.alerts ?? cfg.alerts,
      tasks: persona.tasks ?? cfg.tasks,
    }
  }

  // Everyone else: the whole picture, ordered by what they are responsible for.
  if (role.modules === '*') return cfg

  const allowed = new Set(role.modules as string[])
  const mine = (to: string) => allowed.has(modOf(to))
  const home = homePathFor(role.id)

  /* A figure that links somewhere this role cannot open is a trap: the guard
   * turns them away and they land back where they started with no explanation.
   * The figure is still theirs to see — a dean should know the fee position
   * without being able to work in Finance — so it keeps its number and gives
   * up its link instead. */
  const land = <T extends { to: string }>(row: T): T =>
    (mine(row.to) ? row : { ...row, to: home })

  const rank = <T extends { to?: string }>(rows: T[]) =>
    [...rows].sort((a, b) => Number(mine(b.to ?? '')) - Number(mine(a.to ?? '')))

  return {
    ...cfg,
    primaryAction: land(cfg.primaryAction),
    kpis: rank(cfg.kpis).map(land),
    recent: { ...cfg.recent, to: mine(cfg.recent.to) ? cfg.recent.to : home },
  }
}
