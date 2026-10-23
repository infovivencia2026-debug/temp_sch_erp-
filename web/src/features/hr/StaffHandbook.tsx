import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Input, Textarea, Button, Field, Badge,
  Loading, ErrorState, FormNotice, Dialog,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'

/* The staff handbook: the school's policies, each one a circular of kind
   'policy' sent to staff that asks to be acknowledged. HR's door publishes
   and reads who has signed; each member of staff's own door reads and
   acknowledges. Nothing new on the server beyond letting staff sign. */

interface Policy {
  id: string; title: string; kind: string; audience_role: string; requires_ack: boolean; published_at: string
  published_by?: string; acknowledgements: number; acknowledged_by_me: boolean; body?: string
}
interface Delivery { title: string; delivered: number; acknowledged: number; people: { name: string; role?: string; acked_at?: string | null }[] }

export default function StaffHandbook() {
  const selfService = useLocation().pathname.includes('/my_profile/')
  const hr = useCan()('comms.announcements.write') && !selfService
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ title: '', body: '' })
  const [file, setFile] = useState<File | null>(null)
  const [reading, setReading] = useState<Policy | null>(null)
  const [who, setWho] = useState<Policy | null>(null)

  const q = useQuery({
    queryKey: ['handbook'],
    queryFn: () => api.get<{ items: Policy[] }>('/api/v1/communication/circulars'),
    select: (d) => d.items.filter((p) => p.kind === 'policy'),
  })
  const delivery = useQuery({
    queryKey: ['handbook', 'delivery', who?.id],
    queryFn: () => api.get<Delivery>(`/api/v1/communication/circulars/${who!.id}/delivery`),
    enabled: !!who,
  })
  const publish = useMutation({
    mutationFn: async () => {
      let attachment_file_id: string | undefined
      if (file) {
        const fd = new FormData(); fd.append('file', file); fd.append('purpose', 'circular')
        const res = await fetch('/api/v1/files', { method: 'POST', body: fd, credentials: 'same-origin' })
        if (!res.ok) throw new Error('The file could not be uploaded.')
        attachment_file_id = ((await res.json()) as { file_id: string }).file_id
      }
      return api.post('/api/v1/communication/circulars', { ...form, kind: 'policy', audience_role: 'staff', requires_ack: true, notify: true, attachment_file_id })
    },
    onSuccess: () => { setForm({ title: '', body: '' }); setFile(null); setAdding(false); qc.invalidateQueries({ queryKey: ['handbook'] }) },
  })
  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/communication/circulars/${id}/ack`),
    onSuccess: () => { setReading(null); qc.invalidateQueries({ queryKey: ['handbook'] }) },
  })

  const items = q.data ?? []
  const unread = items.filter((p) => !p.acknowledged_by_me).length
  return (
    <>
      <PageHead eyebrow={selfService ? 'My work' : 'People'} title={selfService ? 'My handbook' : 'Staff handbook'} />
      <PageBody>
        <div className="space-y-4">
          {hr && (
            <Card>
              <CardHeader title="Publish a policy" description="Every member of staff is asked to read and acknowledge it."
                action={<Button variant={adding ? 'secondary' : 'primary'} onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'New policy'}</Button>} />
              {adding && (
                <div className="space-y-3 px-5 pb-5">
                  <Field label="Title" required><Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="Leave and attendance policy, 2026" /></Field>
                  <Field label="The policy" required hint="The text staff read. Attach the full document below if there is one.">
                    <Textarea value={form.body} onChange={(v) => setForm({ ...form, body: v })} rows={6} placeholder="What the policy says, in plain words." />
                  </Field>
                  <Field label="Attachment" hint="PDF, up to 16 MB.">
                    <input type="file" accept="application/pdf" className="text-[13px]" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  </Field>
                  <FormNotice error={publish.error} />
                  <Button disabled={!form.title.trim() || !form.body.trim() || publish.isPending} onClick={() => publish.mutate()}>{publish.isPending ? 'Publishing…' : 'Publish to all staff'}</Button>
                </div>
              )}
            </Card>
          )}
          <Card>
            <CardHeader title={selfService ? 'Policies' : 'Policies published'} description={selfService && unread ? `${unread} to acknowledge` : undefined} />
            {q.isLoading ? <Loading /> : q.error ? <ErrorState error={q.error} /> : (
              <Table head={selfService ? ['Policy', 'Published', 'Status', ''] : ['Policy', 'Published', { label: 'Acknowledged', align: 'right' }, '']} empty={!items.length} emptyLabel="No policies published yet.">
                {items.map((p) => (
                  <tr key={p.id}>
                    <Td className="font-medium">{p.title}{p.published_by && <span className="block text-[11.5px] font-normal text-muted-foreground">by {p.published_by}</span>}</Td>
                    <Td className="text-muted-foreground">{formatDate(p.published_at)}</Td>
                    {selfService
                      ? <Td>{p.acknowledged_by_me ? <Badge tone="success">Acknowledged</Badge> : <Badge tone="warning">To read</Badge>}</Td>
                      : <Td className="text-right tabular-nums">{p.acknowledgements}</Td>}
                    <Td>
                      <span className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setReading(p)}>{selfService && !p.acknowledged_by_me ? 'Read and acknowledge' : 'Read'}</Button>
                        {hr && <Button size="sm" variant="ghost" onClick={() => setWho(p)}>Who has signed</Button>}
                      </span>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      </PageBody>
      <Dialog open={!!reading} onClose={() => setReading(null)} title={reading?.title ?? ''} size="lg"
        footer={reading && selfService && !reading.acknowledged_by_me
          ? <Button disabled={ack.isPending} onClick={() => ack.mutate(reading.id)}>{ack.isPending ? 'Saving…' : 'I have read this'}</Button>
          : undefined}>
        {reading && (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap text-[14px] leading-6">{reading.body ?? ''}</p>
            <FormNotice error={ack.error} />
          </div>
        )}
      </Dialog>
      <Dialog open={!!who} onClose={() => setWho(null)} title={who ? `Who has signed: ${who.title}` : ''} size="md">
        {delivery.isLoading ? <Loading shape="inline" /> : delivery.error ? <ErrorState error={delivery.error} /> : delivery.data && (
          <div className="space-y-2">
            <p className="text-[13.5px] text-muted-foreground">{delivery.data.acknowledged} of {delivery.data.delivered} have acknowledged.</p>
            <Table head={['Person', 'Acknowledged']} empty={!delivery.data.people.length}>
              {delivery.data.people.map((x, i) => (
                <tr key={i}>
                  <Td className="font-medium">{x.name}{x.role && <span className="block text-[11.5px] font-normal text-muted-foreground">{x.role}</span>}</Td>
                  <Td className="text-muted-foreground">{x.acked_at ? x.acked_at : 'Not yet'}</Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Dialog>
    </>
  )
}
