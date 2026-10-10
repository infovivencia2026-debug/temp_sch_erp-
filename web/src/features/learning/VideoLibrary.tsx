import { useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Check, PlayCircle, Search, Video } from 'lucide-react'
import { api } from '@/lib/api'
import { EmptyState, ErrorState, PageBody, PageHead } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useFeatureHref } from '@/features/bento/bento-kit'
import { youTubeIds, type Lesson } from './lms-shared'

/* LMS IS THE VIDEOS (owner, 2026-10-10: "LMS only for videos"). Courses /
   subjects is the whole learning path -- days, lessons, quizzes, homework.
   This is every video the child's teachers have put up, across all their
   subjects, in one library: a thumbnail, the subject and unit, and a tick
   once watched. A video opens on its own lesson page in the subject, where
   the notes and the watching progress already live. */

interface CourseRow { class_subject_id: string; subject: string }
interface SItem { type: 'lesson' | 'assignment' | 'quiz'; id: string; done: boolean; locked: boolean; lesson?: Lesson | null }
interface SDay { key: string; items: SItem[] }
interface SModule { id: string; title: string; days: SDay[] }
interface Detail { modules: SModule[] }

interface Vid { cs: string; subject: string; unit: string; mod: string; day: string; lesson: Lesson; done: boolean; locked: boolean; yt: string | null }

const isVideo = (l: Lesson) => l.kind === 'video' || !!l.yt_video_id || !!l.yt_playlist_id || !!l.video_id || !!youTubeIds(l.url).video

export default function VideoLibrary() {
  const courses = useQuery({ queryKey: ['my-courses'], queryFn: () => api.get<{ items: CourseRow[] }>('/api/v1/portal/lms/courses') })
  const rows = courses.data?.items ?? []
  const details = useQueries({
    queries: rows.map((c) => ({
      queryKey: ['lms-course', c.class_subject_id],
      queryFn: () => api.get<Detail>(`/api/v1/portal/lms/course?class_subject_id=${c.class_subject_id}`),
    })),
  })
  const courseHref = useFeatureHref('student.learning.courses_subjects')
  const [subject, setSubject] = useState<string>('all')
  const [find, setFind] = useState('')
  const [show, setShow] = useState<'all' | 'todo' | 'done'>('all')

  const vids: Vid[] = []
  rows.forEach((c, i) => {
    const d = details[i]?.data
    for (const m of d?.modules ?? []) for (const day of m.days) for (const it of day.items) {
      if (it.type !== 'lesson' || !it.lesson || !isVideo(it.lesson)) continue
      vids.push({ cs: c.class_subject_id, subject: c.subject, unit: m.title, mod: m.id, day: day.key, lesson: it.lesson, done: it.done, locked: it.locked || !!it.lesson.locked || !!it.lesson.scheduled,
        yt: it.lesson.yt_video_id ?? youTubeIds(it.lesson.url).video })
    }
  })
  const loading = courses.isLoading || details.some((d) => d.isLoading)
  const q = find.trim().toLowerCase()
  const shown = vids.filter((v) => (subject === 'all' || v.cs === subject)
    && (show === 'all' || (show === 'done' ? v.done : !v.done))
    && (!q || v.lesson.title.toLowerCase().includes(q) || v.unit.toLowerCase().includes(q)))
  const watched = vids.filter((v) => v.done).length

  return (
    <>
      <PageHead eyebrow="Learning" title="LMS · Videos" description={vids.length ? `${vids.length} video${vids.length === 1 ? '' : 's'} · ${watched} watched` : 'Every video your teachers have shared'} />
      <PageBody>
        {courses.error ? <ErrorState error={courses.error} /> : (
          <div className="space-y-4">
            {/* Filters: subject chips, watched / to watch, search. */}
            <div className="flex flex-col gap-3 rounded-2xl border bg-card p-3 sm:flex-row sm:items-center">
              <div className="-mx-1 flex flex-1 gap-1.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {[{ id: 'all', name: 'All subjects' }, ...rows.map((c) => ({ id: c.class_subject_id, name: c.subject }))].map((x) => (
                  <button key={x.id} type="button" onClick={() => setSubject(x.id)} aria-pressed={subject === x.id}
                    className={cn('shrink-0 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors',
                      subject === x.id ? 'border-[#4f46e5] bg-[#eef2ff] text-[#4f46e5]' : 'text-muted-foreground hover:bg-muted/60')}>
                    {x.name}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 rounded-lg bg-muted p-[3px]">
                {(['all', 'todo', 'done'] as const).map((f) => (
                  <button key={f} type="button" onClick={() => setShow(f)} aria-pressed={show === f}
                    className={cn('rounded-md px-3 py-1 text-[12px] font-semibold', show === f ? 'bg-card shadow-sm' : 'text-muted-foreground')}>
                    {f === 'all' ? 'All' : f === 'todo' ? 'To watch' : 'Watched'}
                  </button>
                ))}
              </div>
              <label className="flex min-h-[36px] items-center gap-2 rounded-lg border px-2.5 sm:w-56">
                <Search className="size-4 text-muted-foreground" aria-hidden />
                <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a video" className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none" />
              </label>
            </div>

            {loading && !vids.length ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy>
                {[0, 1, 2, 3].map((i) => <div key={i} className="aspect-[4/3] animate-pulse rounded-2xl bg-muted" />)}
              </div>
            ) : !shown.length ? (
              <EmptyState title={vids.length ? 'No video matches' : 'No videos yet'} body={vids.length ? 'Try another subject or clear the search.' : 'Videos your teachers add to your subjects appear here.'} />
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {shown.map((v) => {
                  const href = `${courseHref}?cs=${v.cs}&mod=${encodeURIComponent(v.mod)}&day=${encodeURIComponent(v.day)}&item=${encodeURIComponent(`lesson:${v.lesson.id}`)}`
                  const body = (
                    <>
                      <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-900">
                        {v.yt ? <img src={`https://i.ytimg.com/vi/${v.yt}/mqdefault.jpg`} alt="" loading="lazy" className="size-full object-cover" />
                          : <div className="grid size-full place-items-center text-white/70"><Video className="size-10" aria-hidden /></div>}
                        <span className="absolute inset-0 grid place-items-center bg-black/10 transition-colors group-hover:bg-black/25">
                          <PlayCircle className="size-12 text-white drop-shadow-lg" strokeWidth={1.5} aria-hidden />
                        </span>
                        {v.done && <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-emerald-500 px-2 py-0.5 text-[11px] font-bold text-white"><Check className="size-3" strokeWidth={3} aria-hidden /> Watched</span>}
                        {v.lesson.video_percent != null && !v.done && v.lesson.video_percent > 0 && (
                          <span className="absolute inset-x-0 bottom-0 h-1 bg-white/30"><span className="block h-full bg-red-500" style={{ width: `${Math.min(100, v.lesson.video_percent)}%` }} /></span>
                        )}
                      </div>
                      <div className="mt-2.5 min-w-0 px-0.5">
                        <p className="line-clamp-2 text-[14px] font-semibold leading-snug">{v.lesson.title}</p>
                        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{v.subject} · {v.unit}</p>
                      </div>
                    </>
                  )
                  return (
                    <li key={`${v.cs}:${v.lesson.id}`}>
                      {v.locked ? (
                        <div className="rounded-2xl border bg-card p-2.5 opacity-60" title="Not open yet">{body}</div>
                      ) : (
                        <Link to={href} className="group block rounded-2xl border bg-card p-2.5 transition-shadow hover:shadow-md">{body}</Link>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </PageBody>
    </>
  )
}
