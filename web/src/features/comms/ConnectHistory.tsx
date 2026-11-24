import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ConnectCampaign, ConnectRecipientStatus, ConnectRepeat, ConnectSchedule } from '@shared/api/feature_yajur_connect'
import {
  Badge, Button, Card, ConfirmButton, Dialog, EmptyState, ErrorState, FormNotice, Loading, Switch, Table, Td, SEG_BAR, segClass,
} from '@/components/ui'
import { formatDateTime } from '@/lib/utils'
import { STATUS_LABEL, STATUS_TONE } from './YajurConnectSend'

/* Notice history: every notice (broadcast) sent or scheduled, with how it
   went. Reads GET /comms/yajur-connect/campaigns, campaigns/{id} and
   schedules; a schedule can be paused, resumed or deleted as on the Send screen. */

const REPEAT_LABEL: Record<ConnectRepeat, string> = { once: 'Once', daily: 'Every day', weekly: 'Every week', monthly: 'Every month' }
const n = (c: ConnectCampaign, k: ConnectRecipientStatus) => c.counts[k] ?? 0

export default function ConnectHistory() {
  const [tab, setTab] = useState<'sent' | 'scheduled'>('sent')
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="space-y-3">
      <div>
        <h1 className="sr-only">Notice history</h1>
      </div>
      <div className={SEG_BAR} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'sent'} className={segClass(tab === 'sent')} onClick={() => setTab('sent')}>Sent</button>
        <button type="button" role="tab" aria-selected={tab === 'scheduled'} className={segClass(tab === 'scheduled')} onClick={() => setTab('scheduled')}>Scheduled</button>
      </div>
      {tab === 'sent' ? <Sent onOpen={setOpen} /> : <Scheduled onOpen={setOpen} />}
      {open && <CampaignDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function Sent({ onOpen }: { onOpen: (id: string) => void }) {
  const list = useQuery({ queryKey: ['connect', 'campaigns'], queryFn: () => api.call('GET /comms/yajur-connect/campaigns'), refetchInterval: 30_000 })
  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const items = list.data?.items ?? []
  if (items.length === 0) return <Card><EmptyState title="No notices sent yet." body="A notice sent to many parents from the Send screen is kept here with each parent's status." /></Card>
  return (
    <Table head={['Title', 'Template', 'Recipients', 'Sent at', 'Delivered · Read · Failed', 'Status', '']} noExport>
      {items.map((c) => {
        const waiting = n(c, 'queued')
        return (
          <tr key={c.id}>
            <Td label="Title" className="max-w-[220px] truncate font-medium">{c.name}</Td>
            <Td label="Template" className="max-w-[200px] truncate">{c.template_name ?? c.template_code}</Td>
            <Td label="Recipients" className="tabular-nums">{c.recipient_count}</Td>
            <Td label="Sent at" className="whitespace-nowrap">{formatDateTime(c.created_at)}</Td>
            <Td label="Delivered · Read · Failed" className="whitespace-nowrap tabular-nums">
              {`${n(c, 'delivered') + n(c, 'read')} · ${n(c, 'read')} · ${n(c, 'failed') + n(c, 'blocked')}`}
            </Td>
            <Td label="Status"><Badge tone={waiting ? 'neutral' : 'success'}>{waiting ? `Sending, ${waiting} left` : 'Sent'}</Badge></Td>
            <Td label=""><Button size="sm" variant="secondary" onClick={() => onOpen(c.id)}>Open</Button></Td>
          </tr>
        )
      })}
    </Table>
  )
}

function scheduleState(s: ConnectSchedule): { label: string; tone: 'info' | 'neutral' | 'success' } {
  if (!s.next_run_at) return { label: 'Done', tone: 'success' }
  return s.active ? { label: 'Scheduled', tone: 'info' } : { label: 'Paused', tone: 'neutral' }
}

function Scheduled({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['connect', 'schedules'], queryFn: () => api.call('GET /comms/yajur-connect/schedules'), refetchInterval: 60_000 })
  const done = () => qc.invalidateQueries({ queryKey: ['connect', 'schedules'] })
  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => api.call('PUT /comms/yajur-connect/schedules/{id}', { params: { id: v.id }, body: { active: v.active } }),
    onSuccess: done,
  })
  const remove = useMutation({ mutationFn: (id: string) => api.call('DELETE /comms/yajur-connect/schedules/{id}', { params: { id } }), onSuccess: done })
  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />
  const items = list.data?.items ?? []
  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <Card><EmptyState title="Nothing scheduled." body="On the Send screen, choose Later to send a notice at a set time or on repeat." /></Card>
      ) : (
        <Table head={['Title', 'Template', 'Recipients', 'Next send', 'Repeat', 'Status', '']} noExport noRowHover>
          {items.map((s) => {
            const st = scheduleState(s)
            return (
              <tr key={s.id}>
                <Td label="Title" className="max-w-[220px] truncate font-medium">{s.name}</Td>
                <Td label="Template" className="max-w-[200px] truncate">{s.template_code}</Td>
                <Td label="Recipients" className="max-w-[220px] truncate">{s.audience_label}</Td>
                <Td label="Next send" className="whitespace-nowrap">
                  {s.next_run_at && s.active ? formatDateTime(s.next_run_at) : ''}
                  {s.last_run_at && <div className="text-[12px] text-muted-foreground">Last {formatDateTime(s.last_run_at)}</div>}
                </Td>
                <Td label="Repeat" className="whitespace-nowrap">{REPEAT_LABEL[s.repeat] ?? s.repeat}</Td>
                <Td label="Status">
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {s.last_error && <div className="mt-1 max-w-[260px] break-words text-[12px] text-destructive">{s.last_error}</div>}
                </Td>
                <Td label="">
                  <div className="flex items-center gap-2">
                    {s.next_run_at && <Switch on={s.active} onChange={(v) => toggle.mutate({ id: s.id, active: v })} label={`Run ${s.name}`} />}
                    {s.last_campaign_id && <Button size="sm" variant="secondary" onClick={() => onOpen(s.last_campaign_id!)}>Open</Button>}
                    <ConfirmButton variant="ghost" size="sm" tone="danger" question={`Delete the schedule "${s.name}"?`} confirmLabel="Delete" onConfirm={() => remove.mutate(s.id)}>
                      Delete
                    </ConfirmButton>
                  </div>
                </Td>
              </tr>
            )
          })}
        </Table>
      )}
      <FormNotice error={toggle.error ?? remove.error} />
    </div>
  )
}

function CampaignDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useQuery({ queryKey: ['connect', 'campaign', id], queryFn: () => api.call('GET /comms/yajur-connect/campaigns/{id}', { params: { id } }), refetchInterval: 15_000 })
  const c = d.data?.campaign
  return (
    <Dialog onClose={onClose} title={c?.name ?? 'Notice'} description={c ? `${formatDateTime(c.created_at)}${c.created_by_name ? ' · ' + c.created_by_name : ''}` : undefined} size="lg">
      {d.isLoading ? <Loading /> : d.error ? <ErrorState error={d.error} /> : c && (
        <div className="space-y-4 text-[14px]">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Template</dt><dd className="min-w-0 truncate">{c.template_name ?? c.template_code}</dd>
            <dt className="text-muted-foreground">Audience</dt><dd className="min-w-0">{c.audience_label}</dd>
            <dt className="text-muted-foreground">Queued</dt><dd>{c.recipient_count}{c.opted_out ? `, ${c.opted_out} opted out and left out` : ''}</dd>
            {c.header_image_url && <><dt className="text-muted-foreground">Picture</dt><dd className="min-w-0"><img src={c.header_image_url} alt="" loading="lazy" decoding="async" className="h-14 w-14 rounded border object-cover" /></dd></>}
          </dl>
          <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3">{c.rendered}</p>
          <Table head={['Parent', 'Student', 'Number', 'Status']} empty={d.data!.recipients.length === 0} emptyLabel="No messages were queued." noExport>
            {d.data!.recipients.map((r) => (
              <tr key={r.id}>
                <Td label="Parent" className="max-w-[200px] truncate">{r.parent_name ?? ''}</Td>
                <Td label="Student" className="max-w-[220px] truncate">{r.student_name ?? ''}{r.class ? `, ${r.class}` : ''}</Td>
                <Td label="Number" className="whitespace-nowrap tabular-nums">{r.recipient}</Td>
                <Td label="Status">
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  {r.error && (r.status === 'failed' || r.status === 'blocked') && <div className="mt-1 max-w-[260px] break-words text-[12px] text-muted-foreground">{r.error}</div>}
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Dialog>
  )
}
