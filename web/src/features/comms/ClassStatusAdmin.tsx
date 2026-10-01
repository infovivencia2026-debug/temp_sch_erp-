import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Eye, Pin, PinOff, Plus, Trash2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, FormGrid, FormNotice, PageBody, PageHead, Select } from '@/components/ui'
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
              <div className="flex flex-wrap gap-3 px-5 pb-3">
                <div className="w-56"><Select value={cls} onChange={setCls} placeholder="All classes" options={[{ value: '', label: 'All classes' }, ...q.data.classes.map((c) => ({ value: c.id, label: c.name }))]} /></div>
                <div className="w-56"><Select value={poster} onChange={setPoster} placeholder="Everyone" options={[{ value: '', label: 'Everyone' }, ...q.data.posters.map((c) => ({ value: c.id, label: c.name }))]} /></div>
              </div>
              {live.length === 0 ? <EmptyState title="No statuses right now" /> : <ul className="divide-y">{live.map(row)}</ul>}
            </Card>
            {s && (
              <Card>
                <CardHeader title="Settings" />
                <div className="px-5 pb-5">
                  <FormGrid>
                    <Field label="Class Status"><Checkbox checked={s.enabled} onChange={(v) => save.mutate({ enabled: v })} label="On for this school" /></Field>
                    <Field label="Approval"><Checkbox checked={s.needs_approval} onChange={(v) => save.mutate({ needs_approval: v })} label="Teachers' posts wait for approval" /></Field>
                    <Field label="Who may post">
                      <Select value={s.who} onChange={(v) => save.mutate({ who: v as StatusSettings['who'] })} options={[
                        { value: 'teachers', label: 'All teachers' }, { value: 'class_teachers', label: 'Class teachers only' }, { value: 'admins', label: 'Principal and office only' }]} />
                    </Field>
                    <Field label="Video"><Checkbox checked={s.allow_video} onChange={(v) => save.mutate({ allow_video: v })} label="Allow short videos" /></Field>
                    <Field label="Longest video">
                      <Select value={String(s.max_video_seconds)} onChange={(v) => save.mutate({ max_video_seconds: Number(v) })}
                        options={[10, 15, 30, 45, 60].map((n) => ({ value: String(n), label: `${n} seconds` }))} />
                    </Field>
                  </FormGrid>
                  <FormNotice error={save.error || act.error} />
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
