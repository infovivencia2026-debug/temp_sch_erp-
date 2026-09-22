import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
} from 'recharts'
import {
  GraduationCap, ClipboardCheck, UserCheck, BookOpen, Phone, Mail, Wallet,
  ClipboardList, PencilLine, ArrowRightLeft,
} from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge,
  Table, Td, Button, Field, Select, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatPaise, WEEKDAYS } from '@/lib/utils'
import { useCan } from '@/lib/session'

/* Class 360 — one section, at a glance.
 *
 * The staff record answers "what does this teacher do"; this answers the same
 * question about a class. Who teaches it, who is on the roll and how to ring
 * their families, how the register and the marks are trending, the week's
 * timetable, and — for whoever answers for the money — where the fees stand.
 *
 * It is read far more often than anything is done from it, so it is view-first:
 * tiles, then charts, styled on the principal dashboard so it matches the app
 * and reads in either theme on the schools' old tablets. The things you might
 * DO from here — mark a register, enter marks, edit a child — are the existing
 * screens, reached by a gated button that only appears for somebody who holds
 * the permission the server would demand anyway.
 */

interface SectionRow {
  section_id: string
  class: string
  section: string
  students_count: number
  class_teacher?: string
}

interface Contact {
  name: string
  phone: string
  relation: string
}

interface Overview {
  section: { id: string; class: string; section: string; students_count: number }
  class_teacher?: string
  class_teacher_phone?: string
  class_teacher_email?: string
  subject_teachers: { subject: string; teacher: string; phone?: string; email?: string }[]
  students: {
    student_id: string
    name: string
    admission_no: string
    roll?: number | string
    contacts?: Contact[]
  }[]
  attendance: {
    present_pct_today?: number
    marked_today: boolean
    trend: { date: string; present_pct: number }[]
  }
  marks: {
    has_marks: boolean
    by_subject: { subject: string; avg_pct: number }[]
  }
  timetable: {
    weekday: number | string
    period: string | number
    sequence?: number
    starts?: string
    ends?: string
    subject: string
    teacher?: string
  }[]
  fees: { visible: boolean; collected_paise?: number; outstanding_paise?: number }
}

/* The dashboard's axes and tooltip, so both charts read the same way and
   neither hard-codes a colour that breaks in dark mode. */
const AXIS = { fontSize: 11 } as const
const TIP = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 12,
} as const

/* "father" -> "Father". Whatever the guardian was stored as still reads
   sensibly rather than as a raw lowercase word. */
function relationLabel(relation: string, name: string): string {
  const r = relation?.trim()
  if (!r) return name || 'Guardian'
  return r.charAt(0).toUpperCase() + r.slice(1)
}

/* The weekday as a school reads it. A server sends it as a name, or as an
   index — 0–6 (Sun-first) or 1–7 (Mon-first) — and this keeps every one of
   those readable rather than printing a bare number. */
function weekdayLabel(w: number | string): string {
  if (typeof w === 'string') {
    const n = Number(w)
    if (!Number.isFinite(n)) return w
    w = n
  }
  if (w >= 1 && w <= 7) return WEEKDAYS[w - 1] // 1 = Mon
  if (w === 0) return 'Sun'
  return String(w)
}

/* A guardian's number, as a button that dials it. Only drawn for a contact
   that has a number, so there is never a dead control. Modelled on the call
   buttons in the absentee follow-up. */
function CallButton({ label, name, phone }: { label: string; name: string; phone: string }) {
  return (
    <a
      href={`tel:${phone}`}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[13px] font-medium hover:bg-accent"
    >
      <Phone className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="block truncate">
          {label}
          {name && name !== label ? (
            <span className="font-normal text-muted-foreground"> · {name}</span>
          ) : null}
        </span>
        <span className="block font-mono text-[12px] text-muted-foreground">{phone}</span>
      </span>
    </a>
  )
}

/* A teacher's phone and email, as small tap-to-contact links under the name.
   Each link is only drawn when the detail is on file, so the office never meets
   a dead control; nothing renders at all when both are absent. */
function TeacherContact({ phone, email }: { phone?: string; email?: string }) {
  if (!phone && !email) return null
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px]">
      {phone ? (
        <a href={`tel:${phone}`} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <Phone className="h-3 w-3 shrink-0" aria-hidden />
          <span className="font-mono">{phone}</span>
        </a>
      ) : null}
      {email ? (
        <a href={`mailto:${email}`} className="inline-flex min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground">
          <Mail className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{email}</span>
        </a>
      ) : null}
    </div>
  )
}

/* The period's own label, cleaned. Names are stored as "Period1", "Period 2",
   etc., so a bare "Period {name}" read "Period Period1". This collapses a
   "Period N" name to "PN" and otherwise keeps whatever the school named it. */
function periodLabel(name: string | number): string {
  const s = String(name).trim()
  const m = s.match(/^period\s*0*(\d+)$/i)
  if (m) return `P${m[1]}`
  return s
}

/* The period's time window, "9:00–9:40", drawn only when both ends are known. */
function periodTime(starts?: string, ends?: string): string {
  if (starts && ends) return `${starts}–${ends}`
  return starts || ends || ''
}

export default function ClassOverview() {
  const can = useCan()
  const navigate = useNavigate()
  const [sectionId, setSectionId] = useState('')

  /* Class 360 has its own permission now, so the screen guards on it directly
     rather than inferring access from whatever the section list came back with.
     Without it there is nothing to fetch — the server would refuse every call —
     so the request is disabled and the no-access message stands in its place. */
  const mayOpen = can('academics.class360.view')

  /* Only the sections the caller may open — the server scopes this, so a class
     teacher sees their own and an admin sees the school, from one screen. */
  const sections = useQuery({
    queryKey: ['class-sections'],
    enabled: mayOpen,
    queryFn: () => api.get<List<SectionRow>>('/api/v1/class/sections'),
  })

  /* One section? Pick it, so the single-class teacher never meets a chooser
     with one entry in it. */
  const items = sections.data?.items ?? []
  useEffect(() => {
    if (!sectionId && items.length === 1) setSectionId(items[0].section_id)
  }, [items, sectionId])

  const overview = useQuery({
    queryKey: ['class-overview', sectionId],
    enabled: !!sectionId,
    queryFn: () => api.get<Overview>(`/api/v1/class/${sectionId}/overview`),
  })

  return (
    <>
      <PageHead
        eyebrow="Class Information"
        title="Class 360"
        actions={
          items.length > 1 ? (
            <div className="w-60">
              <Field label="Section">
                <Select
                  value={sectionId}
                  onChange={setSectionId}
                  placeholder="Choose a section"
                  options={items.map((s) => ({
                    value: s.section_id,
                    label: `${s.class}-${s.section}`,
                  }))}
                />
              </Field>
            </div>
          ) : undefined
        }
      />
      <PageBody>
        {!mayOpen ? (
          <EmptyState
            title="You do not have access to Class 360."
            body="This overview is granted separately. Ask an administrator to enable Class 360 for your role."
          />
        ) : sections.isLoading ? (
          <Loading />
        ) : sections.error ? (
          <ErrorState error={sections.error} />
        ) : items.length === 0 ? (
          <EmptyState
            title="You do not have a class to look at yet."
            body="Class 360 opens the sections you teach or are class teacher of. When one is assigned to you, it appears here."
          />
        ) : !sectionId ? (
          <EmptyState
            title="Choose a section to begin."
            body="Pick a class above to see its roster, attendance, results and timetable."
          />
        ) : overview.isLoading ? (
          <Loading />
        ) : overview.error ? (
          /* A 404 or 403 on the overview degrades to a message in place rather
             than crashing the screen. */
          <ErrorState error={overview.error} />
        ) : overview.data ? (
          <OverviewBody o={overview.data} can={can} navigate={navigate} />
        ) : null}
      </PageBody>
    </>
  )
}

function OverviewBody({
  o,
  can,
  navigate,
}: {
  o: Overview
  can: (perm: string) => boolean
  navigate: (to: string) => void
}) {
  const { section, attendance, marks, fees } = o

  /* The action buttons the caller is entitled to. Each is hidden entirely
     where the permission is not held — the server enforces the same keys, so a
     hidden button is a courtesy, not the guard. Every one navigates to the
     existing screen through /go/<feature>, which resolves the right workspace
     for whoever is signed in. */
  const actions = [
    can('academics.attendance.write') && (
      <Button key="att" size="sm" variant="secondary" onClick={() => navigate('/go/take_attendance')}>
        <ClipboardCheck className="h-3.5 w-3.5" aria-hidden />
        Mark attendance
      </Button>
    ),
    can('academics.marks.write') && (
      <Button key="marks" size="sm" variant="secondary" onClick={() => navigate('/go/marks_entry')}>
        <ClipboardList className="h-3.5 w-3.5" aria-hidden />
        Enter marks
      </Button>
    ),
    can('students.write') && (
      <Button key="edit" size="sm" variant="secondary" onClick={() => navigate('/go/student_360')}>
        <PencilLine className="h-3.5 w-3.5" aria-hidden />
        Edit student
      </Button>
    ),
    can('students.write') && (
      <Button key="move" size="sm" variant="secondary" onClick={() => navigate('/go/class_promotion')}>
        <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden />
        Move student
      </Button>
    ),
  ].filter(Boolean)

  const presentToday = attendance.marked_today && attendance.present_pct_today != null
    ? `${attendance.present_pct_today}%`
    : '-'

  return (
    <>
      {actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}

      <CellGrid cols={4}>
        <Stat label="Students" value={section.students_count} icon={GraduationCap} />
        <Stat
          label="Present today"
          value={presentToday}
          icon={ClipboardCheck}
          hint={attendance.marked_today ? undefined : 'No register marked today'}
        />
        <Stat label="Class teacher" value={o.class_teacher || '-'} icon={UserCheck} />
        <Stat label="Subjects taught" value={o.subject_teachers.length} icon={BookOpen} />
      </CellGrid>

      {/* Roster + contacts. Tap a guardian to ring them. */}
      <Card>
        <CardHeader title="Roster" description="Everyone on the roll, and how to reach their family." />
        <Table
          head={['Name', 'Admission no', 'Roll', 'Call home']}
          empty={!o.students.length}
          emptyLabel="No students on the roll for this section."
        >
          {o.students.map((s) => {
            const withPhone = (s.contacts ?? []).filter((c) => c.phone)
            return (
              <tr key={s.student_id}>
                <Td className="font-medium">{s.name}</Td>
                <Td className="font-mono text-[13px] text-muted-foreground">{s.admission_no}</Td>
                <Td className="tabular-nums">{s.roll ?? '-'}</Td>
                <Td>
                  {withPhone.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {withPhone.map((c, i) => (
                        <CallButton
                          key={`${c.phone}:${i}`}
                          label={relationLabel(c.relation, c.name)}
                          name={c.name}
                          phone={c.phone}
                        />
                      ))}
                    </div>
                  ) : (
                    <span className="text-[13px] text-muted-foreground">No number on file</span>
                  )}
                </Td>
              </tr>
            )
          })}
        </Table>
      </Card>

      {/* Attendance & results, side by side — the register's trend and the
          average per subject. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Attendance trend" description="Percentage present, over time." />
          <div className="p-4">
            {attendance.trend.length > 0 ? (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={attendance.trend} margin={{ top: 4, right: 8, bottom: 4, left: -22 }}>
                    <defs>
                      <linearGradient id="class-att" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" tick={AXIS} stroke="hsl(var(--muted-foreground))" />
                    <YAxis domain={[0, 100]} tick={AXIS} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip contentStyle={TIP} />
                    <Area type="monotone" dataKey="present_pct" name="Present %"
                      stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#class-att)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="grid h-56 place-items-center text-center text-[13px] text-muted-foreground">
                No attendance recorded for this section yet.
              </p>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Average % by subject" description="Across published marks." />
          <div className="p-4">
            {marks.has_marks && marks.by_subject.length > 0 ? (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={marks.by_subject} margin={{ top: 4, right: 8, bottom: 4, left: -22 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="subject" tick={AXIS} stroke="hsl(var(--muted-foreground))" />
                    <YAxis domain={[0, 100]} tick={AXIS} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip contentStyle={TIP} cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }} />
                    <Bar dataKey="avg_pct" name="Average %" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="grid h-56 place-items-center text-center text-[13px] text-muted-foreground">
                No marks have been published for this class yet.
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* Teachers & timetable — who takes the class, and the week. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Teachers" />
          <div className="space-y-4 p-4">
            <div>
              <p className="eyebrow mb-1.5 text-muted-foreground">Class teacher</p>
              {o.class_teacher ? (
                <div>
                  <div className="flex items-center gap-2">
                    <Badge tone="primary">{o.class_teacher}</Badge>
                  </div>
                  <TeacherContact phone={o.class_teacher_phone} email={o.class_teacher_email} />
                </div>
              ) : (
                <p className="text-[14px] text-muted-foreground">Not assigned</p>
              )}
            </div>
            <div>
              <p className="eyebrow mb-2 text-muted-foreground">Subject teachers</p>
              {o.subject_teachers.length > 0 ? (
                <div className="space-y-3">
                  {o.subject_teachers.map((st) => (
                    <div key={st.subject} className="text-[14px]">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{st.subject}</span>
                        <span className="text-right text-muted-foreground">{st.teacher || '-'}</span>
                      </div>
                      <TeacherContact phone={st.phone} email={st.email} />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[14px] text-muted-foreground">No subject teachers allocated.</p>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Timetable" description="The week's grid, by day and period." />
          <div className="p-4">
            {o.timetable.length > 0 ? (
              <Timetable rows={o.timetable} />
            ) : (
              <p className="grid place-items-center py-8 text-center text-[13px] text-muted-foreground">
                No timetable has been set for this section.
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* Fees — only for whoever answers for the money. The server decides
          `visible`; where it is false the panel does not render at all. */}
      {fees.visible && (
        <Card>
          <CardHeader title="Fees" description="Collected and outstanding for this section." />
          <CellGrid cols={2}>
            <Stat label="Collected" value={formatPaise(fees.collected_paise ?? 0)} icon={Wallet} />
            <Stat
              label="Outstanding"
              value={formatPaise(fees.outstanding_paise ?? 0)}
              icon={Wallet}
            />
          </CellGrid>
        </Card>
      )}
    </>
  )
}

/* The timetable as a real grid: days down the side, periods across the top.
   Period columns carry the school's own label and time window as headers
   ("P1 · 9:00–9:40"), each cell the subject over the teacher. It scrolls
   sideways inside its own box on a phone rather than breaking the page, and
   uses a plain HTML table so it renders on the schools' old tablets. */
function Timetable({ rows }: { rows: Overview['timetable'] }) {
  // The distinct periods (columns), ordered by the server's sequence, then by
  // start time, then by label — so a section with gaps still lines its days up.
  const periodMap = new Map<
    string,
    { key: string; label: string; time: string; sequence: number }
  >()
  for (const r of rows) {
    const key = String(r.period)
    if (!periodMap.has(key)) {
      periodMap.set(key, {
        key,
        label: periodLabel(r.period),
        time: periodTime(r.starts, r.ends),
        sequence: typeof r.sequence === 'number' ? r.sequence : Number.MAX_SAFE_INTEGER,
      })
    }
  }
  const periods = [...periodMap.values()].sort(
    (a, b) => a.sequence - b.sequence || a.time.localeCompare(b.time) || a.label.localeCompare(b.label),
  )

  // The distinct days (rows), in week order.
  const dayKeys = [...new Set(rows.map((r) => String(r.weekday)))].sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
    return a.localeCompare(b)
  })

  // cell[day][period] -> the entry, so each body cell is a direct lookup.
  const cell = new Map<string, Overview['timetable'][number]>()
  for (const r of rows) cell.set(`${r.weekday} ${r.period}`, r)

  return (
    <div className="scroll-x">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card px-2 py-2 text-left text-[12px] font-medium text-muted-foreground">
              Day
            </th>
            {periods.map((p) => (
              <th key={p.key} className="min-w-[7rem] px-2 py-2 text-left align-bottom">
                <span className="block font-semibold">{p.label}</span>
                {p.time ? (
                  <span className="block font-normal text-[11px] text-muted-foreground">{p.time}</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dayKeys.map((dk) => (
            <tr key={dk} className="border-t border-border">
              <th className="sticky left-0 z-10 bg-card px-2 py-2 text-left font-medium text-muted-foreground">
                {weekdayLabel(dk)}
              </th>
              {periods.map((p) => {
                const e = cell.get(`${dk} ${p.key}`)
                return (
                  <td key={p.key} className="px-2 py-2 align-top">
                    {e ? (
                      <>
                        <span className="block font-medium">{e.subject}</span>
                        {e.teacher ? (
                          <span className="block text-[12px] text-muted-foreground">{e.teacher}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">·</span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
