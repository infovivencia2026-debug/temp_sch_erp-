import { GraduationCap } from 'lucide-react'
import { GROUP_ORDER, MODULES, ROLES } from '@/modules/registry'
import {
  CAMPUSES, COMPANIES, COURSES, DEPARTMENTS, INSTITUTIONS, PROGRAMS, ROOMS, SOURCES, VENDORS,
} from '@/data/vocab'
import { EDUCATION_DASHBOARD } from './educationDashboard'
import type { IndustryDef } from './types'

/* ---------------------------------------------------------------------------
   Education wraps the original registry unchanged. Its dashboard stays the
   bespoke page it always was; the other verticals render the config-driven one.
   --------------------------------------------------------------------------- */

export const EDUCATION: IndustryDef = {
  id: 'education',
  label: 'Education',
  tagline: 'Admissions, academics, fees and portals',
  blurb: 'Run admissions to alumni for a university or a school — timetables, attendance, examinations, fees, hostels and parent portals.',
  icon: GraduationCap,
  product: 'Vivencia EduCloud',
  productSub: 'Education ERP Suite',
  user: { name: 'Priya Raghavan', defaultRole: 'institution-admin' },
  modules: MODULES,
  groupOrder: GROUP_ORDER,
  roles: ROLES,
  vocab: {
    program: PROGRAMS, course: COURSES, dept: DEPARTMENTS, campus: CAMPUSES, room: ROOMS,
    company: COMPANIES, vendor: VENDORS, grade: ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D'],
    source: SOURCES, sem: ['Semester 1', 'Semester 3', 'Semester 5', 'Semester 7'],
    batch: ['2022–2026', '2023–2027', '2024–2028'], domain: 'vivencia.edu.in',
  },
  scope: {
    orgLabel: 'Institution', orgs: INSTITUTIONS,
    siteLabel: 'Campus', sites: CAMPUSES,
    periodLabel: 'Academic year', periods: ['2026–27', '2025–26', '2024–25'],
  },
  quickCreate: [
    { label: 'Add student', to: '/students' }, { label: 'Add admission lead', to: '/admissions' },
    { label: 'Create invoice', to: '/finance' }, { label: 'Record payment', to: '/finance' },
    { label: 'Create exam', to: '/examinations' }, { label: 'Mark attendance', to: '/attendance' },
    { label: 'Issue library book', to: '/library' }, { label: 'Post announcement', to: '/communication' },
    { label: 'Raise purchase request', to: '/procurement' }, { label: 'New helpdesk ticket', to: '/helpdesk' },
  ],
  notifications: [
    { title: '38 fee invoices crossed due date', desc: 'Finance · Bengaluru campus', time: '12m ago' },
    { title: 'Semester 5 results ready to publish', desc: 'Examinations · CSE', time: '48m ago' },
    { title: '14 new admission leads assigned to you', desc: 'Admissions CRM', time: '2h ago' },
    { title: 'Bus KA-01-HF-8842 completed morning route', desc: 'Transport', time: '3h ago' },
    { title: 'NAAC evidence pack pending from 4 departments', desc: 'Accreditation', time: 'Yesterday' },
  ],
  messages: [
    { from: 'Meera Nair', text: 'Shared the revised exam timetable for Sem 5.', time: '09:12' },
    { from: 'Rohan Desai', text: 'Can we approve the lab equipment PR today?', time: '08:40' },
    { from: 'Parents Group — Sec B', text: '3 new messages about the field trip.', time: 'Yesterday' },
  ],
  dashboard: EDUCATION_DASHBOARD,
  searchHint: 'Search students, invoices, modules…',
  highlights: ['Admissions CRM to alumni', 'Higher-ed and K-12 in one build', 'Student, parent and faculty portals'],
}
