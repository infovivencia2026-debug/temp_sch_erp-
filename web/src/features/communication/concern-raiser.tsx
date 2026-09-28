import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Field, FormNotice, Loading, ErrorState, Textarea } from '@/components/ui'
import { formatDate, formatDateTime } from '@/lib/utils'
import { AttachmentLink, RateResolution, StageBadge, Stars, Timeline, type TimelineEntry } from './concern-ui'

/* One concern, as the person who raised it sees it: where it is, what the
   school or HR has said (never their internal notes: the server does not send
   them), a box to write back, reopening inside the window, and a rating once
   it is resolved. Used by the family portal and by staff (MyConcerns). */

export interface RaiserDetail {
  id: string
  subject: string
  body?: string
  description?: string
  category: string
  stage: string
  status: string
  created_at: string
  acknowledged_at?: string
  resolve_due_at?: string
  resolved_at?: string
  resolution?: string
  satisfaction?: number
  satisfaction_note?: string
  reopened_count: number
  can_reopen: boolean
  is_anonymous?: boolean
  reference_no?: string
  attachment?: { id: string; name: string }
  timeline: (TimelineEntry & { mine?: boolean })[]
}

export function RaiserCasePanel({
  id, base, rateSuffix, listKey, reopenDays = 14,
}: {
  id: string
  base: string
  rateSuffix: 'satisfaction' | 'rate'
  listKey: readonly unknown[]
  reopenDays?: number
}) {
  const qc = useQueryClient()
  const key = [...listKey, 'case', id]
  const detail = useQuery({ queryKey: key, queryFn: () => api.get<RaiserDetail>(`${base}/${id}`), staleTime: 0 })
  const [reply, setReply] = useState('')
  const [reason, setReason] = useState('')
  const [reopening, setReopening] = useState(false)
  /* Refetch this case directly, not only by prefix: the list and the case
     share a key prefix, and the case stayed on its old stage after a reopen. */
  const refresh = async () => {
    await Promise.all([detail.refetch(), qc.invalidateQueries({ queryKey: listKey, exact: true })])
  }
  const send = useMutation({
    mutationFn: () => api.post(`${base}/${id}/reply`, { body: reply }),
    onSuccess: () => { setReply(''); refresh() },
  })
  const reopen = useMutation({
    mutationFn: () => api.post(`${base}/${id}/reopen`, { reason }),
    onSuccess: () => { setReason(''); setReopening(false); refresh() },
  })
  const rate = useMutation({
    mutationFn: (v: { rating: number; note: string }) => api.post(`${base}/${id}/${rateSuffix}`, v),
    onSuccess: refresh,
  })

  if (detail.isLoading) return <Loading shape="inline" />
  if (detail.error || !detail.data) return <ErrorState error={detail.error} />
  const d = detail.data
  const settled = d.stage === 'resolved' || d.stage === 'closed'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        <StageBadge stage={d.stage} />
        {d.reference_no && <span className="tabular-nums">{d.reference_no}</span>}
        <span>Raised {formatDateTime(d.created_at)}</span>
        {d.acknowledged_at && <span>Acknowledged {formatDate(d.acknowledged_at)}</span>}
        {!settled && d.resolve_due_at && <span>The school aims to resolve it by {formatDate(d.resolve_due_at)}</span>}
        {d.reopened_count > 0 && <span>Reopened {d.reopened_count === 1 ? 'once' : `${d.reopened_count} times`}</span>}
        {d.is_anonymous && <span>Raised anonymously: HR cannot see who you are</span>}
      </div>
      <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{d.body ?? d.description}</p>
      <AttachmentLink file={d.attachment} />

      {d.resolution && settled && (
        <div className="rounded-md bg-success/10 px-3 py-2 text-[14px]">
          <span className="font-medium">What was done: </span>{d.resolution}
        </div>
      )}

      <div>
        <h4 className="mb-2 text-[13px] font-semibold">Updates</h4>
        <Timeline items={d.timeline} raiserLabel="You wrote" />
      </div>

      {!settled && (
        <div className="space-y-2">
          <Field label="Write back">
            <Textarea rows={3} value={reply} onChange={setReply} placeholder="Add information or answer a question" />
          </Field>
          <Button size="sm" disabled={!reply.trim() || send.isPending} onClick={() => send.mutate()}>Send</Button>
          <FormNotice error={send.error} />
        </div>
      )}

      {settled && d.satisfaction == null && (
        <>
          <RateResolution pending={rate.isPending} onRate={(rating, note) => rate.mutate({ rating, note })} />
          <FormNotice error={rate.error} />
        </>
      )}
      {settled && d.satisfaction != null && (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          You rated this <Stars value={d.satisfaction} />
        </div>
      )}

      {settled && d.can_reopen && (
        reopening ? (
          <div className="space-y-2">
            <Field label="Why is it not settled?" required>
              <Textarea rows={2} value={reason} onChange={setReason} />
            </Field>
            <div className="flex gap-2">
              <Button size="sm" disabled={!reason.trim() || reopen.isPending} onClick={() => reopen.mutate()}>Reopen</Button>
              <Button size="sm" variant="ghost" onClick={() => setReopening(false)}>Cancel</Button>
            </div>
            <FormNotice error={reopen.error} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
            <Button size="sm" variant="secondary" onClick={() => setReopening(true)}>Not settled? Reopen it</Button>
            <span>You can reopen within {reopenDays} days of it being resolved.</span>
          </div>
        )
      )}
    </div>
  )
}
