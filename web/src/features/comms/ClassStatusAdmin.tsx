import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Eye, Pin, PinOff, Plus, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Button, Card, CardHeader, EmptyState, ErrorState, FormNotice, PageBody, PageHead, Select } from '@/components/ui'
import { ViewsSheet } from './status/StatusRings'
import StatusComposer, { StatusFileInput } from './status/StatusComposer'
import { PostThumb } from './ClassStatus'
import { hoursLeft, type AdminPost, type StatusSettings } from './status/status-api'

/* Class Status, the school's screen (institution_admin.communication.class_status):
   the approval queue, every live and pinned post with its poster, audience,
   views and seen %, filters by class and poster, delete and pin any post,
   post as the school, and the rules: on or off, approval, who may post,
   video and its length. */

interface AdminList { items: AdminPost[]; posters: { id: string; name: string }[]; classes: { id: string; name: string }[]; settings: StatusSettings }

export default function ClassStatusAdmin() {
  const qc = useQueryClient()
  const session = useSession()
  const [cls, setCls] = useState('')
  const [poster, setPoster] = useState('')
  const [compose, setCompose] = useState<File | null>(null)
  const [views, setViews] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['class-status-admin', cls, poster],
    queryFn: () => api.get<AdminList>(`/api/v1/status/admin/posts?class_id=${cls}&poster_id=${poster}`),
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['class-status-admin'] })
    void qc.invalidateQueries({ queryKey: ['notifications'] })
  }
  const act = useMutation({
    mutationFn: ({ p, what }: { p: AdminPost; what: 'approve' | 'reject' | 'pin' | 'delete' }) =>
      what === 'delete' ? api.del(`/api/v1/status/posts/${p.id}`)
        : what === 'pin' ? api.post(`/api/v1/status/posts/${p.id}/pin`, { pinned: !p.pinned })
          : api.post(`/api/v1/status/posts/${p.id}/${what}`),
    onSuccess: refresh,
  })
  const save = useMutation({ mutationFn: (s: Partial<StatusSettings>) => api.put('/api/v1/status/settings', s), onSuccess: refresh })
  const s = q.data?.settings
  /* Changes are held until Save (the owner's design), not sent on every click. */
  const [draft, setDraft] = useState<StatusSettings | null>(null)
  const d = draft ?? s
  const setD = (patch: Partial<StatusSettings>) => d && setDraft({ ...d, ...patch })
  const pending = q.data?.items.filter((p) => p.status === 'pending') ?? []
  const live = q.data?.items.filter((p) => p.status === 'live') ?? []
  const school = session.institution?.display_name || session.institution?.short_name || session.institution?.name || 'the school'

  const row = (p: AdminPost) => (
    <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
      <PostThumb p={p} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{p.caption || (p.media_kind === 'video' ? 'Video' : 'Photo')}</div>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          <span>{p.as_school ? school : p.poster_name}</span>
          <span>· {p.audience}</span>
          {p.status === 'live' && <span>· {p.views} seen{p.audience_size ? ` (${p.seen_pct}%)` : ''}</span>}
          {p.status === 'live' && <span>· {p.pinned ? 'Pinned' : hoursLeft(p.expires_at)}</span>}
        </div>
      </div>
      {p.status === 'pending' ? (
        <>
          <Button size="sm" onClick={() => act.mutate({ p, what: 'approve' })}><Check className="size-4" /> Approve</Button>
          <Button size="sm" variant="secondary" onClick={() => act.mutate({ p, what: 'reject' })}><X className="size-4" /> Reject</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" size="sm" onClick={() => setViews(p.id)} title="Seen by"><Eye className="size-4" /></Button>
          <Button variant="ghost" size="sm" onClick={() => act.mutate({ p, what: 'pin' })} title={p.pinned ? 'Unpin' : 'Pin'}>
            {p.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => act.mutate({ p, what: 'delete' })} title="Delete"><Trash2 className="size-4" /></Button>
        </>
      )}
    </li>
  )

  return (
    <>
      <PageHead eyebrow="Communication" title="Class Status" actions={
        <StatusFileInput onPick={setCompose} label={`Post as ${school}`} className="btn inline-flex h-10 items-center gap-1.5 rounded-sm px-3">
          <Plus className="size-4" /> Post as the school
        </StatusFileInput>
      } />
      <PageBody>
        {q.isError ? <ErrorState error={q.error} /> : !q.data ? null : (
          <>
            {pending.length > 0 && (
              <Card>
                <CardHeader title={`Waiting for approval (${pending.length})`} description="Nobody sees these until you approve them." />
                <ul className="divide-y">{pending.map(row)}</ul>
              </Card>
            )}
            <Card>
              <CardHeader title="Live and pinned" description="Every status families, children and staff can see right now." />
              <div className="flex flex-wrap gap-3 px-5 pb-3 pt-4">
                <div className="w-56"><Select value={cls} onChange={setCls} placeholder="All classes" options={[{ value: '', label: 'All classes' }, ...q.data.classes.map((c) => ({ value: c.id, label: c.name }))]} /></div>
                <div className="w-56"><Select value={poster} onChange={setPoster} placeholder="Everyone" options={[{ value: '', label: 'Everyone' }, ...q.data.posters.map((c) => ({ value: c.id, label: c.name }))]} /></div>
              </div>
              {live.length === 0 ? <EmptyState title="No statuses right now" /> : <ul className="divide-y">{live.map(row)}</ul>}
            </Card>
            {d && (
              /* THE OWNER'S SETTINGS DESIGN: a header with the state, grouped
                 rows with switches and small dropdowns, Discard and Save. */
              <Card className="mx-auto w-full max-w-[560px] space-y-5 p-6">
                <div className="flex items-center justify-between border-b pb-4">
                  <div>
                    <h2 className="text-[16px] font-bold tracking-[-0.01em]">Class Status</h2>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">Manage publishing rules and visibility</p>
                  </div>
                  <span className={'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ' + (d.enabled ? 'bg-[#ecfdf5] text-[#059669]' : 'bg-muted text-muted-foreground')}>
                    <span className={'h-1.5 w-1.5 rounded-full ' + (d.enabled ? 'bg-[#10b981]' : 'bg-muted-foreground')} />{d.enabled ? 'Active' : 'Off'}
                  </span>
                </div>
                <SettingsGroup title="Permissions">
                  <SettingsRow title="Status feature" sub="Turn on class stories school-wide">
                    <Switch on={d.enabled} onChange={(v) => setD({ enabled: v })} />
                  </SettingsRow>
                  <SettingsRow title="Who may post" sub="Eligible publishing roles">
                    <MiniSelect value={d.who} onChange={(v) => setD({ who: v as StatusSettings['who'] })}
                      options={[['teachers', 'All teachers'], ['class_teachers', 'Class teachers only'], ['admins', 'Principal and office only']]} />
                  </SettingsRow>
                  <SettingsRow title="Require approval" sub="Review teachers' posts before they publish">
                    <Switch on={d.needs_approval} onChange={(v) => setD({ needs_approval: v })} />
                  </SettingsRow>
                </SettingsGroup>
                <SettingsGroup title="Media constraints">
                  <SettingsRow title="Allow short videos" sub="Permit uploaded video clips">
                    <Switch on={d.allow_video} onChange={(v) => setD({ allow_video: v })} />
                  </SettingsRow>
                  <SettingsRow title="Duration limit" sub="Maximum length allowed per video" disabled={!d.allow_video}>
                    <MiniSelect value={String(d.max_video_seconds)} onChange={(v) => setD({ max_video_seconds: Number(v) })}
                      options={[10, 15, 30, 45, 60].map((n) => [String(n), `${n} seconds`])} />
                  </SettingsRow>
                </SettingsGroup>
                <FormNotice error={save.error || act.error} />
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" disabled={!draft} onClick={() => setDraft(null)}
                    className="rounded-lg border px-3.5 py-1.5 text-[12px] font-medium hover:bg-muted/50 disabled:opacity-50">Discard</button>
                  <button type="button" disabled={!draft || save.isPending}
                    onClick={() => draft && save.mutate(draft, { onSuccess: () => setDraft(null) })}
                    className="rounded-lg bg-foreground px-4 py-1.5 text-[12px] font-semibold text-background shadow-sm hover:opacity-90 disabled:opacity-50">
                    {save.isPending ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </Card>
            )}
          </>
        )}
      </PageBody>
      {compose && <StatusComposer file={compose} asSchool onClose={() => { setCompose(null); refresh() }} />}
      {views && <ViewsSheet postId={views} onClose={() => setViews(null)} />}
    </>
  )
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="pl-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">{title}</span>
      <div className="divide-y overflow-hidden rounded-[14px] border bg-card">{children}</div>
    </div>
  )
}
function SettingsRow({ title, sub, children, disabled }: { title: string; sub: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <div className={'flex items-center justify-between gap-3 px-4 py-3 transition-opacity ' + (disabled ? 'pointer-events-none opacity-45' : '')}>
      <div className="flex max-w-[70%] flex-col gap-0.5">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="text-[11px] text-muted-foreground">{sub}</span>
      </div>
      {children}
    </div>
  )
}
function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={'tap-inline relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200 ' + (on ? 'bg-foreground' : 'bg-muted-foreground/25')}>
      <span className={'absolute bottom-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.15)] transition-transform duration-200 ease-[cubic-bezier(0.2,0.8,0.25,1)] ' + (on ? 'translate-x-4' : '')} />
    </button>
  )
}
function MiniSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[][] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="tap-inline cursor-pointer appearance-none rounded-lg border bg-muted/40 bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2210%22%20height=%2210%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22%236b7280%22%20stroke-width=%222.5%22%3E%3Cpolyline%20points=%226%209%2012%2015%2018%209%22/%3E%3C/svg%3E')] bg-[length:10px] bg-[right_8px_center] bg-no-repeat py-1.5 pl-2.5 pr-7 text-[12px] font-medium outline-none focus:border-foreground focus:bg-card">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}
