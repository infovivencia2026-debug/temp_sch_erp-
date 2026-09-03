import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, ShieldQuestion, PackageCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button,
  ConfirmButton, Field, FormGrid, FormNotice, Input, Textarea,
  Loading, SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Item {
  id: string
  kind: 'lost' | 'found'
  title: string
  description?: string
  category?: string
  place?: string
  on_date: string
  reported_by: string
  reporter_class?: string
  status: string
  reported_by_me: boolean
}

interface Claim {
  id: string
  item_id: string
  item_title: string
  claimant_student_id: string
  claimant_name: string
  claimant_class?: string
  answer?: string
  status: string
  decided_by?: string
  decided_at?: string
  decision_note?: string
  claimed_on: string
  claimed_by_me: boolean
  can_decide: boolean
  claim_prompt?: string
}

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
}

/* The photo board, and the question that stands in front of the bag.

   A board where the first click wins hands a rucksack to whoever refreshes
   fastest. So a claim is not a button: the claimant has to describe something
   the photograph does not show — what is in the front pocket, what the sticker
   says — and the child who handed it in reads that and decides.

   Nothing is compared automatically, and the screen says so rather than
   implying a check happened. There is no string comparison that tells "a red
   bus sticker" from "sticker of a bus, red", and one that fails either way
   would be worse than the person who is standing there anyway. */
export default function LostFoundClaims() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const [selected, setSelected] = useState('')
  const [answer, setAnswer] = useState('')
  const [prompt, setPrompt] = useState('')
  const [photoUrl, setPhotoUrl] = useState('')
  const [note, setNote] = useState('')

  const board = useQuery({
    queryKey: ['lost-found-photo', studentId],
    queryFn: () =>
      api.get<List<Item>>(
        `/api/v1/portal/campus/lost-found${studentQuery(studentId, 'kind=found', 'status=open')}`,
      ),
    enabled: ready,
  })

  const claims = useQuery({
    queryKey: ['lost-found-claims', selected],
    queryFn: () => api.get<List<Claim>>(`/api/v1/portal/campus/lost-found/${selected}/claims`),
    enabled: !!selected,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['lost-found-claims'] })
    qc.invalidateQueries({ queryKey: ['lost-found-photo'] })
    qc.invalidateQueries({ queryKey: ['lost-found'] })
  }

  const claim = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/portal/campus/lost-found/${selected}/claims`, {
        student_id: studentId || undefined,
        answer,
      }),
    onSuccess: () => {
      setAnswer('')
      refresh()
    },
  })

  const attach = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/portal/campus/lost-found/${selected}/photo`, {
        external_url: photoUrl,
        claim_prompt: prompt || undefined,
      }),
    onSuccess: () => {
      setPhotoUrl('')
      setPrompt('')
      refresh()
    },
  })

  const decide = useMutation({
    mutationFn: (v: { id: string; decision: string }) =>
      api.post(`/api/v1/portal/campus/lost-found/claims/${v.id}/decide`, {
        decision: v.decision,
        note: note || undefined,
      }),
    onSuccess: () => {
      setNote('')
      refresh()
    },
  })

  const withdraw = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/portal/campus/lost-found/claims/${id}/withdraw`),
    onSuccess: refresh,
  })

  if (board.isLoading && ready) return <SkeletonTiles count={3} label="Reading the board…" />
  if (board.error) return <ErrorState error={board.error} />

  const items = board.data?.items ?? []
  const chosenItem = items.find((i) => i.id === selected)
  const rows = claims.data?.items ?? []
  const pending = rows.filter((c) => c.status === 'pending')
  const mine = rows.find((c) => c.claimed_by_me)

  return (
    <>
      <PageHead
        eyebrow="Campus life"
        title="Lost property claims"
        description="Things handed in, and the description you have to give before one is released to you."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="A claim is made in a child's own name." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Handed in and unclaimed" value={items.length} icon={PackageCheck} />
              <Stat
                label="Claims waiting on you"
                value={rows.filter((c) => c.can_decide).length}
                icon={ShieldQuestion}
                hint="You handed these in; you decide"
              />
              <Stat label="Your open claims" value={mine ? 1 : 0} icon={Camera} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Things handed in"
                description="Pick one to see its claims, or to claim it yourself."
              />
              {items.length === 0 ? (
                <EmptyState
                  title="Nothing waiting"
                  body="Nothing has been handed in and left unclaimed."
                />
              ) : (
                <ul className="divide-y">
                  {items.map((i) => (
                    <li
                      key={i.id}
                      className="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
                    >
                      <div className="min-w-0">
                        <p className="text-[14px] font-medium">
                          {i.title}
                          {i.category && <Badge>{i.category}</Badge>}
                          {i.reported_by_me && <Badge tone="info">you handed this in</Badge>}
                        </p>
                        {i.description && (
                          <p className="mt-1 text-[13px] text-muted-foreground">{i.description}</p>
                        )}
                        <p className="mt-1 text-[12.5px] text-muted-foreground">
                          {formatDate(i.on_date)}
                          {i.place ? ` · found ${i.place}` : ''} · handed in by{' '}
                          {i.reported_by_me ? 'you' : i.reported_by}
                          {i.reporter_class ? ` (${i.reporter_class})` : ''}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={selected === i.id ? 'primary' : 'secondary'}
                        onClick={() => setSelected(selected === i.id ? '' : i.id)}
                      >
                        {selected === i.id ? 'Chosen' : 'Open'}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {chosenItem && (
              <>
                {chosenItem.reported_by_me && (
                  <Card>
                    <CardHeader
                      title="Your notice"
                      description="Add a photograph and the question a claimant has to answer."
                    />
                    <div className="space-y-5 p-5">
                      <FormGrid>
                        <Field
                          label="Photograph"
                          hint="A link to the picture. Uploads are unavailable on this deployment."
                        >
                          <Input
                            value={photoUrl}
                            onChange={setPhotoUrl}
                            placeholder="https://…"
                          />
                        </Field>
                        <Field
                          label="The question"
                          hint="Ask about something the photograph cannot show."
                        >
                          <Input
                            value={prompt}
                            onChange={setPrompt}
                            placeholder="What is inside the front pocket?"
                          />
                        </Field>
                      </FormGrid>
                      <FormNotice
                        error={attach.error}
                        ok={attach.isSuccess ? 'Saved to the notice.' : undefined}
                      />
                      <Button
                        onClick={() => attach.mutate()}
                        disabled={!photoUrl.trim() || attach.isPending}
                      >
                        {attach.isPending ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </Card>
                )}

                {!chosenItem.reported_by_me && !mine && (
                  <Card>
                    <CardHeader
                      title="Claim it"
                      description="Describe something the photograph does not show."
                    />
                    <div className="space-y-5 p-5">
                      {rows[0]?.claim_prompt && (
                        <p className="text-[13px] text-muted-foreground">
                          They asked: {rows[0].claim_prompt}
                        </p>
                      )}
                      <Field
                        label="What proves it is yours"
                        required
                        hint="A person reads this and decides — nothing is checked automatically."
                      >
                        <Textarea
                          value={answer}
                          onChange={setAnswer}
                          rows={3}
                          placeholder="There is a maths worksheet folded into the front pocket, and my name is on the strap in blue pen."
                        />
                      </Field>
                      <FormNotice error={claim.error} />
                      <Button
                        onClick={() => claim.mutate()}
                        disabled={answer.trim().length < 10 || claim.isPending}
                      >
                        {claim.isPending ? 'Sending…' : 'Send the claim'}
                      </Button>
                    </div>
                  </Card>
                )}

                <Card>
                  <CardHeader
                    title="Claims on this"
                    description={
                      chosenItem.reported_by_me
                        ? 'You handed it in, so you decide who gets it.'
                        : 'You can see your own claim.'
                    }
                  />
                  {claims.isLoading ? (
                    <Loading label="Reading claims…" />
                  ) : rows.length === 0 ? (
                    <EmptyState title="No claims yet" body="Nobody has said this is theirs." />
                  ) : (
                    <ul className="divide-y">
                      {rows.map((c) => (
                        <li key={c.id} className="px-5 py-4">
                          <p className="text-[14px] font-medium">
                            {c.claimed_by_me ? 'Your claim' : c.claimant_name}
                            {c.claimant_class && !c.claimed_by_me && <Badge>{c.claimant_class}</Badge>}
                            <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
                          </p>
                          {c.answer && (
                            <p className="mt-1 text-[13px] text-muted-foreground">“{c.answer}”</p>
                          )}
                          <p className="mt-1 text-[12.5px] text-muted-foreground">
                            {formatDate(c.claimed_on)}
                            {c.decided_by ? ` · decided by ${c.decided_by}` : ''}
                            {c.decision_note ? ` · ${c.decision_note}` : ''}
                          </p>
                          {c.can_decide && (
                            <div className="mt-3 flex flex-wrap items-end gap-3">
                              <div className="w-72">
                                <Field label="Note" hint="Optional; kept on the record.">
                                  <Input value={note} onChange={setNote} placeholder="Handed over at the office" />
                                </Field>
                              </div>
                              <ConfirmButton
                                question="Release the item to them?"
                                confirmLabel="Release it"
                                onConfirm={() => decide.mutate({ id: c.id, decision: 'approved' })}
                              >
                                Release
                              </ConfirmButton>
                              <Button
                                size="sm"
                                variant="secondary"
                                tone="danger"
                                disabled={decide.isPending}
                                onClick={() => decide.mutate({ id: c.id, decision: 'rejected' })}
                              >
                                Not theirs
                              </Button>
                            </div>
                          )}
                          {c.claimed_by_me && c.status === 'pending' && (
                            <div className="mt-3">
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={withdraw.isPending}
                                onClick={() => withdraw.mutate(c.id)}
                              >
                                Withdraw
                              </Button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="border-t px-5 py-3">
                    <FormNotice error={decide.error ?? withdraw.error} />
                    {pending.length > 0 && chosenItem.reported_by_me && (
                      <p className="text-[12.5px] text-muted-foreground">
                        Releasing it to one person turns down everyone else waiting.
                      </p>
                    )}
                  </div>
                </Card>
              </>
            )}
          </>
        )}
      </PageBody>
    </>
  )
}
