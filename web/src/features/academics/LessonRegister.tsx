import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, Field, Select, ErrorState, EmptyState, Loading } from '@/components/ui'
import ChapterPlan from './ChapterPlan'
import LessonDayPlan from './LessonDayPlan'

/* LESSON PLAN (owner, 2026-11-05: "only chapter wise is enough"). Pick a
   class-section and a subject; every chapter of it shows with its progress
   (ChapterPlan). A teacher sees only the classes the timetable gives them;
   the principal and academics see every class. The day-by-day register is
   off the screen until the owner asks for it back; its API stays. */

interface Options {
  sections: { id: string; class_name: string; section: string }[]
  subjects: { section_id: string; class_subject_id: string; subject: string; teacher_ids?: string[] }[]
  teachers?: { id: string; name: string }[]
  sees_all?: boolean
}

export default function LessonRegister() {
  const opts = useQuery({ queryKey: ['lesson-register-options'], queryFn: () => api.get<Options>('/api/v1/academics/lesson-register/options') })
  const [teacher, setTeacher] = useState('')
  const [section, setSection] = useState('')
  const [subject, setSubject] = useState('')
  const o = opts.data
  // Admin and principal can narrow everything to one teacher's classes.
  const mine = useMemo(() => (o?.subjects ?? []).filter((s) => !teacher || (s.teacher_ids ?? []).includes(teacher)), [o, teacher])
  const sections = useMemo(() => (o?.sections ?? []).filter((s) => mine.some((m) => m.section_id === s.id)), [o, mine])
  const subjects = useMemo(() => mine.filter((s) => s.section_id === section), [mine, section])
  const showTeacher = !!o?.sees_all && (o?.teachers?.length ?? 0) > 0
  // A class with one subject (a teacher's usual case) needs no second choice.
  useEffect(() => { if (subjects.length === 1) setSubject(subjects[0].class_subject_id) }, [subjects])

  const [days, setDays] = useState(false)
  if (days) return <LessonDayPlan onChapters={() => setDays(false)} />
  if (opts.isError) return <ErrorState error={opts.error} />
  // Never an empty class list while it is still coming (owner, 2026-11-11).
  if (opts.isLoading) return <PageBody><Loading label="Loading your classes" /></PageBody>

  return (
    <>
      <PageHead eyebrow="Academics" title="Lesson plan" />
      <PageBody>
        <Card className="p-4 sm:p-5">
          <div className={`grid gap-4 sm:grid-cols-2 ${showTeacher ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
            {showTeacher && (
              <Field label="Teacher">
                <Select value={teacher} onChange={(v) => { setTeacher(v); setSection(''); setSubject('') }} placeholder="All teachers"
                  options={[{ value: '', label: 'All teachers' }, ...(o?.teachers ?? []).map((t) => ({ value: t.id, label: t.name }))]} />
              </Field>
            )}
            <Field label="Class and section">
              <Select value={section} onChange={(v) => { setSection(v); setSubject('') }} placeholder="Choose a class"
                options={sections.map((s) => ({ value: s.id, label: `${s.class_name} - ${s.section}` }))} />
            </Field>
            <Field label="Subject">
              <Select value={subject} onChange={setSubject} placeholder={section ? 'Choose a subject' : 'Choose a class first'}
                options={subjects.map((s) => ({ value: s.class_subject_id, label: s.subject }))} />
            </Field>
            <Field label="Show">
              <Select value="chapters" onChange={(v) => v === 'days' && setDays(true)}
                options={[{ value: 'chapters', label: 'Chapters' }, { value: 'days', label: 'Day by day' }]} />
            </Field>
          </div>
        </Card>
        {section && subject ? <ChapterPlan sectionId={section} classSubjectId={subject} /> : (
          <EmptyState title="Choose a class and subject"
            body={o && !o.sections.length ? 'No classes are in the timetable for this year yet.' : 'Every chapter of that subject shows here, with its progress.'} />
        )}
      </PageBody>
    </>
  )
}
