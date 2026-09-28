import { lazy, Suspense, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquareWarning, ShieldCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Button, Checkbox, Field, FormGrid,
  FormNotice, Input, Select, Textarea, EmptyState, ErrorState,
} from '@/components/ui'
import { SkeletonPage } from '@/components/Skeleton'
import { useSession } from '@/lib/session'
import { Link } from 'react-router-dom'
import { formatDate } from '@/lib/utils'
import { AttachFile, StageBadge } from '@/features/communication/concern-ui'
import { RaiserCasePanel } from '@/features/communication/concern-raiser'

/* /concerns: raise a concern and follow it, whoever you are.

   A family (parent or student) gets the portal's Concerns screen, which goes
   to the office. A member of staff gets this one, which goes to HR's grievance
   cell, and may raise it anonymously: then neither their name nor their
   account is stored with it, and they follow it here through a keyed hash of
   their account that HR cannot reverse. It sits outside the catalogue, like
   /account, because every member of staff should be able to reach it. */

const PortalConcerns = lazy(() => import('@/features/portal/Concerns'))

interface Mine {
  id: string
  reference_no: string
  is_anonymous: boolean
  category: string
  severity: string
  subject: string
  stage: string
  status: string
  created_at: string
  resolved_at?: string
  resolve_due_at?: string
  replies: number
  can_reopen: boolean
}

export const STAFF_CATEGORIES = [
  { value: 'workload', label: 'Workload' },
  { value: 'pay', label: 'Pay' },
  { value: 'facilities', label: 'Facilities' },
  { value: 'management', label: 'Management' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'discrimination', label: 'Discrimination' },
  { value: 'safety', label: 'Safety' },
  { value: 'other', label: 'Other' },
]
export const staffCategoryLabel = (v: string) => STAFF_CATEGORIES.find((c) => c.value === v)?.label ?? v

export default function ConcernsRoute() {
  const s = useSession()
  const roles = s.user?.roles ?? []
  if (roles.includes('parent') || roles.includes('student')) {
    return <Suspense fallback={<SkeletonPage />}><PortalConcerns /></Suspense>
  }
  return <StaffConcerns />
}

const KEY = ['me', 'concerns'] as const

function StaffConcerns() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: KEY, queryFn: () => api.get<List<Mine>>('/api/v1/me/concerns'), staleTime: 0 })
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('id'))
  const [category, setCategory] = useState('workload')
  const [severity, setSeverity] = useState('medium')
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)

  const raise = useMutation({
    mutationFn: () => api.post<{ id: string; reference_no: string }>('/api/v1/me/concerns', {
      category, severity, subject, description, is_anonymous: anonymous, attachment_file_id: file?.id,
    }),
    onSuccess: (r) => {
      setSubject(''); setDescription(''); setFile(null)
      setOpenId(r.id)
      qc.invalidateQueries({ queryKey: KEY })
    },
  })

  const rows = list.data?.items ?? []
  const open = rows.filter((r) => r.stage !== 'resolved' && r.stage !== 'closed')

  return (
    <>
      <PageHead
        eyebrow="My profile"
        title="My concerns"
        description="Raise a concern with HR and follow it to an answer. You can raise it anonymously."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Open" value={open.length} icon={MessageSquareWarning} />
          <Stat label="Resolved" value={rows.filter((r) => r.stage === 'resolved').length} />
          <Stat label="Raised anonymously" value={rows.filter((r) => r.is_anonymous).length} icon={ShieldCheck} />
        </CellGrid>

        <Card>
          <CardHeader title="Raise a concern" />
          <div className="space-y-5 p-[var(--card-pad)]">
            <FormGrid>
              <Field label="About" required>
                <Select value={category} onChange={setCategory} options={STAFF_CATEGORIES} />
              </Field>
              <Field label="How serious">
                <Select value={severity} onChange={setSeverity} options={[
                  { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
                ]} />
              </Field>
              <Field label="Subject" required wide>
                <Input value={subject} onChange={setSubject} placeholder="Substitution load this term" />
              </Field>
              <Field label="What happened" required wide>
                <Textarea rows={4} value={description} onChange={setDescription} />
              </Field>
            </FormGrid>
            <AttachFile file={file} onChange={setFile} />
            <Checkbox
              checked={anonymous}
              onChange={setAnonymous}
              label="Raise this anonymously"
              hint="HR will not see your name. You can still follow it and write back here, but you will not get notifications for it."
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={!subject.trim() || !description.trim() || raise.isPending} onClick={() => raise.mutate()}>
                {raise.isPending ? 'Sending…' : 'Send to HR'}
              </Button>
            </div>
            <FormNotice error={raise.error}
              ok={raise.data ? `Recorded as ${raise.data.reference_no}.` : undefined} />
          </div>
        </Card>

        <Card>
          <CardHeader title="What I have raised" />
          {list.error ? (
            <ErrorState error={list.error} />
          ) : rows.length === 0 && !list.isLoading ? (
            <EmptyState title="Nothing raised yet" body="A concern you raise appears here with every update HR sends." />
          ) : (
            <ul className="divide-y">
              {rows.map((c) => (
                <li key={c.id} className="px-[var(--card-pad)] py-4">
                  <button type="button" className="flex w-full flex-wrap items-start gap-3 text-left"
                    aria-expanded={openId === c.id} onClick={() => setOpenId(openId === c.id ? null : c.id)}>
                    <div className="min-w-[14rem] flex-1">
                      <div className="font-medium">{c.subject}</div>
                      <div className="mt-1 text-[12px] text-muted-foreground">
                        <span className="tabular-nums">{c.reference_no}</span>
                        {` · ${staffCategoryLabel(c.category)} · raised ${formatDate(c.created_at)}`}
                        {c.is_anonymous && ' · anonymous'}
                        {c.replies > 0 && ` · ${c.replies} ${c.replies === 1 ? 'reply' : 'replies'} from HR`}
                      </div>
                    </div>
                    <StageBadge stage={c.stage} />
                  </button>
                  {openId === c.id && (
                    <div className="mt-4 border-t pt-4">
                      <RaiserCasePanel id={c.id} base="/api/v1/me/concerns" rateSuffix="rate" listKey={KEY} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}

/** On /account: the way in, for everybody. */
export function ConcernsCard() {
  const s = useSession()
  const roles = s.user?.roles ?? []
  const family = roles.includes('parent') || roles.includes('student')
  return (
    <Card>
      <CardHeader
        title="Concerns"
        action={<Link to="/concerns" className="text-[13px] font-medium text-primary hover:underline">Open my concerns</Link>}
      />
      <p className="px-[var(--card-pad)] py-4 text-[14px] text-muted-foreground">
        {family
          ? 'Raise a concern with the school and follow it until it is answered.'
          : 'Raise a concern with HR, anonymously if you prefer, and follow it until it is answered.'}
      </p>
    </Card>
  )
}
