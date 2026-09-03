import { TriLoader } from '@/components/Loader'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Users, GraduationCap, UserPlus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Field,
  FormGrid, FormNotice, Input, Textarea, Checkbox, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface StudyGroup {
  id: string
  name: string
  topic?: string
  subject?: string
  meets_when?: string
  venue?: string
  capacity?: number
  is_open: boolean
  organiser: string
  organised_by_me: boolean
  members: number
  joined: boolean
  my_role: string
  has_space: boolean
  tutors: number
  created_on: string
}
interface Member {
  student_id: string
  name: string
  role: string
  joined_on: string
}

/* Revising together, and offering to help.

   Peer tutoring and a study group are the same arrangement seen from two
   sides, so they are one board with a flag rather than two screens listing the
   same Thursday lunchtime twice.

   The roster is only fetched for a group the child has joined. Who is in a
   group is for the people in it — the board itself carries the organiser's
   name and a headcount, which is what a notice on the classroom wall carries. */
export default function StudyGroups() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [meets, setMeets] = useState('')
  const [venue, setVenue] = useState('')
  const [tutoring, setTutoring] = useState(false)
  const [openRoster, setOpenRoster] = useState<string | null>(null)

  const groups = useQuery({
    queryKey: ['study-groups', studentId],
    queryFn: () =>
      api.get<List<StudyGroup>>(`/api/v1/portal/learning/study-groups${studentQuery(studentId)}`),
    enabled: ready,
  })

  const roster = useQuery({
    queryKey: ['study-group-members', openRoster, studentId],
    queryFn: () =>
      api.get<List<Member>>(
        `/api/v1/portal/learning/study-groups/${openRoster}/members${studentQuery(studentId)}`,
      ),
    enabled: !!openRoster,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['study-groups'] })

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/learning/study-groups', {
        student_id: studentId || undefined,
        name,
        topic: topic || undefined,
        meets_when: meets || undefined,
        venue: venue || undefined,
        offering_tutoring: tutoring,
      }),
    onSuccess: () => {
      setName(''); setTopic(''); setMeets(''); setVenue(''); setTutoring(false)
      refresh()
    },
  })

  const join = useMutation({
    mutationFn: (v: { id: string; tutoring: boolean }) =>
      api.post(`/api/v1/portal/learning/study-groups/${v.id}/join`, {
        student_id: studentId || undefined,
        offering_tutoring: v.tutoring,
      }),
    onSuccess: refresh,
  })

  const leave = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/portal/learning/study-groups/${id}/leave`, {
        student_id: studentId || undefined,
      }),
    onSuccess: () => {
      setOpenRoster(null)
      refresh()
    },
  })

  if (groups.isLoading && ready) return <SkeletonTiles count={3} label="Looking up your class's groups…" />
  if (groups.error) return <ErrorState error={groups.error} />

  const rows = groups.data?.items ?? []
  const mine = rows.filter((g) => g.joined)
  const tutors = rows.reduce((n, g) => n + g.tutors, 0)

  return (
    <>
      <PageHead
        eyebrow="Learning"
        title="Study groups and peer tutoring"
        description="Groups your own class has arranged. Join one, or start one and offer to help."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState
            title="Choose a child"
            body="Groups are arranged within a class, so each child sees their own."
          />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Groups in your class" value={rows.length} icon={Users} />
              <Stat label="You have joined" value={mine.length} icon={UserPlus} />
              <Stat label="Classmates tutoring" value={tutors} icon={GraduationCap} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Start a group"
                description="It opens in your own class, and you are its first member."
              />
              <div className="space-y-5 p-5">
                <FormGrid>
                  <Field label="Name" required hint="What your class will recognise it by.">
                    <Input value={name} onChange={setName} placeholder="Algebra revision" />
                  </Field>
                  <Field label="When it meets" hint="In your own words — Tuesdays, second lunch.">
                    <Input value={meets} onChange={setMeets} placeholder="Tuesdays, second lunch" />
                  </Field>
                  <Field label="Where">
                    <Input value={venue} onChange={setVenue} placeholder="Library, back table" />
                  </Field>
                  <Field label="What you will work on" wide>
                    <Textarea value={topic} onChange={setTopic} rows={2}
                      placeholder="Quadratics, and past papers from last term" />
                  </Field>
                </FormGrid>
                <Checkbox
                  checked={tutoring}
                  onChange={setTutoring}
                  label="I am offering to help others with this"
                  hint="Marks you as a tutor rather than someone revising alongside."
                />
                <FormNotice error={create.error} ok={create.isSuccess ? 'Group opened.' : undefined} />
                <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
                  {create.isPending ? 'Opening…' : 'Open the group'}
                </Button>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Your class's groups"
                description="Open groups first. The roster is visible once you have joined."
              />
              {rows.length === 0 ? (
                <EmptyState
                  title="No groups yet"
                  body="Nobody in your class has started one. Yours would be the first."
                />
              ) : (
                <ul className="divide-y">
                  {rows.map((g) => (
                    <li key={g.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium">
                            {g.name}
                            {g.my_role === 'tutor' && <Badge tone="success">You tutor</Badge>}
                            {!g.is_open && <Badge>Closed</Badge>}
                            {g.subject && <Badge tone="info">{g.subject}</Badge>}
                          </p>
                          {g.topic && (
                            <p className="mt-1 text-[13px] text-muted-foreground">{g.topic}</p>
                          )}
                          <p className="mt-1 text-[12.5px] text-muted-foreground">
                            Started by {g.organised_by_me ? 'you' : g.organiser}
                            {g.meets_when ? ` · ${g.meets_when}` : ''}
                            {g.venue ? ` · ${g.venue}` : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <span className="text-[13px] tabular-nums text-muted-foreground">
                            {g.members}
                            {g.capacity ? ` / ${g.capacity}` : ''} in
                          </span>
                          {g.joined ? (
                            <>
                              <Button size="sm" variant="secondary"
                                onClick={() => setOpenRoster(openRoster === g.id ? null : g.id)}>
                                {openRoster === g.id ? 'Hide who is in' : 'Who is in'}
                              </Button>
                              <Button size="sm" variant="ghost" tone="danger"
                                disabled={leave.isPending}
                                onClick={() => leave.mutate(g.id)}>
                                Leave
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button size="sm" disabled={!g.is_open || !g.has_space || join.isPending}
                                onClick={() => join.mutate({ id: g.id, tutoring: false })}>
                                {!g.is_open ? 'Closed' : g.has_space ? 'Join' : 'Full'}
                              </Button>
                              <Button size="sm" variant="secondary"
                                disabled={!g.is_open || !g.has_space || join.isPending}
                                title="Join and offer to help the others"
                                onClick={() => join.mutate({ id: g.id, tutoring: true })}>
                                Join as tutor
                              </Button>
                            </>
                          )}
                        </div>
                      </div>

                      {openRoster === g.id && (
                        <div className="mt-3 rounded-md border bg-muted/30 p-3">
                          {roster.isLoading ? (
                            <TriLoader size={16} className="text-muted-foreground" />
                          ) : roster.error ? (
                            <p className="text-[13px] text-muted-foreground">
                              Only members can see who is in a group.
                            </p>
                          ) : (
                            <ul className="flex flex-wrap gap-2">
                              {(roster.data?.items ?? []).map((m) => (
                                <li key={m.student_id} className="text-[13px]">
                                  {m.name}
                                  {m.role === 'tutor' && <Badge tone="success">tutor</Badge>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t px-5 py-3">
                <FormNotice error={join.error ?? leave.error} />
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
