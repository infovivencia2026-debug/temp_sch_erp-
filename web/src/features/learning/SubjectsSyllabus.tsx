import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, Check, ChevronDown, User } from 'lucide-react'
import { api } from '@/lib/api'
import { EmptyState, ErrorState, PageBody, PageHead } from '@/components/ui'
import { cn } from '@/lib/utils'

/* COURSES / SUBJECTS (owner, 2026-10-10: "in subjects -> the subjects they
   have in that year and full syllabus if school or teacher updated it ...
   show subjects and lessons what they have"). Not the LMS: the LMS is the
   courses the LMS admin builds, day- or topic-wise, with their videos.

   This is the year at a glance: every subject of the child's class with its
   teacher, and under it the syllabus -- the chapters in order, what each one
   covers, and a tick once the teacher has taught it (the same "delivered" the
   staff syllabus screen records). A subject with no syllabus says so. */

interface CourseRow { class_subject_id: string; subject: string; teacher?: string | null }
interface Unit { id: string; sequence: number; title: string; description?: string; outcomes?: string; planned_periods?: number; delivered: boolean; delivered_on?: string }

const TINTS = ['bg-indigo-50 text-indigo-700', 'bg-emerald-50 text-emerald-700', 'bg-amber-50 text-amber-700', 'bg-sky-50 text-sky-700', 'bg-rose-50 text-rose-700']
const tint = (name: string) => { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return TINTS[h % TINTS.length] }

function Syllabus({ cs }: { cs: string }) {
  const q = useQuery({
    queryKey: ['syllabus-units', cs],
    queryFn: () => api.get<{ items: Unit[] }>(`/api/v1/syllabus/units?class_subject_id=${cs}`),
  })
  if (q.isLoading) return <p className="px-5 py-4 text-[13px] text-muted-foreground">Reading the syllabus…</p>
  if (q.error) return <div className="px-5 py-3"><ErrorState error={q.error} /></div>
  const units = q.data?.items ?? []
  if (!units.length) return <p className="px-5 py-4 text-[13.5px] text-muted-foreground">The syllabus for this subject has not been added yet.</p>
  return (
    <ol className="divide-y">
      {units.map((u, i) => (
        <li key={u.id} className="flex gap-3 px-5 py-3">
          <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-bold',
            u.delivered ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground')}>
            {u.delivered ? <Check className="size-3.5" strokeWidth={3} aria-label="Taught" /> : i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-semibold leading-snug">{u.title}</p>
            {u.description && <p className="mt-0.5 text-[13px] text-muted-foreground">{u.description}</p>}
            {u.outcomes && <p className="mt-1 text-[12.5px] text-muted-foreground"><span className="font-semibold text-foreground/80">You will learn: </span>{u.outcomes}</p>}
          </div>
          <span className={cn('shrink-0 self-start rounded-md px-2 py-0.5 text-[11px] font-semibold',
            u.delivered ? 'bg-emerald-50 text-emerald-700' : 'text-muted-foreground')}>
            {u.delivered ? 'Taught' : u.planned_periods ? `${u.planned_periods} period${u.planned_periods === 1 ? '' : 's'}` : ''}
          </span>
        </li>
      ))}
    </ol>
  )
}

export default function SubjectsSyllabus() {
  const q = useQuery({
    queryKey: ['my-courses'],
    queryFn: () => api.get<{ class_name: string; section_name: string; items: CourseRow[] }>('/api/v1/portal/lms/courses'),
  })
  const [open, setOpen] = useState<string | null>(null)
  const rows = q.data?.items ?? []
  const cls = q.data ? [q.data.class_name, q.data.section_name].filter(Boolean).join(' ') : ''

  return (
    <>
      <PageHead eyebrow="Learning" title="My subjects"
        description={cls ? `${cls} · ${rows.length} subject${rows.length === 1 ? '' : 's'} this year` : 'Your subjects this year and what each one covers'} />
      <PageBody>
        {q.error ? <ErrorState error={q.error} /> : !q.data ? (
          <div className="space-y-3" aria-busy>{[0, 1, 2].map((i) => <div key={i} className="h-[72px] animate-pulse rounded-2xl bg-muted" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title="No subjects yet" body="Your subjects appear here once you are in a class for this year." />
        ) : (
          <ul className="space-y-3">
            {rows.map((c) => {
              const isOpen = open === c.class_subject_id
              return (
                <li key={c.class_subject_id} className="overflow-hidden rounded-2xl border bg-card shadow-sm">
                  <button type="button" onClick={() => setOpen(isOpen ? null : c.class_subject_id)} aria-expanded={isOpen}
                    className="flex w-full items-center gap-3.5 px-5 py-4 text-left">
                    <span className={cn('grid size-11 shrink-0 place-items-center rounded-xl', tint(c.subject))}>
                      <BookOpen className="size-5" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[16.5px] font-bold">{c.subject}</span>
                      <span className="flex items-center gap-1.5 truncate text-[13px] text-muted-foreground">
                        <User className="size-3.5 shrink-0" aria-hidden /> {c.teacher || 'Teacher not set yet'}
                      </span>
                    </span>
                    <span className="hidden text-[12.5px] font-medium text-muted-foreground sm:block">{isOpen ? 'Hide syllabus' : 'Syllabus'}</span>
                    <ChevronDown className={cn('size-5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} aria-hidden />
                  </button>
                  {isOpen && <div className="border-t"><Syllabus cs={c.class_subject_id} /></div>}
                </li>
              )
            })}
          </ul>
        )}
      </PageBody>
    </>
  )
}
