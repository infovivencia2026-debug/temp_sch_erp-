import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHead, PageBody, Select, ErrorState, EmptyState } from '@/components/ui'
import DayTimeline from '@/components/DayTimeline'
import { Freshness, ScreenSkeleton } from './screen-state'
import { useChildren, childOptions, readyFor } from './use-children'
import { ChooseChild } from '@/features/portal/ChooseChild'
import { useT } from '@/lib/i18n'

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
  const t = useT()
  const { children: kids, query: kidsQuery, studentId, child, setChosen } = useChildren()
  const sectionId = child?.section_id ?? ''

  const periods = useQuery({
    /* Every schedule, on purpose. Asking by section gave the schedule the
       section is filed under — and on the live school the lessons had been
       laid on a different schedule's periods, so the day showed that
       schedule's breaks and none of the lessons. The timeline keeps to the
       periods the lessons actually use, and takes breaks from their schedule. */
    queryKey: ['periods'],
    queryFn: () => api.call('GET /timetable/periods'),
    enabled: !!sectionId,
  })
  const entries = useQuery({
    queryKey: ['timetable', 'section', sectionId],
    queryFn: () => api.call('GET /timetable/entries', { query: { section_id: sectionId } }),
    enabled: !!sectionId,
  })

  const ready = readyFor(kids, studentId)

  return (
    <>
      <PageHead
        eyebrow={t('portal.child_timetable.eyebrow')}
        title={t('portal.child_timetable.title')}
        actions={
          kids.length > 1 && (
            <Select
              value={studentId}
              onChange={setChosen}
              placeholder={t('portal.child_timetable.child_placeholder')}
              options={childOptions(kids)}
            />
          )
        }
      />
      <Freshness query={entries} />
      <PageBody>
        {kidsQuery.isLoading ? (
          <ScreenSkeleton rows={6} label={t('portal.child_timetable.loading_children')} />
        ) : kidsQuery.error ? (
          <ErrorState error={kidsQuery.error} />
        ) : kids.length === 0 ? (
          <EmptyState
            title={t('portal.child_timetable.unlinked_title')}
            body={t('portal.child_timetable.unlinked_body')}
          />
        ) : !ready ? (
          <ChooseChild title={t('portal.child_timetable.choose_child')} />
        ) : !sectionId ? (
          <EmptyState
            title={child?.full_name ? t('portal.child_timetable.no_section_named', { name: child.full_name }) : t('portal.child_timetable.no_section')}
            body={t('portal.child_timetable.no_section_body')}
          />
        ) : periods.isLoading || entries.isLoading ? (
          <ScreenSkeleton rows={6} label={t('portal.child_timetable.loading_week')} />
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

