import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquarePlus } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Badge, Button, Field, FormGrid,
  FormNotice, Select, Textarea, Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'

/* Remarks about staff — one screen, read differently by whoever opens it.
 *
 * A teacher sees what has been written about them and cannot write. A head of
 * department, a principal or a parent sees the same list plus a form, and the
 * server decides which of the three they are: a client that names its own
 * authority is a client that can claim to be the principal.
 *
 * Four catalogue entries — Remarks, Class Teacher Remarks, Staff remarks,
 * Teacher remarks — all opened screens reading the *student* remarks table, so
 * a HOD looking for "teacher remarks" was shown what teachers had written
 * about children, and the other direction could not be recorded at all. This
 * is that direction, and it is one screen rather than four.
 *
 * Nothing here is private. A record about somebody that they cannot see is a
 * file kept on them, which is a different thing from feedback.
 */

interface Remark {
  id: string
  subject_user_id: string
  subject_name: string
  author_name: string
  author_role: string
  kind: string
  body: string
  observed_on: string
  student_name?: string
  mine: boolean
}

interface Teacher {
  user_id: string
  full_name: string
  subject?: string
  relation: string
}

const TONE: Record<string, 'success' | 'danger' | 'info' | 'neutral'> = {
  commendation: 'success',
  concern: 'danger',
  appraisal: 'info',
  feedback: 'neutral',
}

export default function StaffRemarks({ canWrite = true }: { canWrite?: boolean }) {
  const qc = useQueryClient()
  const [composing, setComposing] = useState(false)

  const list = useQuery({
    queryKey: ['staff-remarks'],
    queryFn: () => api.get<List<Remark>>('/api/v1/staff-remarks'),
  })

  /* Whether a form can be offered at all. The endpoint answers 403 for
     somebody with nobody to write about, and asking it once here is how the
     button knows not to appear — rather than appearing and failing when it is
     pressed. */
  const teachers = useQuery({
    queryKey: ['remarkable-teachers'],
    queryFn: () => api.get<List<Teacher>>('/api/v1/staff-remarks/teachers'),
    enabled: canWrite,
    retry: false,
  })

  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorState error={list.error} />

  const rows = list.data?.items ?? []
  const mayWrite = canWrite && (teachers.data?.items?.length ?? 0) > 0

  return (
    <>
      <PageHead
        eyebrow="Staff"
        title={canWrite ? 'Teacher remarks' : 'Remarks about me'}
        description={
          canWrite
            ? 'What has been written about the school’s teachers, and a place to add one. The teacher is told, and always sees it.'
            : 'What your head of department, the principal or a parent has written about your work.'
        }
        actions={
          mayWrite && (
            <Button onClick={() => setComposing((c) => !c)}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
              {composing ? 'Close' : 'Write a remark'}
            </Button>
          )
        }
      />
      <PageBody>
        {composing && (
          <Compose
            teachers={teachers.data?.items ?? []}
            onDone={() => {
              setComposing(false)
              qc.invalidateQueries({ queryKey: ['staff-remarks'] })
            }}
          />
        )}

        <Card>
          <CardHeader title="Remarks" description={`${rows.length} in the record`} />
          {rows.length === 0 ? (
            <EmptyState
              title={canWrite ? 'Nothing written yet' : 'Nothing has been written about you'}
              body={
                canWrite
                  ? 'A remark you write reaches the teacher the same day, and stays here.'
                  : 'When your head of department, the principal or a parent writes something, it appears here and you are told.'
              }
            />
          ) : (
            <ul className="divide-y">
              {rows.map((x) => (
                <li key={x.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Badge tone={TONE[x.kind] ?? 'neutral'}>{x.kind}</Badge>
                    {canWrite && <span className="font-medium">{x.subject_name}</span>}
                    <span className="text-[13px] text-muted-foreground">
                      {formatDate(x.observed_on)} · {x.mine ? 'you' : x.author_name} (
                      {x.author_role})
                    </span>
                    {x.student_name && (
                      <span className="text-[13px] text-muted-foreground">
                        · about {x.student_name}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[14px]">{x.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}

function Compose({ teachers, onDone }: { teachers: Teacher[]; onDone: () => void }) {
  const [subject, setSubject] = useState('')
  const [kind, setKind] = useState('feedback')
  const [body, setBody] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/staff-remarks', {
        subject_user_id: subject,
        kind,
        body,
      }),
    onSuccess: onDone,
  })

  return (
    <Card>
      <CardHeader
        title="Write a remark"
        description="The teacher is told, and reads it. There is no private option, on purpose."
      />
      <form
        className="px-5 pb-5"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <FormGrid>
          <Field label="About" required>
            <Select
              value={subject}
              onChange={setSubject}
              placeholder="Choose a teacher"
              options={teachers.map((t) => ({
                value: t.user_id,
                label: t.subject
                  ? `${t.full_name} — ${t.subject} (${t.relation})`
                  : `${t.full_name} (${t.relation})`,
              }))}
            />
          </Field>
          <Field label="Kind">
            <Select
              value={kind}
              onChange={setKind}
              options={[
                { value: 'feedback', label: 'Feedback' },
                { value: 'commendation', label: 'Commendation' },
                { value: 'concern', label: 'Concern' },
                { value: 'appraisal', label: 'Appraisal note' },
              ]}
            />
          </Field>
          <Field label="Remark" required wide>
            <Textarea
              value={body}
              onChange={setBody}
              rows={3}
              placeholder="What you saw, and when."
            />
          </Field>
        </FormGrid>
        <FormNotice error={save.error} />
        <div className="mt-3 flex items-center gap-2">
          <Button type="submit" disabled={!subject || !body.trim() || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save remark'}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
