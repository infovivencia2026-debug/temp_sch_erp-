import { useParams } from 'react-router-dom'
import { useFeature } from '@/lib/catalog'
import { PageHead, PageBody, ErrorState } from '@/components/ui'

/* A FAILED SCREEN THAT STILL LOOKS LIKE A SCREEN.
 *
 * Every family screen in this folder opened with the same two lines:
 *
 *     if (q.isLoading) return <Loading />
 *     if (q.error) return <ErrorState error={q.error} />
 *
 * and the second of those is the bug this file exists to close. `ErrorState`
 * draws a card with a red sentence in it and nothing else. Returned on its
 * own, ahead of the component's own `PageHead`, it takes the page title, the
 * breadcrumb and the whole of the page frame down with it. What a parent gets
 * is a white card floating at the top of an otherwise blank phone screen,
 * carrying one line of server English, above a navigation dock that is now the
 * only thing on screen telling them which application they are in.
 *
 * This is not a hypothetical failure reached only by an outage. An account
 * that holds the parent role but has no child linked to it yet -- the state
 * every family is in between the school creating the login and the office
 * connecting the record, which is to say on the first day -- gets a 403 from
 * the remarks endpoint, and what that rendered was a page whose entire visible
 * content was the words "missing permission: a parent's own remarks". No
 * title, no explanation, nothing to press. It was measured on the live site
 * before this was written.
 *
 * The title does not have to be passed in and deliberately is not. Asking each
 * of the thirty-odd call sites to repeat its own eyebrow and title is how the
 * two drift apart, and a screen that has just failed to load is the worst
 * place for a heading that disagrees with the one next door. The route already
 * knows: the catalogue names the section and the feature the address asked
 * for, and those are the same two strings the working screen puts at the top.
 * So the failed screen and the loaded screen carry the same heading, and the
 * error reads as one part of a page that is otherwise where it should be
 * rather than as the page having been replaced.
 *
 * The fallbacks matter for the one case the catalogue cannot answer: a screen
 * rendered outside a feature route, which is rare but not impossible. A
 * generic heading is still a heading, and still better than none.
 */
export function ScreenError({ error }: { error: unknown }) {
  const { sectionSlug, featureSlug } = useParams()
  const { section, feature } = useFeature(sectionSlug, featureSlug)
  return (
    <>
      <PageHead eyebrow={section?.name} title={feature?.name ?? 'This screen'} />
      <PageBody>
        <ErrorState error={error} />
      </PageBody>
    </>
  )
}
