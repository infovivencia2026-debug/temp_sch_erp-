import { dateOffset, fmtDate, rng, int, pick } from '@/lib/utils'
import { CAMPUSES, DEPARTMENTS, FIRST, LAST, PROGRAMS } from './vocab'

export const INSTITUTE_STATS = {
  students: 2840, faculty: 186, staff: 74, campuses: 6, programs: 42, courses: 318,
  classrooms: 96, vehicles: 23, departments: 18, events: 14,
  leads: 326, pendingApplications: 114, newAdmissions: 412,
  annualBilling: 48_00_00_000, collected: 39_84_00_000,
  attendance: 92.4, placementRate: 82.1, retention: 94.6,
  revenue: 52_60_00_000, expenses: 38_20_00_000,
}

const MONTHS = ['Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']

export const attendanceTrend = MONTHS.map((m, i) => {
  const r = rng(101 + i)
  return { name: m, students: +(89 + r() * 5).toFixed(1), faculty: +(93 + r() * 5).toFixed(1) }
})

export const admissionsTrend = MONTHS.map((m, i) => {
  const r = rng(202 + i)
  const leads = int(r, 180, 340)
  return { name: m, leads, applications: Math.round(leads * (0.45 + r() * 0.15)), enrolled: Math.round(leads * (0.18 + r() * 0.08)) }
})

export const revenueTrend = MONTHS.map((m, i) => {
  const r = rng(303 + i)
  const revenue = int(r, 320, 560) / 100
  return { name: m, revenue: +revenue.toFixed(2), expenses: +(revenue * (0.62 + r() * 0.16)).toFixed(2) }
})

export const studentDistribution = [
  { name: 'Engineering', value: 1180 },
  { name: 'Management', value: 620 },
  { name: 'Science', value: 430 },
  { name: 'Commerce', value: 310 },
  { name: 'Law', value: 160 },
  { name: 'Pharmacy & Nursing', value: 140 },
]

export const campusComparison = CAMPUSES.map((c, i) => {
  const r = rng(404 + i)
  return {
    name: c.split('—')[0].trim(),
    students: int(r, 280, 720),
    attendance: +(89 + r() * 6).toFixed(1),
    collection: +(58 + r() * 40).toFixed(1),
    placement: +(70 + r() * 22).toFixed(1),
  }
})

export const academicPerformance = DEPARTMENTS.slice(0, 6).map((d, i) => {
  const r = rng(505 + i)
  return { name: d.split(' ')[0], value: +(62 + r() * 32).toFixed(1) }
})

export const feeCollection = [
  { name: 'Tuition', billed: 3120, collected: 2680 },
  { name: 'Hostel', billed: 820, collected: 690 },
  { name: 'Transport', billed: 410, collected: 358 },
  { name: 'Exam', billed: 260, collected: 246 },
  { name: 'Library', billed: 190, collected: 170 },
]

const ACTIVITY_VERBS = [
  'approved a fee waiver for', 'published Semester 5 results for', 'uploaded course material to',
  'marked attendance for', 'issued a bonafide certificate to', 'created an invoice for',
  'converted an admission lead —', 'scheduled an interview with', 'resolved a helpdesk ticket for',
  'assigned a counsellor to', 'recorded a payment from', 'updated the timetable for',
]

export const recentActivity = Array.from({ length: 14 }, (_, i) => {
  const r = rng(606 + i)
  return {
    id: `act-${i}`,
    actor: `${pick(r, FIRST)} ${pick(r, LAST)}`,
    verb: pick(r, ACTIVITY_VERBS),
    target: pick(r, [...PROGRAMS.slice(0, 12), `${pick(r, FIRST)} ${pick(r, LAST)}`, pick(r, DEPARTMENTS)]),
    time: `${int(r, 2, 58)}m ago`,
  }
})

export const recentAdmissions = Array.from({ length: 8 }, (_, i) => {
  const r = rng(707 + i)
  return {
    id: `ADM-2026${String(1400 + i)}`,
    name: `${pick(r, FIRST)} ${pick(r, LAST)}`,
    program: pick(r, PROGRAMS),
    stage: pick(r, ['Offer Sent', 'Enrolled', 'Interviewed', 'Documents Pending']),
    date: fmtDate(dateOffset(-int(r, 0, 12))),
  }
})

export const pendingApprovals = [
  { id: 'PR-3391', type: 'Purchase request', detail: '18 lab oscilloscopes — ECE', value: '₹6,84,000', age: '2 days' },
  { id: 'LV-1187', type: 'Leave request', detail: 'Dr. Meera Nair — 6 days earned leave', value: '6 days', age: '1 day' },
  { id: 'FW-0442', type: 'Fee waiver', detail: 'Arjun Menon — hardship case', value: '₹48,000', age: '4 hours' },
  { id: 'MC-0219', type: 'Marks correction', detail: 'CS304 — 3 students', value: '3 records', age: '6 hours' },
  { id: 'TR-0087', type: 'Campus transfer', detail: 'Ishita Rao — Pune → Bengaluru', value: '1 student', age: '3 days' },
]

export const upcomingEvents = Array.from({ length: 7 }, (_, i) => {
  const names = ['Semester 5 End Exams', 'Industry Talk — Cloud Native', 'Alumni Homecoming 2026',
    'NAAC Peer Team Visit', 'Inter-college Sports Meet', 'Placement Drive — Zoho', 'Parent–Teacher Meeting']
  const r = rng(808 + i)
  return { name: names[i], date: fmtDate(dateOffset(int(r, 2, 45))), venue: pick(r, ['Main Auditorium', 'Block A', 'Sports Complex', 'Seminar Hall 2']) }
})

export const announcements = [
  { title: 'Semester fee — last date extended to 22 Aug 2026', by: 'Accounts Office', time: '2h ago', pinned: true },
  { title: 'Revised academic calendar for Odd Semester 2026-27 published', by: 'Registrar', time: 'Yesterday', pinned: true },
  { title: 'Campus shuttle timings revised from Monday', by: 'Transport Cell', time: '2 days ago', pinned: false },
  { title: 'Library open till 10 PM during exam weeks', by: 'Central Library', time: '3 days ago', pinned: false },
]

export const tasks = [
  { title: 'Approve 5 pending fee waivers', due: 'Today', done: false },
  { title: 'Review NAAC criterion 3 evidence', due: 'Tomorrow', done: false },
  { title: 'Finalise Sem 5 exam invigilator roster', due: '12 Aug', done: false },
  { title: 'Sign off July payroll run', due: 'Completed', done: true },
  { title: 'Publish placement drive schedule', due: '14 Aug', done: false },
]

export const alerts = [
  { tone: 'red' as const, title: '38 invoices overdue beyond 30 days', detail: '₹41.2 L outstanding across 3 campuses' },
  { tone: 'amber' as const, title: '146 students below 75% attendance', detail: 'Shortage notices not yet sent' },
  { tone: 'amber' as const, title: '4 vehicles due for fitness renewal', detail: 'Expiring within 21 days' },
  { tone: 'blue' as const, title: 'Biometric device at North Campus offline', detail: 'Last sync 14 hours ago' },
]

export const calendarEvents: Record<number, string[]> = {
  8: ['Sem 5 exams begin'], 11: ['Guest lecture'], 14: ['Placement drive — Zoho'],
  18: ['Fee deadline'], 22: ['NAAC visit'], 27: ['Sports meet'], 30: ['PTM'],
}
