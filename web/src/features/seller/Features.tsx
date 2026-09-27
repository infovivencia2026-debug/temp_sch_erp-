import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  Card, CardHeader, Table, Td, Badge, Button, Field, FormGrid, FormNotice, Input, Select, SkeletonTable, ErrorState,
} from '@/components/ui'

/* Feature switches per school (seller/features.ts). The plan's modules give a
   default for every catalogue feature; an override turns one feature on or off
   for one school, optionally until a date (a trial). "Enforced" features also
   have their API refused when off; the rest are hidden from the menus. */

interface SchoolFeature {
  id: string; name: string; section: string; plan_default: boolean; effective: boolean; enforced: boolean
  override: { enabled: boolean; ends_at: string | null; note: string; lapsed: boolean } | null
}
interface SchoolFeatures { plan_name: string; plan_code: string; modules: { module: string; in_plan: boolean; features: SchoolFeature[] }[] }
interface Catalog { modules: { module: string; features: { id: string; name: string; section: string; enforced: boolean }[] }[] }
interface Rollout { applied: boolean; schools: { id: string; name: string }[]; total_schools: number }

export function Features({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const tenants = useQuery({ queryKey: ['seller-tenants-lite'], queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/seller/tenants') })
  const catalog = useQuery({ queryKey: ['seller-features'], queryFn: () => api.get<Catalog>('/api/v1/seller/features') })
  const groups = useQuery({ queryKey: ['seller-school-groups'], queryFn: () => api.get<List<{ id: string; name: string }>>('/api/v1/seller/school-groups') })
  const [school, setSchool] = useState('')
  const [filter, setFilter] = useState('')
  const [until, setUntil] = useState('')
  const key = ['seller-features', school]
  const sf = useQuery({ queryKey: key, enabled: !!school, queryFn: () => api.get<SchoolFeatures>(`/api/v1/seller/features/schools/${school}`) })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['seller-features'] }) }
  const set = useMutation({
    mutationFn: (b: { feature: string; enabled: boolean }) =>
      api.put(`/api/v1/seller/features/schools/${school}`, { ...b, ends_at: until || null }),
    onSuccess: refresh,
  })
  const clear = useMutation({
    mutationFn: (feature: string) => api.del(`/api/v1/seller/features/schools/${school}?feature=${encodeURIComponent(feature)}`),
    onSuccess: refresh,
  })

  const [ro, setRo] = useState({ feature: '', enabled: 'on', how: 'percent', percent: '10', group: '', schools: '' as string, ends_at: '' })
  const [roResult, setRoResult] = useState<Rollout | null>(null)
  const rollout = useMutation({
    mutationFn: (dry: boolean) => api.post<Rollout>('/api/v1/seller/features/rollout', {
      feature: ro.feature, enabled: ro.enabled === 'on', ends_at: ro.ends_at || null, dry_run: dry,
      ...(ro.how === 'percent' ? { percent: Number(ro.percent) } : ro.how === 'group' ? { group_id: ro.group } : { institution_ids: ro.schools.split(',').filter(Boolean) }),
    }),
    onSuccess: (r) => { setRoResult(r); if (r.applied) refresh() },
  })

  const featureOptions = (catalog.data?.modules ?? []).flatMap((m) => m.features.map((f) => ({ value: f.id, label: `${m.module} · ${f.section} · ${f.name}` })))
  const f = filter.toLowerCase()

  return (
    <Card>
      <CardHeader title="Feature switches" description="Per school, on top of the plan" action={<Button variant="secondary" onClick={onClose}>Close</Button>} />
      <div className="space-y-4 px-5 py-4">
        <FormGrid>
          <Field label="School">
            <Select value={school} onChange={setSchool} placeholder="Choose a school"
              options={(tenants.data?.items ?? []).map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
          <Field label="Search features">
            <Input value={filter} onChange={setFilter} placeholder="library, hostel…" />
          </Field>
          <Field label="Override until" hint="Optional: a trial or a temporary switch-off. Blank = until changed.">
            <Input type="date" value={until} onChange={setUntil} />
          </Field>
        </FormGrid>
        {(set.isError || clear.isError) && <FormNotice error={set.error ?? clear.error} />}
      </div>
      {school && (sf.isLoading ? <SkeletonTable columns={5} /> : sf.error ? <ErrorState error={sf.error} /> : sf.data && (
        <div className="space-y-4 px-5 pb-5">
          <div className="text-[13px] text-muted-foreground">Plan: {sf.data.plan_name || sf.data.plan_code || 'none'}</div>
          {sf.data.modules.map((m) => {
            const rows = m.features.filter((x) => !f || x.name.toLowerCase().includes(f) || x.section.toLowerCase().includes(f) || m.module.includes(f))
            if (rows.length === 0) return null
            return (
              <div key={m.module}>
                <h4 className="mb-2 text-[14px] font-semibold">{m.module} {m.in_plan ? <Badge tone="success">in plan</Badge> : <Badge>not in plan</Badge>}</h4>
                <Table head={['Feature', 'Plan default', 'Override', 'Now', '']}>
                  {rows.map((x) => (
                    <tr key={x.id}>
                      <Td>{x.name}<div className="text-[12px] text-muted-foreground">{x.section}{x.enforced ? ' · API enforced' : ''}</div></Td>
                      <Td>{x.plan_default ? 'On' : 'Off'}</Td>
                      <Td>{x.override ? (
                        <>
                          <Badge tone={x.override.lapsed ? 'neutral' : x.override.enabled ? 'success' : 'danger'}>
                            {x.override.lapsed ? 'lapsed' : x.override.enabled ? 'forced on' : 'forced off'}
                          </Badge>
                          {x.override.ends_at && <span className="ml-1 text-[12px] text-muted-foreground">until {x.override.ends_at.slice(0, 10)}</span>}
                        </>
                      ) : '—'}</Td>
                      <Td><Badge tone={x.effective ? 'success' : 'neutral'}>{x.effective ? 'On' : 'Off'}</Badge></Td>
                      <Td>
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" disabled={set.isPending} onClick={() => set.mutate({ feature: x.id, enabled: !x.effective })}>
                            {x.effective ? 'Switch off' : 'Switch on'}
                          </Button>
                          {x.override && <Button size="sm" variant="ghost" onClick={() => clear.mutate(x.id)}>Plan default</Button>}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </Table>
              </div>
            )
          })}
        </div>
      ))}
      <div className="space-y-4 border-t px-5 py-5">
        <h4 className="text-[14px] font-semibold">Rollout</h4>
        {rollout.isError && <FormNotice error={rollout.error} />}
        <FormGrid>
          <Field label="Feature" required>
            <Select value={ro.feature} onChange={(v) => setRo({ ...ro, feature: v })} options={featureOptions} placeholder="Choose a feature" />
          </Field>
          <Field label="Set to">
            <Select value={ro.enabled} onChange={(v) => setRo({ ...ro, enabled: v })} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
          </Field>
          <Field label="Schools">
            <Select value={ro.how} onChange={(v) => setRo({ ...ro, how: v })}
              options={[{ value: 'percent', label: 'A percentage of all schools' }, { value: 'group', label: 'A school group' }, { value: 'schools', label: 'Chosen schools' }]} />
          </Field>
          {ro.how === 'percent' && (
            <Field label="Percent" hint="Stable per school: raising it only adds schools.">
              <Input type="number" value={ro.percent} onChange={(v) => setRo({ ...ro, percent: v })} />
            </Field>
          )}
          {ro.how === 'group' && (
            <Field label="Group">
              <Select value={ro.group} onChange={(v) => setRo({ ...ro, group: v })} options={(groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }))} />
            </Field>
          )}
          {ro.how === 'schools' && (
            <Field label="Schools" wide>
              <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-y-auto text-[13px]">
                {(tenants.data?.items ?? []).map((t) => {
                  const list = ro.schools.split(',').filter(Boolean)
                  const on = list.includes(t.id)
                  return (
                    <label key={t.id} className="flex items-center gap-1">
                      <input type="checkbox" checked={on}
                        onChange={() => setRo({ ...ro, schools: (on ? list.filter((x) => x !== t.id) : [...list, t.id]).join(',') })} />
                      {t.name}
                    </label>
                  )
                })}
              </div>
            </Field>
          )}
          <Field label="Until" hint="Optional end date.">
            <Input type="date" value={ro.ends_at} onChange={(v) => setRo({ ...ro, ends_at: v })} />
          </Field>
        </FormGrid>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={!ro.feature || rollout.isPending} onClick={() => rollout.mutate(true)}>Preview</Button>
          <Button disabled={!ro.feature || rollout.isPending} onClick={() => rollout.mutate(false)}>Apply</Button>
        </div>
        {roResult && (
          <div className="text-[13px]">
            {roResult.applied ? 'Applied to' : 'Would apply to'} {roResult.schools.length} of {roResult.total_schools} schools
            {roResult.schools.length > 0 && ': ' + roResult.schools.map((s) => s.name).join(', ')}
          </div>
        )}
      </div>
    </Card>
  )
}
