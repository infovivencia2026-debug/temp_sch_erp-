import {
  Award, BookOpen, Banknote, Bus, Building2, CalendarDays, CheckCircle2, GraduationCap,
  Target, TrendingUp, UserPlus, Users, Wallet,
} from 'lucide-react'
import {
  INSTITUTE_STATS as S, academicPerformance, admissionsTrend, alerts, announcements,
  attendanceTrend, calendarEvents, feeCollection, pendingApprovals, recentAdmissions,
  revenueTrend, studentDistribution, tasks, upcomingEvents,
} from '@/data/dashboard'
import { inrCompact, num } from '@/lib/utils'
import type { DashboardConfig } from './types'

/**
 * Education's dashboard as configuration.
 *
 * It used to be a bespoke page. Now that ten layouts render every industry's
 * dashboard, education supplies the same shape as the other four instead of
 * being the one vertical that renders differently.
 */
export const EDUCATION_DASHBOARD: DashboardConfig = {
  greeting: `Academic operations · ${S.campuses} campuses, ${num(S.students)} students`,
  primaryAction: { label: 'New admission', to: '/admissions' },
  kpis: [
    { label: 'Total students', value: num(S.students), delta: '+4.2%', up: true, icon: GraduationCap, to: '/students' },
    { label: 'Total faculty', value: num(S.faculty), delta: '+2', up: true, icon: Users, to: '/hr' },
    { label: 'New admissions', value: num(S.newAdmissions), delta: '+11.8%', up: true, icon: UserPlus, to: '/admissions' },
    { label: 'Attendance', value: `${S.attendance}%`, delta: '-0.6%', up: false, icon: CheckCircle2, to: '/attendance' },
    { label: 'Fee collected', value: inrCompact(S.collected), delta: '+8.4%', up: true, icon: Wallet, to: '/finance' },
    { label: 'Outstanding fees', value: inrCompact(S.annualBilling - S.collected), delta: '-3.1%', up: true, icon: Banknote, to: '/finance' },
    { label: 'Courses running', value: num(S.courses), delta: '+6', up: true, icon: BookOpen, to: '/academics' },
    { label: 'Placement rate', value: `${S.placementRate}%`, delta: '+2.9%', up: true, icon: Target, to: '/placements' },
  ],
  secondary: [
    { label: 'Campuses', value: num(S.campuses), icon: Building2 },
    { label: 'Revenue (YTD)', value: inrCompact(S.revenue), icon: TrendingUp },
    { label: 'Expenses (YTD)', value: inrCompact(S.expenses), icon: Wallet },
    { label: 'Student retention', value: `${S.retention}%`, icon: Users },
    { label: 'Upcoming exams', value: '9', icon: CalendarDays },
    { label: 'Fleet on route', value: `${S.vehicles - 2}/${S.vehicles}`, icon: Bus },
  ],
  trend: {
    title: 'Attendance trend',
    subtitle: 'Monthly average — students vs faculty',
    data: attendanceTrend,
    keys: [{ key: 'students', label: 'Students' }, { key: 'faculty', label: 'Faculty' }],
  },
  mix: { title: 'Student distribution', subtitle: 'By faculty stream', data: studentDistribution },
  funnel: {
    title: 'Admissions funnel',
    subtitle: 'Leads → applications → enrolments',
    data: admissionsTrend.slice(-8),
    keys: [
      { key: 'leads', label: 'Leads' },
      { key: 'applications', label: 'Applications' },
      { key: 'enrolled', label: 'Enrolled' },
    ],
  },
  money: {
    title: 'Revenue vs expenses',
    subtitle: '₹ crore, monthly',
    data: revenueTrend,
    keys: [{ key: 'revenue', label: 'Revenue' }, { key: 'expenses', label: 'Expenses' }],
  },
  progress: {
    title: 'Fee collection',
    subtitle: '₹ lakh — billed vs collected',
    unit: 'L',
    rows: feeCollection.map((f) => ({ name: f.name, done: f.collected, total: f.billed })),
  },
  approvals: pendingApprovals,
  alerts,
  activityVerbs: [
    'approved a fee waiver for', 'published Semester 5 results for', 'uploaded course material to',
    'marked attendance for', 'issued a bonafide certificate to', 'created an invoice for',
    'converted an admission lead —', 'scheduled an interview with', 'resolved a helpdesk ticket for',
    'assigned a counsellor to', 'recorded a payment from', 'updated the timetable for',
  ],
  recent: {
    title: 'Recent admissions',
    action: 'Open CRM',
    to: '/admissions',
    rows: recentAdmissions.map((a) => ({ id: a.id, name: a.name, sub: a.program, stage: a.stage })),
  },
  tasks,
  announcements,
  events: upcomingEvents,
  calendar: calendarEvents,
  ranking: {
    title: 'Academic performance',
    subtitle: 'Average score by department',
    rows: academicPerformance,
  },
}

export const EDUCATION_DASHBOARD_ICON = Award
