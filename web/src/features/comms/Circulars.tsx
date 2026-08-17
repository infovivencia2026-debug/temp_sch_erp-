import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { api, type List, type Section } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Table, Td, Badge, Button, Input, Loading, ErrorState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

interface Circular {
  id: string; title: string; kind: string; audience_role: string
  requires_ack: boolean; published_at: string; acknowledgements: number; sections: number
}

/** Circulars with targeting and read receipts. SMS goes out one queued task
    per recipient so a single DLT rejection cannot lose the batch. */
export default function Circulars() {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [sectionIds, setSectionIds] = useState<Set<string>>(new Set())
  const [requiresAck, setRequiresAck] = useState(true)
  const [sendSMS, setSendSMS] = useState(false)

  // A student and a parent read circulars but cannot send one. The section
  // list behind the composer is staff-only, so asking for it as a family
  // meant a 403 on every visit and a filter that never populated — a screen
  // that works but logs an error each time it opens.
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<{ permissions: string[] }>('/api/v1/session'),
  })
  const canPublish = session.data?.permissions.includes('comms.announcements.write') ?? false

  const sections = useQuery({
    queryKey: ['sections'],
    queryFn: () => api.get<List<Section>>('/api/v1/academics/sections'),
    enabled: canPublish,
  })
  const list = useQuery({
    queryKey: ['circulars'],
    queryFn: () => api.get<List<Circular>>('/api/v1/communication/circulars'),
  })
  const publish = useMutation({
    mutationFn: () =>
      api.post<{ recipients: number; sms_queued: number }>('/api/v1/communication/circulars', {
        title, body, section_ids: [...sectionIds],
        requires_ack: requiresAck, send_sms: sendSMS,
      }),
    onSuccess: () => {
      setTitle(''); setBody(''); setSectionIds(new Set())
      qc.invalidateQueries({ queryKey: ['circulars'] })
    },
  })

  const rows = list.data?.items ?? []
  const toggle = (id: string) => {
    const n = new Set(sectionIds)
    n.has(id) ? n.delete(id) : n.add(id)
    setSectionIds(n)
  }

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="Circulars"
        description={
          canPublish
            ? 'Publish to the portal and optionally push as SMS. Target the whole school or specific sections.'
            : 'Notices the school has published, newest first.'
        }
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Circulars" value={rows.length} />
          <Stat label="Awaiting acknowledgement"
            value={rows.filter((r) => r.requires_ack && r.acknowledgements === 0).length} />
          <Stat label="Total acknowledgements" value={rows.reduce((a, r) => a + r.acknowledgements, 0)} />
        </CellGrid>

        {canPublish && (
        <Card>
          <CardHeader title="New circular" />
          <form className="space-y-3 p-5" onSubmit={(e) => { e.preventDefault(); publish.mutate() }}>
            <Input value={title} onChange={setTitle} placeholder="Title" className="w-full" />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Body"
              rows={4}
              className="field h-auto w-full py-2"
            />
            <div>
              <p className="mb-1.5 text-[13px] text-muted-foreground">
                Sections — leave empty to reach the whole school
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(sections.data?.items ?? []).map((s) => (
                  <button
                    key={s.id} type="button" onClick={() => toggle(s.id)}
                    className={`rounded-md border px-2 py-1 text-[13px] transition-colors ${
                      sectionIds.has(s.id) ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                    }`}
                  >
                    {s.class_name}-{s.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-[14px]">
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} />
                Require acknowledgement
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={sendSMS} onChange={(e) => setSendSMS(e.target.checked)} />
                Also send SMS
              </label>
            </div>
            {publish.isError && (
              <p className="text-[13px] text-destructive">
                {publish.error instanceof Error ? publish.error.message : 'Publish failed'}
              </p>
            )}
            {publish.isSuccess && (
              <p className="text-[13px] text-success">
                Published to {publish.data.recipients} guardians
                {publish.data.sms_queued > 0 && `, ${publish.data.sms_queued} SMS queued`}.
              </p>
            )}
            <Button type="submit" disabled={!title.trim() || !body.trim() || publish.isPending}>
              <Send className="h-4 w-4" />
              {publish.isPending ? 'Publishing…' : 'Publish circular'}
            </Button>
          </form>
        </Card>
        )}

        <Card>
          <CardHeader title="Published" description="Most recent first" />
          {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} /> : (
            <Table head={['Title', 'Kind', 'Audience', 'Sections', 'Acknowledged', 'Published']}
              empty={!rows.length} emptyLabel="Nothing published yet.">
              {rows.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">{c.title}</Td>
                  <Td><Badge>{c.kind}</Badge></Td>
                  <Td>{c.audience_role}</Td>
                  <Td>{c.sections || 'all'}</Td>
                  <Td>
                    {c.requires_ack
                      ? <Badge tone={c.acknowledgements ? 'success' : 'warning'}>{c.acknowledgements}</Badge>
                      : '—'}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(c.published_at)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
