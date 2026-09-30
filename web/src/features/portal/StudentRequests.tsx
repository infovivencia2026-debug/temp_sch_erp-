import { Suspense, lazy, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, FileBadge2, FileText, Send } from 'lucide-react'
import { api, type List } from '@/lib/api'
import { Button, ErrorState, FormNotice, Loading, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import { Bone, HUE, PullToRefresh, Segmented, StudentHeader, StudentPage, shortDate } from './student-kit'
import { Toast } from './StudentToast'

/* MY REQUESTS: ask the office for a certificate and follow it from asked to
   ready, or tell the school about something that is wrong. Certificates use
   the portal's own endpoints; "Tell the school" is the portal's Concerns
   screen, which already files a concern about the student themselves. */

const Concerns = lazy(() => import('./Concerns'))

interface RequestRow { id: string; serial_no?: string; type: string; status: 'requested' | 'approved' | 'issued' | 'cancelled'; issued_on?: string; reason?: string; has_file: boolean; requested_on?: string }
interface RequestType { id: string; code: string; name: string; requires_approval: boolean }

const rq = { queryKey: ['portal-requests'], queryFn: () => api.get<List<RequestRow>>('/api/v1/portal/requests') }
const tq = { queryKey: ['portal-request-types'], queryFn: () => api.get<List<RequestType>>('/api/v1/portal/requests/types') }

const STEPS = ['Asked', 'Being made', 'Ready'] as const
const stepOf = (s: RequestRow['status']) => (s === 'issued' ? 2 : s === 'approved' ? 1 : 0)

export default function StudentRequests() {
  const [tab, setTab] = useState<'cert' | 'tell'>('cert')
  return (
    <StudentPage>
      <StudentHeader title="Requests" sub={tab === 'cert' ? 'Certificates from the school office' : 'Something wrong? Tell the school'} />
      <Segmented label="Kind of request" value={tab} onChange={setTab} options={[{ value: 'cert', label: 'Certificates' }, { value: 'tell', label: 'Tell the school' }]} />
      {tab === 'cert' ? <Certificates /> : (
        <Suspense fallback={<Loading />}>
          <div className="stu-embedded -mx-4 md:-mx-6"><Concerns /></div>
        </Suspense>
      )}
    </StudentPage>
  )
}

function Certificates() {
  const qc = useQueryClient()
  const r = useQuery(rq)
  const types = useQuery(tq)
  const me = useQuery({ queryKey: ['portal-children'], queryFn: () => api.get<List<{ student_id: string }>>('/api/v1/portal/students') })
  const [code, setCode] = useState('')
  const [reason, setReason] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const ask = useMutation({
    mutationFn: () => api.post('/api/v1/portal/requests', { student_id: me.data?.items[0]?.student_id, type_code: code, reason: reason.trim() }),
    onSuccess: () => { setReason(''); setCode(''); setToast('Sent to the office'); setTimeout(() => setToast(null), 3000); qc.invalidateQueries({ queryKey: rq.queryKey }) },
  })
  const rows = (r.data?.items ?? []).filter((x) => x.status !== 'cancelled')
  const open = rows.filter((x) => x.status !== 'issued')
  const done = rows.filter((x) => x.status === 'issued')

  return (
    <PullToRefresh onRefresh={() => qc.invalidateQueries({ queryKey: rq.queryKey })}>
      <div className="space-y-3">
        {r.error ? <ErrorState error={r.error} /> : !r.data ? (
          <><Bone className="h-[120px] w-full rounded-2xl" /><Bone className="h-[300px] w-full rounded-2xl" /></>
        ) : (
          <>
            {rows.length === 0 ? (
              <div className="card stu-rise px-5 py-8 text-center">
                <FileBadge2 className="mx-auto h-10 w-10 text-muted-foreground" strokeWidth={1.5} />
                <p className="mt-2 text-[16px] font-semibold">No requests yet</p>
                <p className="mt-1 text-[14px] text-muted-foreground">Need a bonafide or another certificate? Ask below and follow it here.</p>
              </div>
            ) : (
              <ul className="space-y-3">
                {[...open, ...done].map((x, i) => {
                  const step = stepOf(x.status)
                  return (
                    <li key={x.id} className="card stu-rise p-4" style={{ ['--i' as string]: i }}>
                      <div className="flex items-start gap-3">
                        <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-full', step === 2 ? HUE.emerald.bg : HUE.indigo.bg, step === 2 ? HUE.emerald.fg : HUE.indigo.fg)}>
                          {step === 2 ? <Check className="h-5 w-5" strokeWidth={2} /> : <FileText className="h-5 w-5" strokeWidth={1.75} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[16px] font-semibold leading-snug">{x.type}</p>
                          {x.reason && <p className="line-clamp-2 text-[13px] text-muted-foreground">{/^for\b/i.test(x.reason) ? x.reason : `For ${x.reason}`}</p>}
                        </div>
                      </div>
                      <ol className="mt-3 grid grid-cols-3 gap-1.5" aria-label="Progress">
                        {STEPS.map((s, si) => (
                          <li key={s} className="text-center">
                            <span className={cn('block h-1.5 rounded-full', si <= step ? (step === 2 ? 'bg-success' : 'bg-primary') : 'bg-muted')} />
                            <span className={cn('mt-1 block text-[12px]', si === step ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{s}</span>
                          </li>
                        ))}
                      </ol>
                      {step === 2 && <p className="mt-2 text-[13px] text-muted-foreground">{x.issued_on ? `Ready since ${shortDate(x.issued_on)}. ` : ''}{x.has_file ? 'A signed copy is on file with the office.' : 'Collect it from the school office.'}{x.serial_no ? ` · No. ${x.serial_no}` : ''}</p>}
                    </li>
                  )
                })}
              </ul>
            )}

            <section className="card stu-rise p-4" style={{ ['--i' as string]: 3 }} aria-label="Ask for a certificate">
              <h2 className="text-[16px] font-semibold">Ask for a certificate</h2>
              <p className="text-[13px] text-muted-foreground">Pick one, say what it is for, and the office will make it.</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Which certificate">
                {types.isLoading ? <Bone className="h-[52px] rounded-xl" /> : (types.data?.items ?? []).map((t) => (
                  <button key={t.code} type="button" role="radio" aria-checked={code === t.code} onClick={() => setCode(t.code)}
                    className={cn('stu-press flex min-h-[52px] items-center gap-3 rounded-xl border px-3 text-left text-[15px] font-medium', code === t.code ? 'border-primary bg-[color-mix(in_oklab,#6366f1_8%,transparent)]' : '')}>
                    <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2', code === t.code ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>{code === t.code && <Check className="h-3 w-3" strokeWidth={3} />}</span>
                    {t.name}
                  </button>
                ))}
              </div>
              <label className="mt-3 block text-[14px] font-medium">What is it for?
              <Textarea rows={3} value={reason} onChange={setReason} placeholder="For example: my passport application" /></label>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button className="min-h-[48px] px-6 text-[15px]" disabled={!code || !reason.trim()} pending={ask.isPending} onClick={() => ask.mutate()}><Send className="h-4 w-4" /> Send to the office</Button>
                <FormNotice error={ask.error} />
              </div>
            </section>
          </>
        )}
      </div>
      {toast && <Toast text={toast} />}
    </PullToRefresh>
  )
}
