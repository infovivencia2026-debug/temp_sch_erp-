import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import {
  Card, CardHeader, Table, Td, Badge, Button, Checkbox, Dialog, EmptyState, ErrorState, Field, FormGrid, FormNotice, Input,
  Select, SkeletonTable, Textarea, TAB_BAR, tabClass,
} from '@/components/ui'
import {
  SETTING_GROUPS, type ApplyResult, type ConfigTemplate, type RolePushResult, type RoleTemplate, type SchoolSettings,
  type SettingDecl, type SettingRow, type SettingSource, type SettingValue,
} from '@shared/api/settings'

/* SELLER CONTROLS (routes/seller/controls.ts): every school-level setting,
   the defaults new schools start with, role templates and configuration
   templates. Configuration only; no school records are shown or reachable. */

type Registry = { settings: (SettingDecl & { vendor_editable: boolean })[]; plans: { code: string; name: string }[]; defaults: { scope: string; key: string; value: SettingValue }[]; can_edit: boolean }
type School = { id: string; name: string }

const BASE = '/api/v1/seller/controls'
const SOURCE: Record<SettingSource, { label: string; tone: 'primary' | 'neutral' | 'info' }> = {
  school: { label: 'School', tone: 'primary' }, plan: { label: 'Plan', tone: 'info' }, platform: { label: 'Platform', tone: 'info' }, 'built-in': { label: 'Built-in', tone: 'neutral' },
}
export const showValue = (v: SettingValue) => (v === null ? 'None' : v === true ? 'On' : v === false ? 'Off' : String(v))
const BOOL = [{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }]

function toInput(v: SettingValue): string { return v === null ? '' : String(v) }
function fromInput(d: SettingDecl, s: string): SettingValue {
  if (d.type === 'bool') return s === 'true'
  if (d.type === 'number') return s.trim() === '' ? NaN : Number(s)
  return s.trim() === '' && d.nullable ? null : s
}

/** One value editor for any setting type. */
function ValueEditor({ d, value, onChange, disabled }: { d: SettingDecl; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  if (d.type === 'bool') return <Select value={value} onChange={onChange} options={BOOL} />
  if (d.type === 'enum') return <Select value={value} onChange={onChange} options={d.options ?? []} />
  return <Input value={value} onChange={onChange} type={d.type === 'number' ? 'number' : 'text'} min={d.min} max={d.max} disabled={disabled} srLabel={d.label} placeholder={d.nullable ? 'None' : undefined} />
}

function useSchools() {
  return useQuery({ queryKey: ['seller-tenants-lite'], queryFn: () => api.get<List<School>>('/api/v1/seller/tenants') })
}
function useRegistry() {
  return useQuery({ queryKey: ['seller-controls-registry'], queryFn: () => api.get<Registry>(`${BASE}/registry`) })
}

/** Asks why before a change reaches a school; the school reads the reason. */
function ReasonDialog({ title, summary, onCancel, onConfirm, pending, error }: { title: string; summary: string; onCancel: () => void; onConfirm: (reason: string) => void; pending: boolean; error: unknown }) {
  const [reason, setReason] = useState('')
  return (
    <Dialog title={title} description={summary} onClose={onCancel}
      footer={<><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button pending={pending} disabled={reason.trim().length < 3} onClick={() => onConfirm(reason)}>Confirm</Button></>}>
      <Field label="Reason" hint="The school sees this with the change.">
        <Textarea value={reason} onChange={setReason} placeholder="For example: asked by the principal on 2 Oct" />
      </Field>
      {error ? <FormNotice error={error} /> : null}
    </Dialog>
  )
}

/* --- per school ------------------------------------------------------------ */

function SchoolTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const schools = useSchools()
  const [school, setSchool] = useState('')
  const [group, setGroup] = useState<string>('features')
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [ask, setAsk] = useState<null | { kind: 'save' } | { kind: 'reset'; key: string; label: string }>(null)
  const key = ['seller-controls-school', school]
  const data = useQuery({ queryKey: key, enabled: !!school, queryFn: () => api.get<SchoolSettings>(`${BASE}/schools/${school}`) })
  const rows = data.data?.settings ?? []
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows])
  const changes = Object.entries(draft).filter(([k, v]) => byKey.has(k) && toInput(byKey.get(k)!.value) !== v)
  const save = useMutation({
    mutationFn: (reason: string) => api.put<ApplyResult>(`${BASE}/schools/${school}`, { reason, changes: changes.map(([k, v]) => ({ key: k, value: fromInput(byKey.get(k)!, v) })) }),
    onSuccess: () => { setDraft({}); setAsk(null); qc.invalidateQueries({ queryKey: key }) },
  })
  const reset = useMutation({
    mutationFn: ({ k, reason }: { k: string; reason: string }) => api.post<ApplyResult>(`${BASE}/schools/${school}/reset`, { keys: [k], reason }),
    onSuccess: () => { setAsk(null); qc.invalidateQueries({ queryKey: key }) },
  })
  const needle = q.trim().toLowerCase()
  const shown = rows.filter((r) => (needle ? (r.label + ' ' + r.help + ' ' + r.key).toLowerCase().includes(needle) : r.group === group))
  const count = (g: string) => rows.filter((r) => r.group === g).length

  return (
    <Card>
      <CardHeader title="School settings" description="The value each school runs on, and where it comes from" />
      <div className="space-y-4 px-5 py-4">
        <FormGrid>
          <Field label="School"><Select value={school} onChange={(v) => { setSchool(v); setDraft({}) }} placeholder="Choose a school" options={(schools.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))} /></Field>
          <Field label="Search settings"><Input value={q} onChange={setQ} placeholder="Quiet hours, password, colour" /></Field>
        </FormGrid>
        {!school ? <EmptyState title="Choose a school" body="Its settings appear here, grouped as on the school's own screens." /> : data.error ? <ErrorState error={data.error} /> : !data.data ? <SkeletonTable columns={4} /> : (
          <>
            {!needle && (
              <div className={TAB_BAR} role="tablist">
                {SETTING_GROUPS.filter((g) => count(g.key)).map((g) => (
                  <button key={g.key} role="tab" aria-selected={group === g.key} className={tabClass(group === g.key)} onClick={() => setGroup(g.key)}>{g.label}</button>
                ))}
              </div>
            )}
            <Table head={['Setting', 'Value', 'From', '']} empty={!shown.length}>
              {shown.map((r: SettingRow) => {
                const v = draft[r.key] ?? toInput(r.value)
                const editable = canEdit && r.vendor_editable
                return (
                  <tr key={r.key}>
                    <Td>
                      <div className="font-medium">{r.label}</div>
                      <div className="text-[13px] text-muted-foreground">{r.help}</div>
                      {!r.vendor_editable && <div className="text-[13px] text-muted-foreground">The school decides this on its own screens.</div>}
                    </Td>
                    <Td className="min-w-[180px]">{editable ? <ValueEditor d={r} value={v} onChange={(x) => setDraft({ ...draft, [r.key]: x })} /> : showValue(r.value)}</Td>
                    <Td>
                      <Badge tone={SOURCE[r.source].tone}>{SOURCE[r.source].label}</Badge>
                      {r.source === 'school' && <div className="mt-1 text-[12.5px] text-muted-foreground">Default: {showValue(r.default_value)} ({SOURCE[r.default_source].label.toLowerCase()})</div>}
                    </Td>
                    <Td>{editable && r.source === 'school' ? <Button size="sm" variant="ghost" onClick={() => setAsk({ kind: 'reset', key: r.key, label: r.label })}>Reset</Button> : null}</Td>
                  </tr>
                )
              })}
            </Table>
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!changes.length} onClick={() => setAsk({ kind: 'save' })}>{changes.length ? `Save ${changes.length} change${changes.length > 1 ? 's' : ''}` : 'No changes'}</Button>
                {changes.length > 0 && <Button variant="secondary" onClick={() => setDraft({})}>Discard</Button>}
              </div>
            )}
          </>
        )}
      </div>
      {ask?.kind === 'save' && (
        <ReasonDialog title={`Change ${changes.length} setting${changes.length > 1 ? 's' : ''} at ${data.data?.institution.name}`}
          summary={changes.map(([k, v]) => `${byKey.get(k)!.label}: ${showValue(byKey.get(k)!.value)} to ${showValue(fromInput(byKey.get(k)!, v))}`).join('; ')}
          onCancel={() => setAsk(null)} onConfirm={(reason) => save.mutate(reason)} pending={save.isPending} error={save.error} />
      )}
      {ask?.kind === 'reset' && (
        <ReasonDialog title={`Reset ${ask.label}`} summary="Back to the plan, platform or built-in default."
          onCancel={() => setAsk(null)} onConfirm={(reason) => reset.mutate({ k: ask.key, reason })} pending={reset.isPending} error={reset.error} />
      )}
    </Card>
  )
}

/* --- many schools ------------------------------------------------------------ */

function ResultTable({ result }: { result: ApplyResult }) {
  return (
    <Table head={['School', 'Changes', '']} empty={!result.schools.length}>
      {result.schools.map((s) => (
        <tr key={s.id}>
          <Td className="font-medium">{s.name || s.id}</Td>
          <Td>{s.error ? <span className="text-destructive">{s.error}</span> : s.changes.length ? s.changes.map((c) => `${c.label}: ${showValue(c.before)} to ${showValue(c.after)}`).join('; ') : 'Already set'}</Td>
          <Td>{result.applied && !s.error && s.changes.length > 0 ? <Badge tone="success">Done</Badge> : null}</Td>
        </tr>
      ))}
    </Table>
  )
}

function ApplyTab({ registry, canEdit }: { registry: Registry; canEdit: boolean }) {
  const schools = useSchools()
  const [keyName, setKeyName] = useState('')
  const [value, setValue] = useState('')
  const [mode, setMode] = useState<'set' | 'reset'>('set')
  const [who, setWho] = useState<Set<string>>(new Set())
  const [all, setAll] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [asking, setAsking] = useState(false)
  const d = registry.settings.find((s) => s.key === keyName)
  const body = (dry: boolean, reason?: string) => ({
    ...(mode === 'set' ? { changes: [{ key: keyName, value: d ? fromInput(d, value) : null }] } : { reset_keys: [keyName] }),
    ...(all ? { all: true } : { institution_ids: [...who] }), dry_run: dry, reason,
  })
  const run = useMutation({
    mutationFn: ({ dry, reason }: { dry: boolean; reason?: string }) => api.post<ApplyResult>(`${BASE}/apply`, body(dry, reason)),
    onSuccess: (r) => { setResult(r); setAsking(false) },
  })
  const ready = !!d && (all || who.size > 0)
  const editable = registry.settings.filter((s) => s.vendor_editable)
  return (
    <Card>
      <CardHeader title="Apply to schools" description="One setting on many schools. Preview first: only schools whose value would change are touched." />
      <div className="space-y-4 px-5 py-4">
        <FormGrid>
          <Field label="Setting"><Select value={keyName} onChange={(v) => { setKeyName(v); setValue(''); setResult(null) }} placeholder="Choose a setting"
            options={editable.map((s) => ({ value: s.key, label: `${SETTING_GROUPS.find((g) => g.key === s.group)?.label}: ${s.label}` }))} /></Field>
          <Field label="Change"><Select value={mode} onChange={(v) => { setMode(v as 'set' | 'reset'); setResult(null) }} options={[{ value: 'set', label: 'Set a value' }, { value: 'reset', label: 'Reset to default' }]} /></Field>
          {d && mode === 'set' && <Field label="Value"><ValueEditor d={d} value={value} onChange={(v) => { setValue(v); setResult(null) }} /></Field>}
        </FormGrid>
        <Checkbox checked={all} onChange={(v) => { setAll(v); setResult(null) }} label="Every school" />
        {!all && (
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {(schools.data?.items ?? []).map((s) => (
              <Checkbox key={s.id} checked={who.has(s.id)} label={s.name}
                onChange={(v) => { const n = new Set(who); if (v) n.add(s.id); else n.delete(s.id); setWho(n); setResult(null) }} />
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!ready} pending={run.isPending && !asking} onClick={() => run.mutate({ dry: true })}>Preview</Button>
          {canEdit && <Button disabled={!result || result.applied || !result.schools.some((s) => s.changes.length)} onClick={() => setAsking(true)}>Apply</Button>}
        </div>
        {run.error && !asking ? <FormNotice error={run.error} /> : null}
        {result && <ResultTable result={result} />}
      </div>
      {asking && result && (
        <ReasonDialog title={`Apply to ${result.schools.filter((s) => s.changes.length).length} schools`} summary="Each school gets an entry in its vendor activity record."
          onCancel={() => setAsking(false)} onConfirm={(reason) => run.mutate({ dry: false, reason })} pending={run.isPending} error={run.error} />
      )}
    </Card>
  )
}

/* --- defaults ---------------------------------------------------------------- */

function DefaultsTab({ registry, canEdit }: { registry: Registry; canEdit: boolean }) {
  const qc = useQueryClient()
  const [scope, setScope] = useState('platform')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [q, setQ] = useState('')
  const current = new Map(registry.defaults.filter((x) => x.scope === scope).map((x) => [x.key, x.value]))
  const refresh = () => qc.invalidateQueries({ queryKey: ['seller-controls-registry'] })
  const set = useMutation({ mutationFn: ({ key, value }: { key: string; value: SettingValue }) => api.put(`${BASE}/defaults`, { scope, key, value }), onSuccess: (_r, v) => { const n = { ...draft }; delete n[v.key]; setDraft(n); refresh() } })
  const clear = useMutation({ mutationFn: (key: string) => api.del(`${BASE}/defaults?scope=${encodeURIComponent(scope)}&key=${encodeURIComponent(key)}`), onSuccess: refresh })
  const needle = q.trim().toLowerCase()
  const rows = registry.settings.filter((s) => s.defaults && s.vendor_editable && (!needle || (s.label + ' ' + s.key).toLowerCase().includes(needle)))
  return (
    <Card>
      <CardHeader title="Defaults for new schools" description="Written into a school when it is created. A plan default wins over the platform one. Existing schools change only through Apply to schools or Reset." />
      <div className="space-y-4 px-5 py-4">
        <FormGrid>
          <Field label="For"><Select value={scope} onChange={(v) => { setScope(v); setDraft({}) }} options={[{ value: 'platform', label: 'Every new school' }, ...registry.plans.map((p) => ({ value: 'plan:' + p.code, label: `Plan: ${p.name}` }))]} /></Field>
          <Field label="Search"><Input value={q} onChange={setQ} placeholder="Setting name" /></Field>
        </FormGrid>
        {set.error ? <FormNotice error={set.error} /> : null}
        <Table head={['Setting', 'Built-in', 'Default', '']} empty={!rows.length}>
          {rows.map((s) => {
            const has = current.has(s.key)
            const v = draft[s.key] ?? (has ? toInput(current.get(s.key)!) : toInput(s.builtin))
            return (
              <tr key={s.key}>
                <Td><div className="font-medium">{s.label}</div><div className="text-[13px] text-muted-foreground">{SETTING_GROUPS.find((g) => g.key === s.group)?.label}</div></Td>
                <Td>{s.options?.find((o) => o.value === s.builtin)?.label ?? showValue(s.builtin)}</Td>
                <Td className="min-w-[180px]">{canEdit ? <ValueEditor d={s} value={v} onChange={(x) => setDraft({ ...draft, [s.key]: x })} /> : has ? showValue(current.get(s.key)!) : 'Built-in'}</Td>
                <Td>
                  {canEdit && draft[s.key] !== undefined && <Button size="sm" pending={set.isPending && set.variables?.key === s.key} onClick={() => set.mutate({ key: s.key, value: fromInput(s, draft[s.key]) })}>Save</Button>}
                  {canEdit && has && draft[s.key] === undefined && <Button size="sm" variant="ghost" onClick={() => clear.mutate(s.key)}>Remove</Button>}
                </Td>
              </tr>
            )
          })}
        </Table>
      </div>
    </Card>
  )
}

/* --- roles ------------------------------------------------------------------- */

function RolesTab({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const data = useQuery({ queryKey: ['seller-controls-roles'], queryFn: () => api.get<{ roles: RoleTemplate[]; permissions: { key: string; module: string; description: string }[] }>(`${BASE}/roles`) })
  const [role, setRole] = useState('')
  const [draft, setDraft] = useState<Set<string> | null>(null)
  const [q, setQ] = useState('')
  const [push, setPush] = useState<RolePushResult | null>(null)
  const [force, setForce] = useState<Set<string>>(new Set())
  const [asking, setAsking] = useState(false)
  const tpl = data.data?.roles.find((r) => r.key === role)
  const perms = draft ?? new Set(tpl?.permissions ?? [])
  const refresh = () => qc.invalidateQueries({ queryKey: ['seller-controls-roles'] })
  const save = useMutation({ mutationFn: () => api.put(`${BASE}/roles/${role}`, { permissions: [...perms] }), onSuccess: () => { setDraft(null); setPush(null); refresh() } })
  const clear = useMutation({ mutationFn: () => api.del(`${BASE}/roles/${role}`), onSuccess: () => { setDraft(null); setPush(null); refresh() } })
  const run = useMutation({
    mutationFn: ({ dry, reason }: { dry: boolean; reason?: string }) => api.post<RolePushResult>(`${BASE}/roles/${role}/push`, { dry_run: dry, reason, all: true, include_customised: [...force] }),
    onSuccess: (r) => { setPush(r); setAsking(false) },
  })
  if (data.error) return <ErrorState error={data.error} />
  if (!data.data) return <SkeletonTable columns={3} />
  const needle = q.trim().toLowerCase()
  const list = data.data.permissions.filter((p) => !needle || (p.key + ' ' + p.description).toLowerCase().includes(needle))
  return (
    <Card>
      <CardHeader title="Role templates" description="The permissions each built-in role starts with. New schools get these; existing schools only when pushed, and never a school that changed the role itself unless you tick it." />
      <div className="space-y-4 px-5 py-4">
        <FormGrid>
          <Field label="Role"><Select value={role} onChange={(v) => { setRole(v); setDraft(null); setPush(null); setForce(new Set()) }} placeholder="Choose a role"
            options={data.data.roles.map((r) => ({ value: r.key, label: `${r.name}${r.source === 'platform' ? ' (edited)' : ''}` }))} /></Field>
          {tpl && <Field label="Search permissions"><Input value={q} onChange={setQ} placeholder="fees, attendance" /></Field>}
        </FormGrid>
        {tpl && (
          <>
            <p className="text-[13px] text-muted-foreground">{perms.size} permissions{tpl.source === 'platform' ? ' (your template)' : ' (built-in list)'}.</p>
            <div className="grid max-h-[420px] gap-1 overflow-y-auto sm:grid-cols-2">
              {list.map((p) => (
                <Checkbox key={p.key} checked={perms.has(p.key)} label={p.description || p.key} hint={p.key}
                  onChange={(v) => { if (!canEdit) return; const n = new Set(perms); if (v) n.add(p.key); else n.delete(p.key); setDraft(n) }} />
              ))}
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button disabled={!draft} pending={save.isPending} onClick={() => save.mutate()}>Save template</Button>
                {tpl.source === 'platform' && <Button variant="secondary" pending={clear.isPending} onClick={() => clear.mutate()}>Back to built-in</Button>}
                <Button variant="secondary" disabled={!!draft} pending={run.isPending && !asking} onClick={() => run.mutate({ dry: true })}>Preview push to schools</Button>
              </div>
            )}
            {save.error ? <FormNotice error={save.error} /> : null}
            {push && (
              <>
                <Table head={['School', 'Result', 'Added', 'Removed', 'Replace their changes']} empty={!push.schools.length}>
                  {push.schools.map((s) => (
                    <tr key={s.id}>
                      <Td className="font-medium">{s.name || s.id}</Td>
                      <Td>{s.status === 'customised' ? 'Changed by the school; skipped' : s.status === 'updated' ? (push.applied ? 'Updated' : 'Will update') : s.status === 'unchanged' ? 'Already matches' : s.status === 'missing' ? 'No such role' : s.error}</Td>
                      <Td>{s.added}</Td>
                      <Td>{s.removed}</Td>
                      <Td>{s.status === 'customised' && !push.applied ? <Checkbox checked={force.has(s.id)} label="Replace" srLabel={`Replace ${s.name}'s version`} onChange={(v) => { const n = new Set(force); if (v) n.add(s.id); else n.delete(s.id); setForce(n) }} /> : null}</Td>
                    </tr>
                  ))}
                </Table>
                {!push.applied && canEdit && <Button disabled={!push.schools.some((s) => s.status === 'updated' || force.has(s.id))} onClick={() => setAsking(true)}>Push</Button>}
              </>
            )}
          </>
        )}
      </div>
      {asking && <ReasonDialog title={`Push ${tpl?.name}`} summary="Each school updated gets an entry in its vendor activity record." onCancel={() => setAsking(false)} onConfirm={(reason) => run.mutate({ dry: false, reason })} pending={run.isPending} error={run.error} />}
    </Card>
  )
}

/* --- configuration templates --------------------------------------------------- */

function TemplatesTab({ canEdit }: { canEdit: boolean }) {
  const schools = useSchools()
  const opts = (schools.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [text, setText] = useState('')
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [asking, setAsking] = useState(false)
  const exp = useMutation({
    mutationFn: () => api.get<ConfigTemplate>(`${BASE}/schools/${from}/export`),
    onSuccess: (t) => {
      setText(JSON.stringify(t, null, 2))
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' }))
      a.download = `configuration-${t.from.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`
      a.click()
    },
  })
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
  const run = useMutation({
    mutationFn: ({ dry, reason }: { dry: boolean; reason?: string }) => api.post<ApplyResult>(`${BASE}/schools/${to}/import`, { template: parsed, dry_run: dry, reason }),
    onSuccess: (r) => { setResult(r); setAsking(false) },
  })
  return (
    <Card>
      <CardHeader title="Configuration templates" description="Copy one school's setup onto another: settings only, never records." />
      <div className="space-y-4 px-5 py-4">
        <FormGrid>
          <Field label="Copy from"><Select value={from} onChange={setFrom} placeholder="Choose a school" options={opts} /></Field>
        </FormGrid>
        <Button variant="secondary" disabled={!from} pending={exp.isPending} onClick={() => exp.mutate()}>Download configuration</Button>
        <Field label="Configuration" hint="Filled in by Download, or paste a saved file.">
          <Textarea value={text} onChange={(v) => { setText(v); setResult(null) }} placeholder='{"format": "xulo-config/1", ...}' />
        </Field>
        {text && !parsed ? <p className="text-[13px] text-destructive">This is not a configuration file.</p> : null}
        <FormGrid>
          <Field label="Apply to"><Select value={to} onChange={(v) => { setTo(v); setResult(null) }} placeholder="Choose a school" options={opts} /></Field>
        </FormGrid>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!to || !parsed} pending={run.isPending && !asking} onClick={() => run.mutate({ dry: true })}>Preview</Button>
          {canEdit && <Button disabled={!result || result.applied || !result.schools.some((s) => s.changes.length)} onClick={() => setAsking(true)}>Apply</Button>}
        </div>
        {run.error && !asking ? <FormNotice error={run.error} /> : null}
        {result && <ResultTable result={result} />}
      </div>
      {asking && <ReasonDialog title="Apply configuration" summary={`${result?.schools[0]?.changes.length ?? 0} settings change.`} onCancel={() => setAsking(false)} onConfirm={(reason) => run.mutate({ dry: false, reason })} pending={run.isPending} error={run.error} />}
    </Card>
  )
}

const TABS = [
  { key: 'school', label: 'School settings' }, { key: 'apply', label: 'Apply to schools' }, { key: 'defaults', label: 'Defaults' },
  { key: 'roles', label: 'Role templates' }, { key: 'templates', label: 'Configuration templates' },
] as const

export function Controls() {
  const registry = useRegistry()
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('school')
  if (registry.error) return <ErrorState error={registry.error} />
  if (!registry.data) return <SkeletonTable columns={4} />
  const canEdit = registry.data.can_edit
  return (
    <div className="space-y-4">
      {!canEdit && <p className="text-[13px] text-muted-foreground">Read only: your login can see these settings but not change them.</p>}
      <div className={TAB_BAR} role="tablist">
        {TABS.map((t) => <button key={t.key} role="tab" aria-selected={tab === t.key} className={tabClass(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>
      {tab === 'school' && <SchoolTab canEdit={canEdit} />}
      {tab === 'apply' && <ApplyTab registry={registry.data} canEdit={canEdit} />}
      {tab === 'defaults' && <DefaultsTab registry={registry.data} canEdit={canEdit} />}
      {tab === 'roles' && <RolesTab canEdit={canEdit} />}
      {tab === 'templates' && <TemplatesTab canEdit={canEdit} />}
    </div>
  )
}
