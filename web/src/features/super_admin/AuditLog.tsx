import { useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, History, ScrollText } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat,
  Badge, Select, Loading, ErrorState, EmptyState, Input, Button,
} from '@/components/ui'
import { SearchBox } from '@/components/rows'
import { cn } from '@/lib/utils'
import { useOpenState } from '@/lib/motion'

/* Who changed what.

   The audit_log table shipped in the first migration and nothing ever wrote
   to it, so the question an auditor opens with — who cancelled that receipt,
   who edited that mark, who approved that concession — had no answer. The
   middleware now records every successful mutation; this is the screen that
   makes the record usable rather than merely present.

   Reads are deliberately absent. Recording them would multiply the table by
   two orders of magnitude and bury the twelve rows that matter. */

interface Row {
  id: number
  at: string
  actor?: string
  action: string
  entity_type: string
  ip?: string
  request?: unknown
  response?: unknown
}
interface Bucket {
  entity_type: string
  count: number
  last_at: string
}

// Verb, drawn from the HTTP method rather than shown as one: an auditor reads
// "deleted", not "DELETE /api/v1/...".
const VERBS: Record<string, { label: string; tone: 'neutral' | 'success' | 'danger' | 'warning' }> = {
  POST: { label: 'created', tone: 'success' },
  PUT: { label: 'replaced', tone: 'warning' },
  PATCH: { label: 'edited', tone: 'warning' },
  DELETE: { label: 'deleted', tone: 'danger' },
}

interface Paged<T> { items: T[]; next_before?: number }

interface EventRow {
  id: number
  at: string
  level: string
  message: string
  source: string
  request_id?: string
  actor?: string
  attrs?: Record<string, unknown>
}

export default function AuditLog() {
  const [entity, setEntity] = useState('')
  const [q, setQ] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [open, setOpen] = useOpenState<number | null>(null)

  const params = new URLSearchParams()
  if (entity) params.set('entity', entity)
  if (q.trim()) params.set('q', q.trim())
  if (since) params.set('since', since)
  if (until) params.set('until', until)

  /* A PAGE WITH A NEXT, NOT THE NEWEST HUNDRED.

     This fetched one hundred rows and drew them under a header claiming
     "every change in the last 90 days" and a tile counting four hundred
     thousand. There was no date parameter, so the second week of June was
     unreachable past today's hundredth row. Pages now walk backwards by id
     (next_before from the server), and a date range asks the question an
     auditor actually has. */
  const audit = useInfiniteQuery({
    queryKey: ['audit', params.toString()],
    queryFn: ({ pageParam }) =>
      api.get<Paged<Row>>(`/api/v1/admin/audit?${params}${pageParam ? `&before_id=${pageParam}` : ''}`),
    initialPageParam: 0 as number,
    getNextPageParam: (last) => last.next_before ?? undefined,
  })
  const { data: summary } = useQuery({
    queryKey: ['audit-summary'],
    queryFn: () => api.get<List<Bucket>>('/api/v1/admin/audit/summary'),
  })

  const rows = audit.data?.pages.flatMap((p) => p.items) ?? []
  const isLoading = audit.isLoading
  const error = audit.error
  const buckets = summary?.items ?? []
  const total = buckets.reduce((n, b) => n + b.count, 0)

  return (
    <>
      <PageHead
        eyebrow="Access & Security"
        title="Audit trail"
        description="Every change made through the system, who made it, when, and what they sent -- and what the system itself warned or failed at while serving this school. Passwords and tokens are never recorded. Nothing here is ever purged."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Changes, 90 days" value={total} icon={History} />
          <Stat label="Areas touched" value={buckets.length} icon={ScrollText} />
          <Stat
            label="Busiest area"
            value={buckets[0]?.entity_type ?? '-'}
            hint={buckets[0] ? `${buckets[0].count} changes` : undefined}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Changes"
            description={`${rows.length} shown, newest first${audit.hasNextPage ? ' — more below' : ''}`}
            action={
              <>
                <Input type="date" value={since} onChange={setSince} srLabel="From date" />
                <Input type="date" value={until} onChange={setUntil} srLabel="To date" />
                <SearchBox value={q} onChange={setQ} placeholder="Search the action" />
                <Select
                  value={entity}
                  onChange={setEntity}
                  placeholder="Everything"
                  options={buckets.map((b) => ({
                    value: b.entity_type,
                    label: `${b.entity_type} (${b.count})`,
                  }))}
                />
              </>
            }
          />
          {isLoading ? (
            <Loading />
          ) : error ? (
            <ErrorState error={error} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="Nothing recorded"
              body="Changes appear here as soon as someone saves something. Reads are not logged."
            />
          ) : (
            <ul className="divide-y">
              {rows.map((r) => {
                const [method, path] = r.action.split(' ')
                const verb = VERBS[method] ?? { label: method.toLowerCase(), tone: 'neutral' as const }
                const expanded = open === r.id
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : r.id)}
                      className="flex w-full items-start gap-3 px-5 py-3 text-left transition-colors duration-150 hover:bg-accent/60"
                    >
                      {expanded ? (
                        <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px]">
                          <span className="font-medium">{r.actor ?? 'Someone'}</span>{' '}
                          <span className="text-muted-foreground">{verb.label}</span>{' '}
                          <Badge tone={verb.tone}>{r.entity_type}</Badge>
                        </p>
                        <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">
                          {path}
                        </p>
                      </div>
                      <span className="shrink-0 text-right text-[13px] text-muted-foreground">
                        {when(r.at)}
                        {r.ip && <span className="block font-mono text-[12px]">{r.ip}</span>}
                      </span>
                    </button>
                    {expanded && (
                      <div className="grid gap-3 border-t bg-muted/30 px-5 py-4 sm:grid-cols-2">
                        <Payload label="What was sent" value={r.request} />
                        <Payload label="What came back" value={r.response} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {audit.hasNextPage && (
            <div className="border-t px-5 py-3">
              <Button size="sm" variant="secondary" disabled={audit.isFetchingNextPage} onClick={() => audit.fetchNextPage()}>
                {audit.isFetchingNextPage ? 'Loading…' : 'Show older changes'}
              </Button>
            </div>
          )}
        </Card>

        <SystemEvents since={since} until={until} />
      </PageBody>
    </>
  )
}

/* WHAT THE SYSTEM SAID ABOUT ITSELF, FOR THIS SCHOOL.

   The audit trail records what a person changed. It never recorded what the
   process warned or failed at while it worked -- the message that could not
   be queued, the allocation that rolled back -- because those went to stdout,
   which knows nothing of tenants and is forgotten in thirty days. app_events
   keeps every WARN and ERROR per school, stamped with the request and the
   user it was serving, and never purges it. This is where "what happened
   here that afternoon" is answered two months later. */
const LEVEL_TONE: Record<string, 'warning' | 'danger' | 'neutral'> = { WARN: 'warning', ERROR: 'danger' }

function SystemEvents({ since, until }: { since: string; until: string }) {
  const [level, setLevel] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useOpenState<number | null>(null)
  const params = new URLSearchParams()
  if (level) params.set('level', level)
  if (q.trim()) params.set('q', q.trim())
  if (since) params.set('since', since)
  if (until) params.set('until', until)

  const events = useInfiniteQuery({
    queryKey: ['audit-events', params.toString()],
    queryFn: ({ pageParam }) =>
      api.get<Paged<EventRow>>(`/api/v1/admin/audit/events?${params}${pageParam ? `&before_id=${pageParam}` : ''}`),
    initialPageParam: 0 as number,
    getNextPageParam: (last) => last.next_before ?? undefined,
  })
  const rows = events.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <Card>
      <CardHeader
        title="System events"
        description="Warnings and errors raised while serving this school. Kept for good."
        action={
          <>
            <SearchBox value={q} onChange={setQ} placeholder="Search the message" />
            <Select
              value={level}
              onChange={setLevel}
              placeholder="Any level"
              options={[{ value: 'WARN', label: 'Warnings' }, { value: 'ERROR', label: 'Errors' }]}
            />
          </>
        }
      />
      {events.isLoading ? (
        <Loading />
      ) : events.error ? (
        <ErrorState error={events.error} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing raised" body="The system has not warned or failed while serving this school in this range." />
      ) : (
        <ul className="divide-y">
          {rows.map((e) => {
            const expanded = open === e.id
            return (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : e.id)}
                  className="flex w-full items-start gap-3 px-5 py-3 text-left transition-colors duration-150 hover:bg-accent/60"
                >
                  <Badge tone={LEVEL_TONE[e.level] ?? 'neutral'}>{e.level}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px]">{e.message}</p>
                    <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">
                      {e.source}{e.actor ? ` · ${e.actor}` : ''}{e.request_id ? ` · ${e.request_id}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-right text-[13px] text-muted-foreground">{when(e.at)}</span>
                </button>
                {expanded && (
                  <div className="border-t bg-muted/30 px-5 py-4">
                    <Payload label="Details" value={e.attrs} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {events.hasNextPage && (
        <div className="border-t px-5 py-3">
          <Button size="sm" variant="secondary" disabled={events.isFetchingNextPage} onClick={() => events.fetchNextPage()}>
            {events.isFetchingNextPage ? 'Loading…' : 'Show older events'}
          </Button>
        </div>
      )}
    </Card>
  )
}

function Payload({ label, value }: { label: string; value: unknown }) {
  const empty = value == null || (typeof value === 'object' && Object.keys(value).length === 0)
  return (
    <div className="min-w-0">
      <p className="eyebrow mb-1.5">{label}</p>
      <pre
        className={cn(
          'overflow-x-auto rounded-md border bg-card p-3 font-mono text-[12px] leading-relaxed',
          empty && 'text-muted-foreground',
        )}
      >
        {empty ? 'nothing' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function when(iso: string) {
  const d = new Date(iso)
  const mins = (Date.now() - d.getTime()) / 60000
  if (mins < 1) return 'just now'
  if (mins < 60) return `${Math.round(mins)}m ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(d)
}
