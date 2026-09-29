import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Eye, RotateCcw, Sparkles, X } from 'lucide-react'
import { useToast } from '@/components/Toast'
import { Badge, Button, ErrorState, FormNotice, Loading, PageBody, PageHead, Panel } from '@/components/ui'
import { useCan } from '@/lib/session'
import { cn } from '@/lib/utils'
import { warningsApi, type Warning, type WarningStatus } from './smartApi'

/* EARLY WARNINGS: "Needs attention".

   The flags are raised overnight by plain rules (worker services/ai/
   warning_rules.ts) and each carries the numbers that raised it, shown under
   the sentence so nobody has to trust a summary. The sentence itself is the
   AI's when a key is set, the rule's own words when not. The server decides
   what the caller sees: a class teacher gets their own sections, accounts
   the fee flags, the principal everything. */

const SEV_TONE = { high: 'danger', medium: 'warning', low: 'neutral' } as const
const OWNER = { class_teacher: 'Class teacher', accounts: 'Accounts', principal: 'Principal' } as const
const KEY = ['ai-warnings'] as const

function evidenceLine(w: Warning): string {
  return Object.entries(w.evidence)
    .filter(([k]) => k !== 'dates')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join('; ') : v}`)
    .join(' · ')
}

function WarningRow({ w }: { w: Warning }) {
  const qc = useQueryClient()
  const [noting, setNoting] = useState<WarningStatus | null>(null)
  const [note, setNote] = useState('')
  const [showEvidence, setShowEvidence] = useState(false)
  const set = useMutation({
    mutationFn: (v: { status: WarningStatus; note: string }) => warningsApi.setStatus(w.id, v.status, v.note),
    onSuccess: () => { setNoting(null); setNote(''); qc.invalidateQueries({ queryKey: KEY }) },
  })
  /* Dismiss is for me only: gone from my list, still there for anyone else
     it concerns. Undo on the confirmation brings it straight back. */
  const toast = useToast()
  const dismiss = useMutation({
    mutationFn: () => warningsApi.dismiss(w.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY })
      toast.ok('Dismissed', () => { warningsApi.undismiss([w.id]).then(() => qc.invalidateQueries({ queryKey: KEY })) })
    },
  })
  return (
    <li className="border-t px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-start gap-2">
        <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', w.severity === 'high' ? 'text-destructive' : 'text-warning')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{w.subject_name}</span>
            {w.section_name && w.subject_kind === 'student' && <span className="text-[12.5px] text-muted-foreground">{w.section_name}</span>}
            <Badge tone={SEV_TONE[w.severity]}>{w.label}</Badge>
            {w.status === 'acknowledged' && <Badge tone="info">acknowledged</Badge>}
            {w.status === 'resolved' && <Badge tone="success">resolved</Badge>}
            <span className="text-[12px] text-muted-foreground">for {OWNER[w.owner_role]}</span>
          </div>
          <p className="mt-0.5 text-[13.5px]">
            {w.summary}
            {w.explained_by === 'ai' && <Sparkles className="ml-1 inline h-3 w-3 text-primary" aria-label="worded by AI from the numbers below" />}
          </p>
          <p className="text-[12.5px] text-muted-foreground">Next step: {w.next_step}</p>
          <button type="button" className="text-[12px] underline underline-offset-2 text-muted-foreground" onClick={() => setShowEvidence((v) => !v)}>
            {showEvidence ? 'Hide the numbers' : 'Why? Show the numbers'}
          </button>
          {showEvidence && <p className="mt-1 rounded bg-muted/50 px-2 py-1 text-[12px]">{evidenceLine(w)}</p>}
          {w.status_note && <p className="mt-1 text-[12.5px]">Note{w.status_by_name ? ` from ${w.status_by_name}` : ''}: {w.status_note}</p>}
          {noting && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input autoFocus className="field h-8 min-w-[16rem] flex-1" value={note} onChange={(e) => setNote(e.target.value)}
                placeholder={noting === 'resolved' ? 'What was done? (required)' : 'Note (optional)'} />
              <Button size="sm" variant="ghost" onClick={() => setNoting(null)}>Cancel</Button>
              <Button size="sm" pending={set.isPending} disabled={noting === 'resolved' && !note.trim()} onClick={() => set.mutate({ status: noting, note })}>Save</Button>
            </div>
          )}
          {set.error ? <FormNotice error={set.error} /> : null}
        </div>
        {!noting && (
          <div className="flex gap-1">
            {w.status === 'open' && <Button size="sm" variant="ghost" onClick={() => setNoting('acknowledged')}><Eye className="h-3.5 w-3.5" /> Seen</Button>}
            {w.status !== 'resolved' && <Button size="sm" variant="ghost" onClick={() => setNoting('resolved')}><Check className="h-3.5 w-3.5" /> Resolve</Button>}
            {w.status === 'resolved' && <Button size="sm" variant="ghost" onClick={() => set.mutate({ status: 'open', note: '' })}><RotateCcw className="h-3.5 w-3.5" /> Reopen</Button>}
            {w.status !== 'resolved' && (
              <button type="button" aria-label={`Dismiss the warning about ${w.subject_name}`} title="Dismiss for me"
                onClick={() => dismiss.mutate()}
                className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

/** The list, for a dashboard or its own page. `limit` trims it for a dashboard card. */
export function NeedsAttentionPanel({ limit, sectionId, title = 'Early warnings' }: { limit?: number; sectionId?: string; title?: string }) {
  const [status, setStatus] = useState<'active' | 'resolved'>('active')
  const q = useQuery({ queryKey: [...KEY, status, sectionId ?? ''], queryFn: () => warningsApi.list({ status, section_id: sectionId }) })
  const items = q.data?.items ?? []
  const shown = limit ? items.slice(0, limit) : items
  const qc = useQueryClient()
  const toast = useToast()
  const clearAll = useMutation({
    mutationFn: warningsApi.dismissAll,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: KEY })
      if (r.count) toast.ok(`Cleared ${r.count}`, () => { warningsApi.undismiss(r.ids).then(() => qc.invalidateQueries({ queryKey: KEY })) })
    },
  })
  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {q.data && <span className="text-[12.5px] text-muted-foreground">{items.length} {status === 'active' ? 'need attention' : 'resolved'}</span>}
        <div className="ml-auto flex flex-wrap gap-1">
          {status === 'active' && items.length > 0 && (
            <Button size="sm" variant="ghost" pending={clearAll.isPending} onClick={() => clearAll.mutate()}><X className="h-3.5 w-3.5" /> Clear all</Button>
          )}
          <Button size="sm" variant={status === 'active' ? 'secondary' : 'ghost'} onClick={() => setStatus('active')}>Open</Button>
          <Button size="sm" variant={status === 'resolved' ? 'secondary' : 'ghost'} onClick={() => setStatus('resolved')}>Resolved</Button>
        </div>
      </div>
      {q.isLoading ? <div className="p-4"><Loading shape="table" rows={1} /></div>
        : q.error ? <div className="p-4"><ErrorState error={q.error} /></div>
        : shown.length === 0 ? <p className="px-4 py-6 text-[13px] text-muted-foreground">{status === 'active' ? 'Nothing needs attention. The checks run every night.' : 'Nothing resolved yet.'}</p>
        : <ul>{shown.map((w) => <WarningRow key={w.id} w={w} />)}</ul>}
      {limit && items.length > limit && (
        <a href="/needs-attention" className="block border-t px-4 py-2 text-[13px] underline underline-offset-2">See all {items.length}</a>
      )}
      {q.data?.computed_at && <p className="border-t px-4 py-1.5 text-[11.5px] text-muted-foreground">Checked {new Date(q.data.computed_at).toLocaleString()}{q.data.ai ? '' : ' · sentences from rules (AI not set up)'}</p>}
    </Panel>
  )
}

/** /needs-attention: the full list, with the weekly digest line on top. */
export default function NeedsAttentionPage() {
  const can = useCan()
  const qc = useQueryClient()
  const digest = useQuery({ queryKey: [...KEY, 'digest'], queryFn: warningsApi.digest })
  const rerun = useMutation({ mutationFn: warningsApi.run, onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) })
  return (
    <>
      <PageHead eyebrow="Early warnings" title="Needs attention"
        description={digest.data ? `This week: ${digest.data.text}` : 'Children, classes and staff the nightly checks flagged, with the numbers behind each.'}
        actions={can('students.read.all') ? <Button size="sm" variant="secondary" pending={rerun.isPending} onClick={() => rerun.mutate()}>Check again now</Button> : undefined} />
      <PageBody>
        {rerun.error ? <FormNotice error={rerun.error} /> : null}
        <NeedsAttentionPanel />
      </PageBody>
    </>
  )
}

/** The badge strip on a student's profile: that child's open flags, if any. */
export function StudentWarningStrip({ studentId }: { studentId: string }) {
  const q = useQuery({ queryKey: [...KEY, 'student', studentId], queryFn: () => warningsApi.student(studentId), retry: false })
  const items = q.data?.items ?? []
  if (items.length === 0) return null
  const high = items.some((w) => w.severity === 'high')
  return (
    <div className={cn('mb-2 flex flex-wrap items-center gap-2 rounded-[10px] border px-3 py-2 text-[13px]', high ? 'border-destructive/40 bg-destructive/5' : 'border-warning/40 bg-warning/5')}>
      <AlertTriangle className={cn('h-4 w-4', high ? 'text-destructive' : 'text-warning')} />
      <span className="font-medium">Needs attention</span>
      {items.map((w) => <Badge key={w.id} tone={SEV_TONE[w.severity]}><span title={w.summary}>{w.label}</span></Badge>)}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{items[0].summary}</span>
    </div>
  )
}

