import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Brain, HeartHandshake, Activity, Info, MessageSquare } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Button, Select, Loading, SkeletonTiles, ErrorState, EmptyState, FormNotice, PrintButton,
} from '@/components/ui'
import { cn } from '@/lib/utils'

/* The NEP Holistic Progress Card.

   One screen serves the teacher recording observations and the family reading
   them, because they are the same card seen from two sides — and building two
   would guarantee they drift. What differs is who may write: the server
   decides the observer role from who is signed in, so a parent's rating is
   filed as the parent's and can never be filed as the school's.

   The stage governs the whole layout. Below Class 6 the framework forbids
   marks, percentages and rank outright, so those blocks are not rendered at
   all rather than rendered empty — an empty "Percentage: —" on a Class 2 card
   still teaches a parent to look for a number that should not exist. */

interface View360 {
  role: 'teacher' | 'self' | 'peer' | 'parent'
  by?: string
  level?: number
  descriptor?: string
  note?: string
}
interface Competency {
  id: string
  code: string
  name: string
  description: string
  views: View360[]
  descriptor: string
  self_teacher_gap: boolean
}
interface Domain {
  domain: string
  label: string
  competencies: Competency[]
}
interface Subject {
  subject: string
  obtained: number
  max: number
  percentage: number
  grade: string
  grade_point?: number
}
interface CardView {
  student_id: string
  student_name: string
  class_name: string
  section_name: string
  reporting: {
    stage: string
    stage_label: string
    numeric_grades: boolean
    scale: string
    note: string
  }
  domains: Domain[]
  scholastic: Subject[]
  percentage?: number
  grade?: string
  cgpa?: number
  attendance_percent?: number
  incomplete: string[]
  ready: boolean
}
interface Child {
  student_id: string
  full_name: string
  class_name?: string
  section_name?: string
}

const DOMAIN_ICON: Record<string, typeof Brain> = {
  cognitive: Brain,
  affective: HeartHandshake,
  psychomotor: Activity,
}

// The framework's four words, and the only vocabulary this screen uses.
const LEVELS = [
  { level: 1, label: 'Beginner' },
  { level: 2, label: 'Progressing' },
  { level: 3, label: 'Proficient' },
  { level: 4, label: 'Advanced' },
]

const TONE: Record<string, 'neutral' | 'warning' | 'success' | 'primary'> = {
  'Not yet observed': 'neutral',
  Beginner: 'warning',
  Progressing: 'primary',
  Proficient: 'success',
  Advanced: 'success',
}

export default function HolisticCard() {
  const qc = useQueryClient()
  const [picked, setPicked] = useState('')

  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ permissions: string[] }>('/api/v1/session'),
  })
  // Only staff may file the school's own assessment. Everyone else sees the
  // card and may add their own view where the framework invites it.
  const isStaff = session.data?.permissions.includes('academics.marks.write') ?? false

  // A family arrives with no student in the URL and gets their own child; a
  // teacher picks from the children they teach.
  const children = useQuery({
    queryKey: ['portal-children'],
    queryFn: () => api.get<List<Child>>('/api/v1/portal/students'),
    enabled: session.isSuccess && !isStaff,
  })
  const roster = useQuery({
    queryKey: ['students', 'hpc'],
    queryFn: () => api.get<{ items: { id: string; full_name: string; class_name?: string }[] }>(
      '/api/v1/students?limit=200',
    ),
    enabled: session.isSuccess && isStaff,
  })

  const options = isStaff
    ? (roster.data?.items ?? []).map((s) => ({
        value: s.id,
        label: `${s.full_name}${s.class_name ? ` · ${s.class_name}` : ''}`,
      }))
    : (children.data?.items ?? []).map((c) => ({
        value: c.student_id,
        label: `${c.full_name}${c.class_name ? ` · ${c.class_name}-${c.section_name ?? ''}` : ''}`,
      }))
  const student = picked || options[0]?.value || ''

  const { data, isLoading, error } = useQuery({
    queryKey: ['hpc-card', student],
    queryFn: () => api.get<CardView>(`/api/v1/hpc/card?student_id=${student}`),
    enabled: !!student,
  })

  const record = useMutation({
    mutationFn: (v: { competency_id: string; level?: number; note?: string }) =>
      api.post('/api/v1/hpc/observations', { student_id: student, ...v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hpc-card', student] }),
  })

  /* Who the card is for has to be settled before there is a card to fetch, so
     the list's wait and the list's failure both belong to this screen.

     `!student` used to be folded into the loading test, which made every
     answer that is not a student look like one still arriving: a family with
     no linked child, a teacher with an empty roster, and a 403 on the roster
     all left `student` as '', the card query disabled, `isLoading` false, and
     "Assembling the card…" turning until the tab was closed. */
  const list = isStaff ? roster : children
  if (session.isLoading || list.isLoading) return <Loading label="Assembling the card…" />
  if (session.error) return <ErrorState error={session.error} />
  if (list.error) return <ErrorState error={list.error} />
  if (!student)
    return (
      <>
        <PageHead title="Holistic progress card" />
        <PageBody>
          <EmptyState
            title={isStaff ? 'No students to show' : 'No child is linked to this account'}
            body={
              isStaff
                ? 'Once students are enrolled and allocated to your classes, their cards appear here.'
                : 'Ask the school office to link your child to this account, and the card will appear here.'
            }
          />
        </PageBody>
      </>
    )
  if (isLoading) return <SkeletonTiles count={6} label="Assembling the card…" />
  if (error) return <ErrorState error={error} />
  const d = data!
  const observed = d.domains.reduce(
    (n, dom) => n + dom.competencies.filter((c) => c.descriptor !== 'Not yet observed').length,
    0,
  )
  const total = d.domains.reduce((n, dom) => n + dom.competencies.length, 0)

  return (
    <>
      <PageHead
        eyebrow="Holistic Progress Card"
        title={d.student_name}
        description={`${d.class_name}-${d.section_name} · ${d.reporting.stage_label}`}
        actions={
          <>
            <PrintButton label="Print card" />
            {options.length > 1 && (
              <Select value={student} onChange={setPicked} options={options} />
            )}
          </>
        }
      />
      <PageBody>
        {/* The stage rule, said out loud. A parent who has only ever seen a
            marks card needs to be told why this one has no percentage. */}
        <Card className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-[14px] text-secondary-foreground">
            <span className="font-medium">{d.reporting.stage_label}.</span> {d.reporting.note}
          </p>
        </Card>

        <CellGrid cols={4}>
          <Stat label="Observed" value={`${observed}/${total}`} hint="Competencies rated" />
          <Stat
            label="Attendance"
            value={d.attendance_percent != null ? `${d.attendance_percent}%` : '—'}
          />
          {d.reporting.numeric_grades ? (
            <>
              <Stat
                label="Overall"
                value={d.percentage != null ? `${d.percentage.toFixed(1)}%` : '—'}
                hint={d.reporting.scale}
              />
              <Stat label={d.cgpa != null ? 'CGPA' : 'Grade'}
                value={d.cgpa != null ? d.cgpa.toFixed(1) : (d.grade ?? '—')} />
            </>
          ) : (
            <>
              <Stat label="Marks" value="Not at this stage" hint="Descriptive reporting only" />
              <Stat label="Rank" value="Not at this stage" hint="No ranking below Class 6" />
            </>
          )}
        </CellGrid>

        {!d.ready && (
          <Card className="border-warning/40 p-4">
            <p className="text-[14px] font-medium">This card is not ready to issue</p>
            <ul className="mt-2 space-y-1">
              {d.incomplete.map((m, i) => (
                <li key={i} className="text-[14px] text-muted-foreground">
                  · {m}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {d.domains.map((dom) => {
          const Icon = DOMAIN_ICON[dom.domain] ?? Brain
          return (
            <Card key={dom.domain}>
              <CardHeader
                title={dom.label}
                description={`${dom.competencies.filter((c) => c.descriptor !== 'Not yet observed').length} of ${dom.competencies.length} observed`}
                action={<Icon className="h-4 w-4 text-muted-foreground" />}
              />
              <ul className="divide-y">
                {dom.competencies.map((c) => (
                  <CompetencyRow
                    key={c.id}
                    c={c}
                    isStaff={isStaff}
                    pending={record.isPending}
                    onRate={(level, note) =>
                      record.mutate({ competency_id: c.id, level, note })
                    }
                  />
                ))}
              </ul>
            </Card>
          )
        })}

        {/* Marks exist only where the stage permits them. */}
        {d.reporting.numeric_grades && d.scholastic.length > 0 && (
          <Card>
            <CardHeader title="Scholastic" description={`Graded on the ${d.reporting.scale}`} />
            <ul className="divide-y">
              {d.scholastic.map((s) => (
                <li key={s.subject} className="flex items-center justify-between gap-4 px-5 py-3">
                  <span className="text-[14px] font-medium">{s.subject}</span>
                  <span className="flex items-center gap-4 text-[14px] tabular-nums">
                    <span className="text-muted-foreground">
                      {s.obtained} / {s.max}
                    </span>
                    <span>{s.percentage.toFixed(1)}%</span>
                    <Badge tone="primary" solid>
                      {s.grade}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <FormNotice error={record.error} />
      </PageBody>
    </>
  )
}

/**
 * One competency, with every point of view beside it.
 *
 * The four views are shown together rather than reconciled. Where the child
 * and the teacher disagree by more than a step the row says so — that gap is
 * the single most useful thing on the card at a parents' evening, and
 * averaging it away is exactly what the framework is trying to prevent.
 */
function CompetencyRow({
  c,
  isStaff,
  pending,
  onRate,
}: {
  c: Competency
  isStaff: boolean
  pending: boolean
  onRate: (level?: number, note?: string) => void
}) {
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  const mine = c.views.find((v) => (isStaff ? v.role === 'teacher' : v.role !== 'teacher'))

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium">{c.name}</p>
          <p className="mt-0.5 text-[14px] text-muted-foreground">{c.description}</p>
          {c.views.length > 0 && (
            <ul className="mt-2 space-y-1">
              {c.views.map((v, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                  <span className="w-14 shrink-0 capitalize text-muted-foreground">{v.role}</span>
                  {v.descriptor && <Badge tone={TONE[v.descriptor]}>{v.descriptor}</Badge>}
                  {v.note && <span className="text-muted-foreground">“{v.note}”</span>}
                </li>
              ))}
            </ul>
          )}
          {c.self_teacher_gap && (
            <p className="mt-2 flex items-center gap-1.5 text-[13px] text-warning">
              <MessageSquare className="h-3.5 w-3.5" />
              Their own view differs from the school's — worth discussing.
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
          <Badge tone={TONE[c.descriptor] ?? 'neutral'}>{c.descriptor}</Badge>
          <div className="flex flex-wrap gap-1">
            {LEVELS.map((l) => (
              <button
                key={l.level}
                type="button"
                disabled={pending}
                onClick={() => onRate(l.level, note || undefined)}
                title={isStaff ? `Record as ${l.label}` : `My view: ${l.label}`}
                className={cn(
                  'rounded-sm border px-2 py-1 text-[13px] transition-colors duration-150',
                  'disabled:pointer-events-none disabled:opacity-50',
                  mine?.level === l.level
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-accent',
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[13px] text-muted-foreground hover:text-foreground"
          >
            {open ? 'Hide note' : 'Add a note'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              isStaff
                ? 'An example from this term — a rating with no example is a number pretending to be feedback'
                : 'What you have noticed at home'
            }
            className="field flex-1"
          />
          <Button
            size="sm"
            disabled={pending || !note.trim()}
            onClick={() => {
              onRate(mine?.level, note)
              setOpen(false)
            }}
          >
            Save note
          </Button>
        </div>
      )}
    </li>
  )
}
