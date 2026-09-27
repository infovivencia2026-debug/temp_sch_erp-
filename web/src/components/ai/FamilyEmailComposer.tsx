import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui'
import WriteWithAI from './WriteWithAI'

/* An e-mail to an applicant's family about the admission decision, sent
   through the school's own POST /admissions/message (the usual wording
   'admissions.office_message', the usual channels and guard). The AI only
   drafts into the box; the person reads, edits and presses Send. */
export default function FamilyEmailComposer({ applicationId, status }: { applicationId: string; status: string }) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const send = useMutation({
    mutationFn: () => api.post<{ sent?: number; not_sent?: { reason: string }[] }>('/api/v1/admissions/message', { ids: [applicationId], message: text.trim() }),
    onSuccess: () => setText(''),
  })
  if (!open) return <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Write to the family</Button>
  const failed = send.data?.not_sent?.[0]?.reason
  return (
    <div className="space-y-2">
      <textarea className="field h-auto w-full py-2" rows={5} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="What the family should be told about the decision" />
      <div className="flex flex-wrap items-center gap-2">
        <WriteWithAI kind="admission_decision" context={{ application_id: applicationId, decision: status }} current={text} onInsert={setText} defaultTone="formal" />
        <Button size="sm" disabled={!text.trim()} pending={send.isPending} onClick={() => send.mutate()}>Send</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
      </div>
      {send.isSuccess && !failed && <p className="text-[13px] text-success">Queued to the family.</p>}
      {failed && <p className="text-[13px] text-destructive">Not sent: {failed}</p>}
      {send.isError && <p className="text-[13px] text-destructive">{(send.error as Error).message}</p>}
    </div>
  )
}
