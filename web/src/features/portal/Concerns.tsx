import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquareWarning } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Field,
  FormGrid, FormNotice, Input, Select, Textarea, SkeletonTiles, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useChildren, childOptions } from './use-children'

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
  resolution?: string
  assigned_to?: string
  created_at: string
  resolved_at?: string
  open_days: number
}

const TONE: Record<Concern['status'], 'warning' | 'info' | 'success' | 'neutral'> = {
  open: 'warning',
  in_progress: 'info',
  waiting: 'info',
  resolved: 'success',
  closed: 'neutral',
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
  })
  const { children, chosen, setChosen } = useChildren()

  const [category, setCategory] = useState('academic')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [priority, setPriority] = useState('normal')

  const raise = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/concerns', {
        student_id: chosen || undefined,
        category,
        subject,
        body,
        priority,
      }),
    onSuccess: () => {
      setSubject('')
      setBody('')
      qc.invalidateQueries({ queryKey: ['portal-concerns'] })
    },
  })

  if (concerns.isLoading) return <SkeletonTiles count={3} label={t('portal.concerns.loading')} />
  if (concerns.error) return <ScreenError error={concerns.error} />

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
                : '—'
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
                <li key={c.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-[18rem] flex-1">
                      <div className="font-medium">{c.subject}</div>
                      <div className="mt-0.5 text-[13px] text-muted-foreground">{c.body}</div>
                      <div className="mt-1 text-[12px] text-muted-foreground">
                        {categoryLabel(c.category)}
                        {c.student_name && ` · ${c.student_name}`}
                        {t('portal.concerns.raised_on', { date: formatDate(c.created_at) })}
                        {c.assigned_to && t('portal.concerns.assigned_to', { name: c.assigned_to })}
                      </div>
                    </div>
                    <Badge tone={TONE[c.status]}>{c.status.replace('_', ' ')}</Badge>
                  </div>
                  {c.resolution && (
                    <div className="mt-3 rounded-sm bg-muted px-3 py-2 text-[13px]">
                      <span className="font-medium">{t('portal.concerns.school_says')}</span>
                      {c.resolution}
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
