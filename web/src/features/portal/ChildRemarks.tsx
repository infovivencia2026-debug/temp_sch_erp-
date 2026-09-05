import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Award, TriangleAlert } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, Badge, Select, EmptyState } from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { formatDate } from '@/lib/utils'
import { useChildren, childOptions } from './use-children'

/* What the school has written about your child.
 *
 * Teachers have been writing remarks since the table was created and the
 * family had no screen to read them on. The visible_to_family flag was set on
 * every one of them and nothing acted on it, so a note written the afternoon
 * it happened reached the parents at the next parents' evening — by which
 * point "did not bring the notebook, third time" is a fact about last term.
 *
 * Newest first, because the recent one is the one being asked about. Grouped
 * by nothing: a term's remarks about one child is a short list, and grouping
 * a short list by month is a way of hiding it inside headings.
 *
 * Private notes are not here and are not hidden here either — the endpoint
 * does not send them. A teacher's own working note is theirs, and the
 * difference between "not sent" and "sent and hidden by the browser" is the
 * whole of whether that flag means anything.
 */

interface Remark {
  id: string
  student_id: string
  child_name: string
  observed_on: string
  kind: string
  body: string
  subject?: string
  class_name?: string
  section_name?: string
  teacher?: string
}

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  achievement: 'success',
  participation: 'success',
  concern: 'danger',
  behaviour: 'warning',
  academic: 'neutral',
}

const LABEL: Record<string, string> = {
  achievement: 'Commendation',
  participation: 'Participation',
  concern: 'Concern',
  behaviour: 'Conduct',
  academic: 'Academic',
}

export default function ChildRemarks() {
  const { children: kids, query: kidsQuery } = useChildren()
  const [studentID, setStudentID] = useState('')

  /* ASK ONLY ONCE THERE IS A CHILD TO ASK ABOUT.
   *
   * listChildRemarks refuses an account with no linked student, and it is
   * right to: answering with an empty list would say "no teacher has written
   * anything about your child", which is a claim about a child this account
   * does not have. So it returns 403 "a parent's own remarks", which is a
   * sentence written for whoever reads the log.
   *
   * That sentence was reaching parents. An account holding the parent role
   * with no student linked to it yet is not a broken account or a misuse of
   * the product -- it is every family, in the window between the school
   * issuing the login and the office connecting the record, which for most of
   * them is the first day and the first thing they do with the application.
   * What they got was the words "missing permission: a parent's own remarks"
   * in red on an otherwise blank screen.
   *
   * `enabled` keeps the request from being made at all until the family list
   * has arrived and has somebody in it, so the refusal is never provoked, and
   * the branch below says the same thing the fees and results screens already
   * say in the same state. Those two were written with this guard and this one
   * was not; the difference was never intentional.
   *
   * The query still exists for the case the guard cannot cover -- a link
   * removed between the family list loading and this request landing -- and
   * that failure now renders with its own page heading rather than replacing
   * the page.
   */
  const q = useQuery({
    queryKey: ['child-remarks', studentID],
    queryFn: () =>
      api.get<List<Remark>>(
        `/api/v1/portal/remarks${studentID ? `?student_id=${studentID}` : ''}`,
      ),
    enabled: kids.length > 0,
  })

  if (kidsQuery.isLoading) return <ScreenSkeleton />
  if (kidsQuery.error && !kidsQuery.data) return <ScreenError error={kidsQuery.error} />

  if (kids.length === 0) {
    return (
      <>
        <PageHead eyebrow="My child" title="Remarks" />
        <PageBody>
          <EmptyState
            title="No student record linked"
            body="Your account is not linked to a student yet. Ask the school office to connect it. Once it is, everything your child's teachers write appears here on the day they write it."
          />
        </PageBody>
      </>
    )
  }

  if (q.isLoading) return <ScreenSkeleton />
  if (q.error && !q.data) return <ScreenError error={q.error} />

  const items = q.data?.items ?? []
  const praise = items.filter((x) => TONE[x.kind] === 'success').length
  const concerns = items.filter((x) => TONE[x.kind] === 'danger' || TONE[x.kind] === 'warning').length

  return (
    <>
      <PageHead
        eyebrow="My child"
        title="Remarks"
        description="What your child’s teachers have written, newest first."
        actions={
          kids.length > 1 && (
            <Select
              value={studentID}
              onChange={setStudentID}
              placeholder="All my children"
              options={[{ value: '', label: 'All my children' }, ...childOptions(kids)]}
            />
          )
        }
      />
      <Freshness query={q} />
      <PageBody>
        {items.length > 0 && (
          <div className="flex flex-wrap gap-3">
            <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Award className="h-3.5 w-3.5 text-success" aria-hidden />
              {praise} {praise === 1 ? 'commendation' : 'commendations'}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
              {concerns} needing a word at home
            </span>
          </div>
        )}

        <Card>
          <CardHeader
            title="Remarks"
            description={`${items.length} in the record`}
          />
          {items.length === 0 ? (
            <EmptyState
              title="Nothing written yet"
              body="When a teacher records something about your child — good or otherwise — it appears here and you are told about it the same day."
            />
          ) : (
            <ul className="divide-y">
              {items.map((x) => (
                <li key={x.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Badge tone={TONE[x.kind] ?? 'neutral'}>{LABEL[x.kind] ?? x.kind}</Badge>
                    <span className="text-[13px] text-muted-foreground">
                      {formatDate(x.observed_on)}
                    </span>
                    {/* Named, because a remark from the Physics teacher and one
                        from the class teacher are read differently. */}
                    {x.teacher && (
                      <span className="text-[13px] text-muted-foreground">
                        · {x.teacher}
                        {x.subject && ` (${x.subject})`}
                      </span>
                    )}
                    {!studentID && (
                      <span className="text-[13px] font-medium">· {x.child_name}</span>
                    )}
                  </div>
                  <p className="mt-1 text-[14px]">{x.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}
