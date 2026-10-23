import { PageHead, PageBody } from '@/components/ui'
import { useRouteFeature } from '@/lib/catalog'
import Timeline from '@/components/Timeline'

/* School activity (owner, 2026-10-23): everything students, parents and staff
   do on the platform, on one timeline, for the principal, with filters for
   who, what, when and a name. The list itself is the shared Timeline, the
   same one Student 360 and Staff 360 wear, pointed at the whole school
   (GET /api/v1/admin/activity, worker/src/routes/admin/school_activity.ts). */
export default function SchoolActivity() {
  const nav = useRouteFeature()
  return (
    <>
      <PageHead
        eyebrow={nav.section?.name ?? 'Activity'}
        title={nav.feature?.name ?? 'School activity'}
        description="What students, parents and staff have done on the platform, newest first. Open any line to go to it."
      />
      <PageBody>
        <Timeline
          url="/api/v1/admin/activity"
          title="Everything that happened"
          description="Sign-ins, concerns, leave, attendance taken, fees, homework, messages, notices, remarks and changes to records. A message's words are never shown, only who wrote to whom."
          filters
        />
      </PageBody>
    </>
  )
}
