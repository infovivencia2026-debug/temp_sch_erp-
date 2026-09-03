import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, Award, Share2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea, Checkbox,
  SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface PortfolioItem {
  id: string
  kind: string
  title: string
  description?: string
  subject?: string
  happened_on?: string
  evidence_url?: string
  file_id?: string
  is_shared: boolean
  added_on: string
}
interface Award_ {
  id: string
  kind: string
  title: string
  level?: string
  position?: string
  awarded_on?: string
  description?: string
}
interface PortfolioResponse {
  student_id: string
  items: PortfolioItem[]
  school_awards: Award_[]
}

const KINDS = [
  { value: 'project', label: 'Project' },
  { value: 'essay', label: 'Essay or writing' },
  { value: 'artwork', label: 'Artwork' },
  { value: 'performance', label: 'Performance' },
  { value: 'certificate', label: 'Certificate' },
  { value: 'competition', label: 'Competition' },
  { value: 'internship', label: 'Internship' },
  { value: 'volunteering', label: 'Volunteering' },
  { value: 'other', label: 'Something else' },
]

/* The child's own evidence of themselves.

   Two lists, deliberately never merged. What the school awarded is on the
   school's word; what the child entered is on theirs, and a university reading
   this is entitled to know which is which. Merging them would quietly promote
   a self-declared hackathon to the same standing as a prize.

   Sharing is off by default. A half-finished poem is not a submission, and a
   portfolio that published drafts would teach children to keep them elsewhere. */
export default function Portfolio() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [kind, setKind] = useState('project')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [happenedOn, setHappenedOn] = useState('')
  const [url, setUrl] = useState('')
  const [shared, setShared] = useState(false)

  const portfolio = useQuery({
    queryKey: ['portfolio', studentId],
    queryFn: () =>
      api.get<PortfolioResponse>(`/api/v1/portal/learning/portfolio${studentQuery(studentId)}`),
    enabled: ready,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['portfolio'] })

  const add = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/learning/portfolio', {
        student_id: studentId || undefined,
        kind,
        title,
        description: description || undefined,
        happened_on: happenedOn || undefined,
        evidence_url: url || undefined,
        is_shared: shared,
      }),
    onSuccess: () => {
      setTitle(''); setDescription(''); setHappenedOn(''); setUrl(''); setShared(false)
      refresh()
    },
  })

  const toggleShare = useMutation({
    mutationFn: (item: PortfolioItem) =>
      api.post(`/api/v1/portal/learning/portfolio/${item.id}`, {
        student_id: studentId || undefined,
        is_shared: !item.is_shared,
      }),
    onSuccess: refresh,
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api.del(`/api/v1/portal/learning/portfolio/${id}${studentQuery(studentId)}`),
    onSuccess: refresh,
  })

  if (portfolio.isLoading && ready) return <SkeletonTiles count={3} label="Opening your portfolio…" />
  if (portfolio.error) return <ErrorState error={portfolio.error} />

  const items = portfolio.data?.items ?? []
  const awards = portfolio.data?.school_awards ?? []
  const shownToSchool = items.filter((i) => i.is_shared).length

  return (
    <>
      <PageHead
        eyebrow="Learning"
        title="Portfolio"
        description="What you have made and done, alongside what the school has recorded for you."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="A portfolio belongs to one child." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Your entries" value={items.length} icon={Briefcase} />
              <Stat label="Shared with school" value={shownToSchool} icon={Share2}
                hint="The rest stay private to you" />
              <Stat label="School awards" value={awards.length} icon={Award}
                hint="Recorded by the school" />
            </CellGrid>

            <Card>
              <CardHeader
                title="Add something"
                description="A project, a certificate, a competition — anything you would want to point at later."
              />
              <div className="space-y-5 p-5">
                <FormGrid>
                  <Field label="What is it" required>
                    <Input value={title} onChange={setTitle} placeholder="Balsa bridge model" />
                  </Field>
                  <Field label="Kind">
                    <Select value={kind} onChange={setKind} options={KINDS} />
                  </Field>
                  <Field label="When" hint="Leave blank if it was not one day.">
                    <Input value={happenedOn} onChange={setHappenedOn} type="date" />
                  </Field>
                  <Field label="Link to evidence" hint="A repository, a video, a photo album.">
                    <Input value={url} onChange={setUrl} placeholder="https://…" />
                  </Field>
                  <Field label="What you did" wide>
                    <Textarea value={description} onChange={setDescription} rows={3}
                      placeholder="Designed and tested a truss that held 6 kg before failing at the joint." />
                  </Field>
                </FormGrid>
                <Checkbox
                  checked={shared}
                  onChange={setShared}
                  label="Share this with the school"
                  hint="Off by default. A draft is not a submission."
                />
                <FormNotice error={add.error} ok={add.isSuccess ? 'Added to your portfolio.' : undefined} />
                <Button onClick={() => add.mutate()} disabled={!title.trim() || add.isPending}>
                  {add.isPending ? 'Adding…' : 'Add to portfolio'}
                </Button>
              </div>
            </Card>

            <Card>
              <CardHeader title="Your entries" description="Newest first, by when it happened." />
              {items.length === 0 ? (
                <EmptyState
                  title="Nothing here yet"
                  body="Add the first thing you have made. It is yours until you choose to share it."
                />
              ) : (
                <ul className="divide-y">
                  {items.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium">
                          {i.evidence_url ? (
                            <a href={i.evidence_url} target="_blank" rel="noreferrer noopener"
                              className="underline underline-offset-2 hover:text-primary">
                              {i.title}
                            </a>
                          ) : (
                            i.title
                          )}
                          <Badge tone="info">{i.kind}</Badge>
                          {i.is_shared ? (
                            <Badge tone="success">Shared</Badge>
                          ) : (
                            <Badge>Private</Badge>
                          )}
                        </p>
                        {i.description && (
                          <p className="mt-1 text-[13px] text-muted-foreground">{i.description}</p>
                        )}
                        <p className="mt-1 text-[12.5px] text-muted-foreground">
                          {i.happened_on ? formatDate(i.happened_on) : `Added ${formatDate(i.added_on)}`}
                          {i.subject ? ` · ${i.subject}` : ''}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" variant="secondary" disabled={toggleShare.isPending}
                          onClick={() => toggleShare.mutate(i)}>
                          {i.is_shared ? 'Make private' : 'Share'}
                        </Button>
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          tone="danger"
                          question="This entry goes for good."
                          confirmLabel="Delete it"
                          onConfirm={() => remove.mutate(i.id)}
                        >
                          Delete
                        </ConfirmButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t px-5 py-3">
                <FormNotice error={toggleShare.error ?? remove.error} />
              </div>
            </Card>

            <Card>
              <CardHeader
                title="What the school has recorded"
                description="Awards and achievements entered by the school. You cannot edit these, which is what makes them worth something."
              />
              {awards.length === 0 ? (
                <EmptyState
                  title="No school awards yet"
                  body="Prizes and achievements the school records for you will appear here."
                />
              ) : (
                <ul className="divide-y">
                  {awards.map((a) => (
                    <li key={a.id} className="px-5 py-4">
                      <p className="text-[14px] font-medium">
                        {a.title}
                        <Badge tone="success">{a.kind}</Badge>
                        {a.level && <Badge>{a.level}</Badge>}
                      </p>
                      {a.description && (
                        <p className="mt-1 text-[13px] text-muted-foreground">{a.description}</p>
                      )}
                      <p className="mt-1 text-[12.5px] text-muted-foreground">
                        {a.awarded_on ? formatDate(a.awarded_on) : 'Date not recorded'}
                        {a.position ? ` · ${a.position}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
