import { useQuery } from '@tanstack/react-query'
import { api, type List, type Period, type TimetableEntry } from '@/lib/api'
import { PageHead, PageBody, Select, ErrorState, EmptyState } from '@/components/ui'
import DayTimeline from '@/components/DayTimeline'
import { Freshness, ScreenSkeleton } from './screen-state'
import { useChildren, childOptions, readyFor } from './use-children'

/* Your child's week.
 *
 * The school had a timetable for every section and the family had no way to
 * read it: "is there PT tomorrow, does she need the kit" was a question for
 * the class WhatsApp group.
 *
 * On a phone — which is where a parent reads this — a six-by-nine grid is a
 * squint. So the phone gets one day at a time: a strip of day chips, and the
 * chosen day as a vertical timeline, period by period, times down the left,
 * the period that is on right now lit up. Today is selected on open. The
 * same view on every screen: a parent on a laptop wants the same answer.
 *
 * Asked by section, not by "me": the timetable endpoint's family scope covers
 * every child's section at once, which for a parent of two is two weeks
 * overlaid. The child list carries each child's section_id, so the picker
 * chooses and the query names one section. */
export default function ChildTimetable() {
  const { children: kids, query: kidsQuery, studentId, child, setChosen } = useChildren()
  const sectionId = child?.section_id ?? ''

  const periods = useQuery({
    /* Every schedule, on purpose. Asking by section gave the schedule the
       section is filed under — and on the live school the lessons had been
       laid on a different schedule's periods, so the day showed that
       schedule's breaks and none of the lessons. The timeline keeps to the
       periods the lessons actually use, and takes breaks from their schedule. */
    queryKey: ['periods'],
    queryFn: () => api.get<List<Period>>('/api/v1/timetable/periods'),
    enabled: !!sectionId,
  })
  const entries = useQuery({
    queryKey: ['timetable', 'section', sectionId],
    queryFn: () => api.get<List<TimetableEntry>>(`/api/v1/timetable/entries?section_id=${sectionId}`),
    enabled: !!sectionId,
  })

  const ready = readyFor(kids, studentId)

  return (
    <>
      <PageHead
        eyebrow="My child"
        title="Timetable"
        actions={
          kids.length > 1 && (
            <Select
              value={studentId}
              onChange={setChosen}
              placeholder="Which child?"
              options={childOptions(kids)}
            />
          )
        }
      />
      <Freshness query={entries} />
      <PageBody>
        {kidsQuery.isLoading ? (
          <ScreenSkeleton rows={6} label="Loading your children" />
        ) : kidsQuery.error ? (
          <ErrorState error={kidsQuery.error} />
        ) : kids.length === 0 ? (
          <EmptyState
            title="No child is linked to this account yet."
            body="Once the school links your child, their week appears here."
          />
        ) : !ready ? (
          <EmptyState title="Choose a child above to see their week." />
        ) : !sectionId ? (
          <EmptyState
            title={`${child?.full_name ?? 'Your child'} is not placed in a section yet.`}
            body="The timetable belongs to a section; it appears once the school places them."
          />
        ) : periods.isLoading || entries.isLoading ? (
          <ScreenSkeleton rows={6} label="Loading the week" />
        ) : entries.error ? (
          <ErrorState error={entries.error} />
        ) : (
          <>
            <DayTimeline
              who={`${child?.full_name ?? ''}`}
              where={`${child?.class_name ?? ''} ${child?.section_name ?? ''}`.trim()}
              periods={periods.data?.items ?? []}
              entries={(entries.data?.items ?? []).map((e) => ({
                weekday: e.weekday,
                period_id: e.period_id,
                title: e.subject_name || e.subject_code,
                detail: [e.teacher_name, e.room].filter(Boolean).join(' • '),
              }))}
            />
          </>
        )}
      </PageBody>
    </>
  )
}

