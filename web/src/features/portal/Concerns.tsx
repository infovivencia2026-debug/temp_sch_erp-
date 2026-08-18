import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquareWarning } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Field,
  FormGrid, FormNotice, Input, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
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
  { value: 'academic', label: 'Teaching and learning' },
  { value: 'fees', label: 'Fees and billing' },
  { value: 'transport', label: 'Bus and transport' },
  { value: 'hostel', label: 'Hostel' },
  { value: 'discipline', label: 'Behaviour and discipline' },
  { value: 'safety', label: 'Safety' },
  { value: 'staff', label: 'A member of staff' },
  { value: 'facilities', label: 'Building and facilities' },
  { value: 'other', label: 'Something else' },
]

export default function Concerns() {
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

  if (concerns.isLoading) return <Loading label="Looking up your concerns…" />
  if (concerns.error) return <ErrorState error={concerns.error} />

  const rows = concerns.data?.items ?? []
  const open = rows.filter((c) => c.status !== 'resolved' && c.status !== 'closed')

  return (
    <>
      <PageHead
        eyebrow="Messages"
        title="Concerns"
        description="Anything that has gone wrong, put in writing so the school can answer it."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Open" value={open.length} icon={MessageSquareWarning} />
          <Stat label="Answered" value={rows.filter((c) => c.status === 'resolved').length} />
          <Stat
            label="Longest waiting"
            value={open.length ? `${Math.max(...open.map((c) => c.open_days))} days` : '—'}
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Raise a concern"
            description="Say what happened and when. The office decides how urgent it is, so tell them the facts rather than marking it urgent."
          />
          <div className="p-4">
            <FormGrid>
              <Field label="What is it about" required>
                <Select value={category} onChange={setCategory} options={CATEGORIES} />
              </Field>
              {children.length > 0 && (
                <Field label="Which child" hint="Leave blank if it is not about one child.">
                  <Select
                    value={chosen}
                    onChange={setChosen}
                    placeholder="Not about a particular child"
                    options={childOptions(children)}
                  />
                </Field>
              )}
              <Field label="How pressing">
                <Select
                  value={priority}
                  onChange={setPriority}
                  options={[
                    { value: 'low', label: 'Whenever you can' },
                    { value: 'normal', label: 'Normal' },
                    { value: 'high', label: 'Needs attention soon' },
                  ]}
                />
              </Field>
              <Field label="In one line" required wide>
                <Input
                  value={subject}
                  onChange={setSubject}
                  placeholder="Bus has been 30 minutes late all week"
                />
              </Field>
              <Field label="What happened" required wide>
                <Textarea
                  rows={4}
                  value={body}
                  onChange={setBody}
                  placeholder="Dates, times, and who you have already spoken to."
                />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <Button
                disabled={raise.isPending || subject.trim() === '' || body.trim() === ''}
                onClick={() => raise.mutate()}
              >
                {raise.isPending ? 'Sending…' : 'Send it'}
              </Button>
            </div>
            <FormNotice
              error={raise.error}
              ok={raise.isSuccess ? 'Raised. The office can see it now.' : undefined}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Your concerns" description="Only yours — not those raised by anyone else in the family." />
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing raised"
              body="When you raise something, it stays here with the school's answer."
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
                        {CATEGORIES.find((x) => x.value === c.category)?.label ?? c.category}
                        {c.student_name && ` · ${c.student_name}`}
                        {' · raised '}
                        {formatDate(c.created_at)}
                        {c.assigned_to && ` · with ${c.assigned_to}`}
                      </div>
                    </div>
                    <Badge tone={TONE[c.status]}>{c.status.replace('_', ' ')}</Badge>
                  </div>
                  {c.resolution && (
                    <div className="mt-3 rounded-sm bg-muted px-3 py-2 text-[13px]">
                      <span className="font-medium">The school says: </span>
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
