import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquareWarning } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Button, Field,
  FormGrid, FormNotice, Input, Select, Textarea, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useChildren, childOptions } from './use-children'
import { AttachFile, StageBadge } from '@/features/communication/concern-ui'
import { RaiserCasePanel } from '@/features/communication/concern-raiser'

/* Raising a concern, and following it.

   A grievance a school cannot show it received is a grievance the family will
   raise again, louder, to somebody else. Every concern here has a number, a
   status and — once the office answers — what was done about it.

   The list is the caller's own, not the family's. Two guardians of one child
   are two complainants: a mother raising a concern about a teacher has not
   agreed to the father reading it. */

interface Concern {
  id: string
  student_name?: string
  category: string
  subject: string
  body: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed'
  stage: string
  replies: number
  last_update_at?: string
  can_reopen: boolean
  satisfaction?: number
  resolution?: string
  assigned_to?: string
  created_at: string
  resolved_at?: string
  open_days: number
}

const CATEGORIES = [
  { value: 'academic', key: 'portal.concerns.category_academic' },
  { value: 'fees', key: 'portal.concerns.category_fees' },
  { value: 'transport', key: 'portal.concerns.category_transport' },
  { value: 'hostel', key: 'portal.concerns.category_hostel' },
  { value: 'discipline', key: 'portal.concerns.category_discipline' },
  { value: 'safety', key: 'portal.concerns.category_safety' },
  { value: 'staff', key: 'portal.concerns.category_staff' },
  { value: 'facilities', key: 'portal.concerns.category_facilities' },
  { value: 'other', key: 'portal.concerns.category_other' },
] as const

export default function Concerns() {
  const t = useT()
  const qc = useQueryClient()
  const concerns = useQuery({
    queryKey: ['portal-concerns'],
    queryFn: () => api.get<List<Concern>>('/api/v1/portal/concerns'),
    // A reply or stage change must show on the next visit, not after the app-wide five minutes.
    staleTime: 0,
  })
  const { children, chosen, setChosen } = useChildren()

  const [category, setCategory] = useState('academic')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [priority, setPriority] = useState('normal')
  const [file, setFile] = useState<{ id: string; name: string } | null>(null)
  // ?id= opens one straight away: the link a notification carries.
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('id'))

  const raise = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/concerns', {
        student_id: chosen || undefined,
        category,
        subject,
        body,
        priority,
        attachment_file_id: file?.id,
      }),
    onSuccess: () => {
      setSubject('')
      setBody('')
      setFile(null)
      qc.invalidateQueries({ queryKey: ['portal-concerns'] })
    },
  })

  if (concerns.isLoading) return <ScreenSkeleton label={t('portal.concerns.loading')} />
  if (concerns.error && !concerns.data) return <ScreenError error={concerns.error} />

  const rows = concerns.data?.items ?? []
  const open = rows.filter((c) => c.status !== 'resolved' && c.status !== 'closed')
  const categoryLabel = (value: string) => {
    const found = CATEGORIES.find((x) => x.value === value)
    return found ? t(found.key) : value
  }

  return (
    <>
      <PageHead
        eyebrow={t('portal.concerns.eyebrow')}
        title={t('portal.concerns.title')}
        description={t('portal.concerns.description')}
      />
      <Freshness query={concerns} />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label={t('portal.concerns.stat_open')} value={open.length} icon={MessageSquareWarning} />
          <Stat
            label={t('portal.concerns.stat_answered')}
            value={rows.filter((c) => c.status === 'resolved').length}
          />
          <Stat
            label={t('portal.concerns.stat_longest')}
            value={
              open.length
                ? t('portal.concerns.days', { count: Math.max(...open.map((c) => c.open_days)) })
                : '-'
            }
          />
        </CellGrid>

        <Card>
          <CardHeader
            title={t('portal.concerns.raise_title')}
            description={t('portal.concerns.raise_description')}
          />
          <div className="p-4">
            <FormGrid>
              <Field label={t('portal.concerns.field_category')} required>
                <Select
                  value={category}
                  onChange={setCategory}
                  options={CATEGORIES.map((x) => ({ value: x.value, label: t(x.key) }))}
                />
              </Field>
              {children.length > 0 && (
                <Field
                  label={t('portal.concerns.field_child')}
                  hint={t('portal.concerns.field_child_hint')}
                >
                  <Select
                    value={chosen}
                    onChange={setChosen}
                    placeholder={t('portal.concerns.child_placeholder')}
                    options={childOptions(children)}
                  />
                </Field>
              )}
              <Field label={t('portal.concerns.field_priority')}>
                <Select
                  value={priority}
                  onChange={setPriority}
                  options={[
                    { value: 'low', label: t('portal.concerns.priority_low') },
                    { value: 'normal', label: t('portal.concerns.priority_normal') },
                    { value: 'high', label: t('portal.concerns.priority_high') },
                  ]}
                />
              </Field>
              <Field label={t('portal.concerns.field_subject')} required wide>
                <Input
                  value={subject}
                  onChange={setSubject}
                  placeholder={t('portal.concerns.subject_placeholder')}
                />
              </Field>
              <Field label={t('portal.concerns.field_body')} required wide>
                <Textarea
                  rows={4}
                  value={body}
                  onChange={setBody}
                  placeholder={t('portal.concerns.body_placeholder')}
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <AttachFile file={file} onChange={setFile} />
            </div>
            <div className="mt-4">
              <Button
                disabled={raise.isPending || subject.trim() === '' || body.trim() === ''}
                onClick={() => raise.mutate()}
              >
                {raise.isPending ? t('portal.concerns.sending') : t('portal.concerns.action_send')}
              </Button>
            </div>
            <FormNotice
              error={raise.error}
              ok={raise.isSuccess ? t('portal.concerns.raise_ok') : undefined}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t('portal.concerns.list_title')}
            description={t('portal.concerns.list_description')}
          />
          {rows.length === 0 ? (
            <EmptyState
              title={t('portal.concerns.empty_title')}
              body={t('portal.concerns.empty_body')}
            />
          ) : (
            <ul className="divide-y">
              {rows.map((c) => (
                <li key={c.id} className="px-[var(--card-pad)] py-4">
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-start gap-3 text-left"
                    aria-expanded={openId === c.id}
                    onClick={() => setOpenId(openId === c.id ? null : c.id)}
                  >
                    <div className="min-w-[14rem] flex-1">
                      <div className="font-medium">{c.subject}</div>
                      <div className="mt-1 text-[12px] text-muted-foreground">
                        {categoryLabel(c.category)}
                        {c.student_name && ` · ${c.student_name}`}
                        {t('portal.concerns.raised_on', { date: formatDate(c.created_at) })}
                        {c.replies > 0 && ` · ${c.replies} ${c.replies === 1 ? 'reply' : 'replies'} from the school`}
                      </div>
                    </div>
                    <StageBadge stage={c.stage} />
                  </button>
                  {openId === c.id && (
                    <div className="mt-4 border-t pt-4">
                      <RaiserCasePanel id={c.id} base="/api/v1/portal/comms/grievances" rateSuffix="satisfaction" listKey={['portal-concerns']} />
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
