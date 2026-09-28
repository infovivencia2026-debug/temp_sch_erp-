import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardHeader, Table, Td, Badge, Input, Field, FormGrid, Button, ErrorState } from '@/components/ui'

export interface SellerAuditRow {
  id: string
  at: string
  actor_id: string
  actor_name: string | null
  actor_roles: string | null
  acting_as: boolean
  method: string
  path: string
  route: string | null
  action: string
  institution_id: string | null
  institution_name: string | null
  target: string | null
  before_summary: string | null
  after_summary: string | null
  status: number | null
}

interface AuditPage { items: SellerAuditRow[]; total: number; limit: number; offset: number }

function tone(status: number | null) {
  if (status === null) return 'neutral' as const
  return status < 300 ? ('success' as const) : status < 500 ? ('warning' as const) : ('danger' as const)
}

/**
 * The register of what the vendor's people did, filtered. `base` is the
 * seller's /seller/audit or a school's own /admin/security/seller-audit;
 * `showSchool` hides the school column on the school's own copy.
 */
export function SellerAuditLog({ base, showSchool, title, schools }: {
  base: string
  showSchool: boolean
  title: string
  schools?: { id: string; name: string }[]
}) {
  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [school, setSchool] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const limit = 50

  const qs = new URLSearchParams()
  if (actor) qs.set('actor', actor)
  if (action) qs.set('action', action)
  if (school) qs.set('institution_id', school)
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  if (q) qs.set('q', q)
  qs.set('limit', String(limit))
  qs.set('offset', String(offset))
  const query = useQuery({
    queryKey: ['seller-audit', base, qs.toString()],
    queryFn: () => api.get<AuditPage>(`${base}?${qs}`),
  })
  const items = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const reset = (f: (v: string) => void) => (v: string) => { f(v); setOffset(0) }

  return (
    <Card>
      <CardHeader title={title} action={<span className="text-[13px] text-muted-foreground">{total} recorded</span>} />
      <div className="border-b px-5 py-4">
        <FormGrid>
          <Field label="Who"><Input value={actor} onChange={reset(setActor)} placeholder="Name" /></Field>
          <Field label="Action starts with"><Input value={action} onChange={reset(setAction)} placeholder="e.g. lifecycle, restore, seller.tenants" /></Field>
          {showSchool && schools && (
            <Field label="School">
              <select className="field" value={school} onChange={(e) => reset(setSchool)(e.target.value)}>
                <option value="">Every school</option>
                {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="From"><Input type="date" value={from} onChange={reset(setFrom)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={reset(setTo)} /></Field>
          <Field label="Search"><Input value={q} onChange={reset(setQ)} placeholder="Path, target or detail" /></Field>
        </FormGrid>
      </div>
      {query.error ? <div className="p-5"><ErrorState error={query.error} /></div> : (
        <Table
          head={['When', 'Who', 'Action', ...(showSchool ? ['School'] : []), 'Result', '']}
          empty={items.length === 0}
          loading={query.isPending && !query.data}
          emptyLabel="Nothing recorded for these filters."
        >
          {items.map((e) => (
            <Fragment key={e.id}>
              <tr>
                <Td className="num whitespace-nowrap text-muted-foreground">{e.at.slice(0, 19).replace('T', ' ')}</Td>
                <Td className="whitespace-nowrap">
                  <span className="font-medium">{e.actor_name ?? e.actor_id}</span>
                  {e.acting_as && <Badge tone="info" className="ml-1.5">inside the school</Badge>}
                </Td>
                <Td className="font-mono text-[12px]">{e.action}</Td>
                {showSchool && <Td className="whitespace-nowrap">{e.institution_name ?? '-'}</Td>}
                <Td><Badge tone={tone(e.status)}>{e.status ?? '-'}</Badge></Td>
                <Td>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    {open === e.id ? 'Hide' : 'Detail'}
                  </Button>
                </Td>
              </tr>
              {open === e.id && (
                <tr>
                  <Td colSpan={showSchool ? 6 : 5} className="bg-muted/30 text-[12px]">
                    <div className="grid gap-2">
                      <div><span className="text-muted-foreground">Request </span><span className="font-mono">{e.method} {e.path}</span></div>
                      {e.target && <div><span className="text-muted-foreground">Target </span><span className="font-mono break-all">{e.target}</span></div>}
                      {e.before_summary && <div><span className="text-muted-foreground">Before </span><span className="font-mono break-all">{e.before_summary}</span></div>}
                      {e.after_summary && <div><span className="text-muted-foreground">After </span><span className="font-mono break-all">{e.after_summary}</span></div>}
                      {e.actor_roles && <div><span className="text-muted-foreground">Roles </span>{e.actor_roles}</div>}
                    </div>
                  </Td>
                </tr>
              )}
            </Fragment>
          ))}
        </Table>
      )}
      {total > limit && (
        <div className="flex items-center justify-between border-t px-5 py-3 text-[13px] text-muted-foreground">
          <span>{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Newer</Button>
            <Button size="sm" variant="secondary" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>Older</Button>
          </div>
        </div>
      )}
    </Card>
  )
}
