import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  GraduationCap, UserPlus, BookOpen, CalendarClock, CheckSquare, FileSpreadsheet,
  MonitorPlay, NotebookPen, ScrollText, DoorOpen, Wallet, Award, Users, Banknote,
  Library, Bus, Building2, Boxes, ShoppingCart, Package, Sparkles, Link, ExternalLink,
  Copy, Check, ShieldCheck, ArrowRight
} from 'lucide-react'
import { Button, Card, Badge, useToast } from '@/components/ui'
import { useApp } from '@/hooks/useAppState'
import { ROLES } from '@/modules/registry'

const CORE_21_UI_MODULES = [
  { id: 'admissions', name: 'Admissions CRM', icon: UserPlus, group: 'Academic Operations', color: 'indigo', desc: 'Leads, pipeline, entrance tests, interviews, document verification & offer letters.' },
  { id: 'students', name: 'Student Information (SIS)', icon: GraduationCap, group: 'Academic Operations', color: 'sky', desc: 'Student directory, guardians, transcripts, discipline, health & certificates.' },
  { id: 'academics', name: 'Academics & Curriculum', icon: BookOpen, group: 'Academic Operations', color: 'emerald', desc: 'Programs, departments, courses, subjects, lesson plans & learning outcomes.' },
  { id: 'timetable', name: 'Timetable & Substitutions', icon: CalendarClock, group: 'Academic Operations', color: 'amber', desc: 'Class grid, faculty schedules, room occupancy & auto-assigned teacher substitutions.' },
  { id: 'attendance', name: 'Attendance Management', icon: CheckSquare, group: 'Academic Operations', color: 'violet', desc: 'Biometric & RFID sync, subject-wise marking, faculty logs & automated parent SMS.' },
  { id: 'examinations', name: 'Examinations & Gradebook', icon: FileSpreadsheet, group: 'Academic Operations', color: 'rose', desc: 'Exam scheduling, question bank, hall ticket generation, marks entry & CGPA results.' },
  { id: 'lms', name: 'LMS / eLearning Hub', icon: MonitorPlay, group: 'Academic Operations', color: 'indigo', desc: 'Video lessons, quizzes, assignments, live classes & gamification leaderboards.' },
  { id: 'homework', name: 'Homework & Digital Diary', icon: NotebookPen, group: 'Academic Operations', color: 'sky', desc: 'Daily teacher assignments, classwork, remarks & parent acknowledgement.' },
  { id: 'report-cards', name: 'Report Cards Generator', icon: ScrollText, group: 'Academic Operations', color: 'emerald', desc: 'CBSE, ICSE & University grade scales, scholastic/co-scholastic runs & publishing.' },
  { id: 'front-office', name: 'Front Office & Gate Pass', icon: DoorOpen, group: 'Campus Services', color: 'amber', desc: 'Visitor management, student gate pass checkout, postal dispatch & phone logs.' },
  { id: 'finance', name: 'Finance & Fee Management', icon: Wallet, group: 'Finance & Administration', color: 'violet', desc: 'Student billing, fee receipts, payment gateway sync, expenses & tax filings.' },
  { id: 'scholarships', name: 'Scholarships & Aid', icon: Award, group: 'Finance & Administration', color: 'rose', desc: 'Merit aid, income verification, sports quota, approval chains & disbursements.' },
  { id: 'hr', name: 'HR & Faculty Operations', icon: Users, group: 'People Operations', color: 'indigo', desc: 'Employee directory, teaching workload, leave management, recruitment & training.' },
  { id: 'payroll', name: 'Payroll Management', icon: Banknote, group: 'People Operations', color: 'sky', desc: 'Salary structures, PF/ESI/TDS deductions, monthly payroll runs & payslips.' },
  { id: 'library', name: 'Library (LMS)', icon: Library, group: 'Campus Services', color: 'emerald', desc: 'Book cataloging, barcode accessioning, issue/return circulation, fine collection.' },
  { id: 'transport', name: 'Transport & Fleet', icon: Bus, group: 'Campus Services', color: 'amber', desc: 'Route planning, live GPS vehicle tracking, stop rosters & transport fees.' },
  { id: 'hostel', name: 'Hostel & Mess', icon: Building2, group: 'Campus Services', color: 'violet', desc: 'Building, room & bed allocations, gate pass rules, mess menu & maintenance.' },
  { id: 'inventory', name: 'Inventory & Stores', icon: Boxes, group: 'Campus Services', color: 'rose', desc: 'Central store stock management, purchase requisitions, issues & reorder alerts.' },
  { id: 'procurement', name: 'Procurement & Vendors', icon: ShoppingCart, group: 'Campus Services', color: 'indigo', desc: 'RFQs, vendor comparison matrix, purchase orders, goods receipts & bills.' },
  { id: 'assets', name: 'Assets & Facilities', icon: Package, group: 'Campus Services', color: 'sky', desc: 'Asset registry, depreciation, facility bookings, room maintenance & CCTV.' },
  { id: 'ai', name: 'AI Center & Portals Hub', icon: Sparkles, group: 'Intelligence & Portals', color: 'emerald', desc: 'Student, Parent, Faculty & Admin portals powered by predictive AI analytics.' },
]

export function EducationERP() {
  const nav = useNavigate()
  const toast = useToast()
  const app = useApp()
  const [copiedLink, setCopiedLink] = useState(false)
  const [instType, setInstType] = useState<'all' | 'k12' | 'higher'>('all')
  const [searchFilter, setSearchFilter] = useState('')

  const dedicatedDomainUrl = 'http://education.187-127-178-100.sslip.io'
  const relativeLinkUrl = window.location.origin + '/education'

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url)
    setCopiedLink(true)
    toast({ title: 'Separate ERP Link Copied!', desc: url, tone: 'success' })
    setTimeout(() => setCopiedLink(false), 2500)
  }

  const filteredModules = CORE_21_UI_MODULES.filter((m) => {
    const matchesSearch = m.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
                          m.desc.toLowerCase().includes(searchFilter.toLowerCase()) ||
                          m.group.toLowerCase().includes(searchFilter.toLowerCase())
    if (!matchesSearch) return false
    if (instType === 'k12') return ['students', 'academics', 'attendance', 'homework', 'report-cards', 'front-office', 'finance', 'library', 'transport'].includes(m.id)
    if (instType === 'higher') return ['admissions', 'academics', 'examinations', 'lms', 'scholarships', 'hr', 'payroll', 'procurement', 'assets', 'ai'].includes(m.id)
    return true
  })

  return (
    <div className="space-y-8 p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Hero Banner with Glassmorphism */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-900 via-slate-900 to-violet-950 p-8 text-white shadow-2xl hairline border-indigo-500/30">
        <div className="absolute -right-12 -top-12 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl" />
        <div className="absolute -left-12 -bottom-12 h-64 w-64 rounded-full bg-violet-500/10 blur-3xl" />

        <div className="relative z-10 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 backdrop-blur-md">
                <GraduationCap className="h-7 w-7" />
              </div>
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-3 py-0.5 text-xs font-semibold text-emerald-300 border border-emerald-500/30">
                  <ShieldCheck className="h-3.5 w-3.5" /> Standalone Education ERP Instance
                </span>
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl text-white mt-1">
                  Vivencia EduCloud — Education ERP
                </h1>
              </div>
            </div>

            <Badge tone="green">
              21 Core UI Modules Active
            </Badge>
          </div>

          <p className="max-w-3xl text-sm leading-relaxed text-indigo-100/90 sm:text-base">
            Comprehensive, multi-campus Education ERP for Higher Education Institutions, Universities, K-12 Schools, and Autonomous Colleges. Includes all 21 UI modules, deterministic state generation, role-based security, and separate deployment links.
          </p>

          {/* Separate Links Section */}
          <div className="grid gap-3 sm:grid-cols-2 rounded-xl bg-white/5 p-4 backdrop-blur-md border border-white/10">
            <div className="flex items-center justify-between gap-2 rounded-lg bg-black/40 px-3.5 py-2.5 border border-white/10">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-indigo-300 uppercase tracking-wider">Dedicated Domain Link</p>
                <p className="truncate text-xs font-mono text-white/90">{dedicatedDomainUrl}</p>
              </div>
              <Button size="sm" variant="ghost" className="shrink-0 text-indigo-300 hover:text-white" onClick={() => copyLink(dedicatedDomainUrl)}>
                {copiedLink ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-lg bg-black/40 px-3.5 py-2.5 border border-white/10">
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-indigo-300 uppercase tracking-wider">Standalone Portal Route</p>
                <p className="truncate text-xs font-mono text-white/90">{relativeLinkUrl}</p>
              </div>
              <Button size="sm" variant="ghost" className="shrink-0 text-indigo-300 hover:text-white" onClick={() => copyLink(relativeLinkUrl)}>
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Control Bar & Filter */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={instType === 'all' ? 'primary' : 'outline'}
            onClick={() => setInstType('all')}
          >
            All 21 UI Modules ({CORE_21_UI_MODULES.length})
          </Button>
          <Button
            size="sm"
            variant={instType === 'k12' ? 'primary' : 'outline'}
            onClick={() => setInstType('k12')}
          >
            K-12 School Suite
          </Button>
          <Button
            size="sm"
            variant={instType === 'higher' ? 'primary' : 'outline'}
            onClick={() => setInstType('higher')}
          >
            Higher Ed & University
          </Button>
        </div>

        <div className="w-full sm:w-72">
          <input
            type="text"
            placeholder="Search 21 UI modules..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="w-full rounded-lg hairline bg-background px-3.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      {/* 21 UI Modules Bento Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredModules.map((m, idx) => (
          <Card
            key={m.id}
            glow={m.color as any}
            interactive
            className="group relative flex flex-col justify-between p-5 transition-all duration-300 hover:-translate-y-1 cursor-pointer"
            onClick={() => nav(`/${m.id}`)}
          >
            <div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-accent/60 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <m.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wider muted">{m.group}</span>
                    <h3 className="text-base font-semibold leading-tight text-foreground group-hover:text-primary">
                      {m.name}
                    </h3>
                  </div>
                </div>
                <Badge tone="slate">
                  UI #{idx + 1}
                </Badge>
              </div>

              <p className="mt-3 text-xs leading-relaxed muted">
                {m.desc}
              </p>
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3 text-xs font-medium text-primary">
              <span className="flex items-center gap-1 group-hover:underline">
                Open Module <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
              </span>
              <span className="text-[11px] muted">Click to launch</span>
            </div>
          </Card>
        ))}
      </div>

      {/* Role Switcher & System Status */}
      <div className="grid gap-6 lg:grid-cols-3 pt-4">
        <Card glow="indigo" className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-base font-semibold">Active Role Context & Security</h3>
              <p className="text-xs muted">Switching role instantly filters sidebar modules, data scopes, and action permissions.</p>
            </div>
            <Badge tone="violet">13 Roles Pre-configured</Badge>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {ROLES.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  app.setRole(r.id)
                  toast({ title: `Role switched to ${r.label}`, desc: r.scope, tone: 'info' })
                  nav(r.modules === '*' ? '/dashboard' : `/${(r.modules as string[])[0]}`)
                }}
                className={`flex flex-col items-start rounded-lg hairline p-3 text-left transition-all ${
                  app.role === r.id ? 'bg-primary/10 border-primary font-semibold' : 'hover:bg-accent/60'
                }`}
              >
                <span className="text-xs font-semibold text-foreground flex items-center justify-between w-full">
                  {r.label}
                  {app.role === r.id && <Check className="h-3.5 w-3.5 text-primary" />}
                </span>
                <span className="text-[10px] muted truncate max-w-full mt-1">{r.scope}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card glow="emerald" className="p-5">
          <h3 className="text-base font-semibold mb-2">Separate ERP Technical Stack</h3>
          <ul className="space-y-2 text-xs muted">
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              React 18 + TypeScript + Vite architecture
            </li>
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Tailwind CSS + Glassmorphism Bento UI
            </li>
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Deterministic PRNG browser state engine
            </li>
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Standalone Nginx deployment config ready
            </li>
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Separate link & domain hosting supported
            </li>
          </ul>

          <div className="mt-6 pt-4 border-t border-border">
            <Button
              className="w-full"
              variant="primary"
              onClick={() => copyLink(dedicatedDomainUrl)}
            >
              <Link className="h-4 w-4 mr-2" /> Share Separate ERP Link
            </Button>
          </div>
        </Card>
      </div>
    </div>
  )
}
