import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ConnectRecipientStatus } from '@shared/api/feature_yajur_connect'
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, Select } from '@/components/ui'
import { formatDateTime } from '@/lib/utils'
import { STATUS_LABEL, STATUS_TONE } from './YajurConnectSend'

/* Yajur Connect Log (worker/src/routes/comms/yajur_connect_log.ts): every
   WhatsApp message the school queued, newest first, with why it failed. */

const STATUSES = (Object.keys(STATUS_LABEL) as ConnectRecipientStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))

export function LogTab() {
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState(0)
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(h) }, [q])
  useEffect(() => setPage(0), [status, from, to, term])
  const query = {
    status: (status || undefined) as ConnectRecipientStatus | undefined, from: from || undefined, to: to || undefined,
    q: term || undefined, page: page ? String(page) : undefined,
  }
  const log = useQuery({
    queryKey: ['connect', 'log', query], queryFn: () => api.call('GET /comms/yajur-connect/log', { query }),
    placeholderData: keepPreviousData, refetchInterval: 30_000,
  })
  const d = log.data
  const pages = d ? Math.max(1, Math.ceil(d.total / d.page_size)) : 1

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Search"><Input value={q} onChange={setQ} placeholder="Name, number or template" /></Field>
        <Field label="Status"><Select value={status} onChange={setStatus} placeholder="Any status" options={[{ value: '', label: 'Any status' }, ...STATUSES]} /></Field>
        <Field label="From"><Input type="date" value={from} onChange={setFrom} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={setTo} /></Field>
      </div>
      {log.isLoading ? <Loading /> : log.error ? <ErrorState error={log.error} /> : !d || d.items.length === 0 ? (
        <Card><EmptyState title="No messages match." body="Every WhatsApp message the school queues shows here, with its status." /></Card>
      ) : (
        <>
          <ul className="space-y-2">
            {d.items.map((m) => (
              <li key={m.id} className="card flex flex-col gap-1 px-3 py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[16px] font-semibold sm:text-[15px]">{m.name ?? m.recipient}</span>
                  <Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                </div>
                <div className="flex flex-wrap gap-x-3 text-[14px] text-muted-foreground">
                  {m.name && <span className="tabular-nums">{m.recipient}</span>}
                  <span className="min-w-0 truncate">{m.template_code ?? 'No template'}</span>
                  <span>{formatDateTime(m.queued_at)}</span>
                </div>
                {m.error && <p className="break-words text-[14px] text-destructive">{m.error}</p>}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 text-[14px]">
            <span className="flex-1 text-muted-foreground tabular-nums">{d.total} {d.total === 1 ? 'message' : 'messages'} · page {d.page + 1} of {pages}</span>
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</Button>
            <Button size="sm" variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Older</Button>
          </div>
        </>
      )}
    </div>
  )
}
