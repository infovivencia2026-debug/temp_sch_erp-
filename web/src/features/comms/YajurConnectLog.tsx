import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, apiPath } from '@/lib/api'
import type { ConnectLogList, ConnectLogItem, ConnectRecipientStatus } from '@shared/api/feature_yajur_connect'
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, Input, Loading, Select, Table, Td } from '@/components/ui'
import { ExportRows, type Column } from '@/components/rows'
import { formatDateTime } from '@/lib/utils'
import { STATUS_LABEL, STATUS_TONE } from './YajurConnectSend'

/* Delivery log (worker/src/routes/comms/yajur_connect_log.ts): every
   WhatsApp message the school queued, newest first, with why it failed. The
   route also returns each message's text and its type (what sent it). */

type LogType = 'notice' | 'direct' | 'reply' | 'test' | 'alert'
type LogItem = ConnectLogItem & { body?: string | null; type?: LogType }
type LogList = Omit<ConnectLogList, 'items'> & { items: LogItem[] }

const TYPE_LABEL: Record<LogType, string> = {
  notice: 'Notice', direct: 'To one parent', reply: 'Chat reply', test: 'Test', alert: 'ERP alert',
}
const TYPES = (Object.keys(TYPE_LABEL) as LogType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))
const STATUSES = (Object.keys(STATUS_LABEL) as ConnectRecipientStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))
const typeLabel = (m: LogItem) => (m.type ? TYPE_LABEL[m.type] : '')

const EXPORT: Column<LogItem>[] = [
  { header: 'Recipient', value: (m) => m.recipient },
  { header: 'Parent', value: (m) => m.name },
  { header: 'Time', value: (m) => formatDateTime(m.queued_at) },
  { header: 'Type', value: typeLabel },
  { header: 'Via', value: (m) => m.template_code },
  { header: 'Status', value: (m) => STATUS_LABEL[m.status] },
  { header: 'Reason', value: (m) => m.error },
  { header: 'Message', value: (m) => m.body },
]

export function LogTab() {
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<LogItem | null>(null)
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(h) }, [q])
  useEffect(() => setPage(0), [type, status, from, to, term])
  const query = {
    type: type || undefined, status: status || undefined, from: from || undefined, to: to || undefined,
    q: term || undefined, page: page ? String(page) : undefined,
  }
  const log = useQuery({
    queryKey: ['connect', 'log', query],
    queryFn: () => api.get<LogList>(apiPath('GET /comms/yajur-connect/log', undefined, query)),
    placeholderData: keepPreviousData, refetchInterval: 30_000,
  })
  const d = log.data
  const pages = d ? Math.max(1, Math.ceil(d.total / d.page_size)) : 1
  const badDates = !!from && !!to && from > to

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Search"><Input value={q} onChange={setQ} placeholder="Name, number or template" /></Field>
        <Field label="Type"><Select value={type} onChange={setType} placeholder="All types" options={[{ value: '', label: 'All types' }, ...TYPES]} /></Field>
        <Field label="Status"><Select value={status} onChange={setStatus} placeholder="Any status" options={[{ value: '', label: 'Any status' }, ...STATUSES]} /></Field>
        <Field label="From"><Input type="date" value={from} onChange={setFrom} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={setTo} /></Field>
      </div>
      {badDates ? (
        <Card><EmptyState title="The From date is after the To date." body="Change one of the dates." /></Card>
      ) : log.isLoading ? <Loading /> : log.error ? <ErrorState error={log.error} /> : !d || d.items.length === 0 ? (
        <Card><EmptyState title="No messages match." body="Every WhatsApp message the school queues shows here, with its status." /></Card>
      ) : (
        <>
          <Table head={['Recipient', 'Parent', 'Time', 'Type', 'Via', 'Status', '']} unpaged noExport>
            {d.items.map((m) => (
              <tr key={m.id}>
                <Td label="Recipient" className="whitespace-nowrap tabular-nums">{m.recipient}</Td>
                <Td label="Parent" className="max-w-[200px] truncate">{m.name ?? ''}</Td>
                <Td label="Time" className="whitespace-nowrap">{formatDateTime(m.queued_at)}</Td>
                <Td label="Type" className="whitespace-nowrap">{typeLabel(m)}</Td>
                <Td label="Via" className="max-w-[200px] truncate">{m.template_code ?? ''}</Td>
                <Td label="Status">
                  <Badge tone={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
                  {m.error && <div className="mt-1 max-w-[260px] break-words text-[12px] text-muted-foreground">{m.error}</div>}
                </Td>
                <Td label="">
                  <Button size="sm" variant="secondary" disabled={!m.body} onClick={() => setOpen(m)}>Message</Button>
                </Td>
              </tr>
            ))}
          </Table>
          <div className="flex flex-wrap items-center gap-2 text-[14px]">
            <span className="flex-1 text-muted-foreground tabular-nums">{d.total} {d.total === 1 ? 'message' : 'messages'} · page {d.page + 1} of {pages}</span>
            <ExportRows rows={d.items} columns={EXPORT} name="delivery-log" label="Export this page" />
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</Button>
            <Button size="sm" variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Older</Button>
          </div>
        </>
      )}
      {open && (
        <Dialog onClose={() => setOpen(null)} title={open.name ?? open.recipient} description={`${formatDateTime(open.queued_at)} · ${STATUS_LABEL[open.status]}`}>
          <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-[14px]">{open.body}</p>
          {open.error && <p className="mt-2 break-words text-[14px] text-destructive">{open.error}</p>}
        </Dialog>
      )}
    </div>
  )
}
