import { useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleDashed, CircleDot } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge,
  Loading, EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'

/* Where is my admission, and is it my turn.

   Between the enquiry and the offer a family could see nothing at all: whether
   the form arrived, whether the documents were accepted, whether a seat had
   been decided. The only way to find out was to ring the office, which during
   an admissions season is most of what the front desk's line carries — and the
   answer given is read off a screen the parent could have read themselves.

   Built as a line of steps rather than a status word. "under_review" is the
   product's vocabulary, not a parent's, and eleven such states rendered
   literally is a page that needs explaining. Five steps, one of them marked
   as where you are, does not.

   The next action is the point of the page. It appears only when the family
   can actually do something — fill the form, send a missing document, come in
   to confirm a seat. While the school is deciding there is nothing useful to
   tell a parent to do, and inventing something ("check back regularly") is how
   a status page turns into noise. */

interface Step {
  key: string
  label: string
  status: 'done' | 'current' | 'pending'
  on?: string
  note?: string
}

interface Doc {
  doc_type: string
  required: boolean
  uploaded: boolean
  verified: boolean
}

interface Admission {
  enquiry_id: string
  /* Empty for an enquiry with no application yet, and enquiry_id is empty for
     an application taken at the counter — so the key is whichever of the two
     this admission has. One of them is always present. */
  application_id?: string
  student_name: string
  class_sought?: string
  enquired_on: string
  application_no?: string
  status: string
  next_action?: string
  apply_url?: string
  steps: Step[]
  documents: Doc[]
}

const STEP_ICON = {
  done: CircleCheck,
  current: CircleDot,
  pending: CircleDashed,
} as const

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((s) => {
        const Icon = STEP_ICON[s.status]
        return (
          <li key={s.key} className="flex items-start gap-3">
            <Icon
              className={
                s.status === 'done'
                  ? 'mt-0.5 size-5 shrink-0 text-emerald-600'
                  : s.status === 'current'
                    ? 'mt-0.5 size-5 shrink-0 text-sky-600'
                    : 'mt-0.5 size-5 shrink-0 text-muted-foreground/50'
              }
            />
            <div className="min-w-0">
              <div
                className={
                  s.status === 'pending'
                    ? 'text-sm text-muted-foreground'
                    : 'text-sm font-medium'
                }
              >
                {s.label}
              </div>
              {/* The date only where the step actually happened. A date on a
                  step that has not been reached would read as an appointment
                  the school has not made. */}
              {s.on ? (
                <div className="text-xs text-muted-foreground">{formatDate(s.on)}</div>
              ) : null}
              {s.note ? <div className="mt-0.5 text-xs">{s.note}</div> : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export default function AdmissionStatus() {
  const t = useT()
  const q = useQuery({
    queryKey: ['portal-admission'],
    queryFn: () => api.get<List<Admission>>('/api/v1/portal/admission'),
  })

  if (q.isLoading) return <Loading label={t('portal.admission.loading')} />
  if (q.error) return <ScreenError error={q.error} />

  const rows = q.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow={t('portal.admission.eyebrow')}
        title={t('portal.admission.title')}
        description={t('portal.admission.description')}
      />
      <PageBody>
        {rows.length === 0 ? (
          /* An enrolled family reaching this page is the ordinary case, not a
             mistake — their admission finished. Say so rather than showing an
             error. */
          <EmptyState
            title={t('portal.admission.empty_title')}
            body={t('portal.admission.empty_description')}
          />
        ) : null}

        {rows.map((a) => (
          <Card key={a.application_id || a.enquiry_id}>
            <CardHeader
              title={a.student_name}
              description={
                a.class_sought
                  ? `${t('portal.admission.class_sought')}: ${a.class_sought}`
                  : undefined
              }
              action={a.application_no ? <Badge>{a.application_no}</Badge> : null}
            />

            {a.next_action ? (
              <div className="mx-4 mb-4 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm dark:border-sky-900 dark:bg-sky-950">
                <div className="font-medium">{t('portal.admission.next_action')}</div>
                <div className="mt-0.5">{a.next_action}</div>
                {a.apply_url ? (
                  <a
                    className="mt-2 inline-block underline"
                    href={a.apply_url}
                    rel="noreferrer"
                  >
                    {t('portal.admission.open_form')}
                  </a>
                ) : null}
              </div>
            ) : null}

            <div className="px-4 pb-4">
              <Steps steps={a.steps} />
            </div>

            {a.documents.length > 0 ? (
              <Table
                head={[
                  t('portal.admission.col_document'),
                  t('portal.admission.col_needed'),
                  t('portal.admission.col_state'),
                ]}
              >
                {a.documents.map((d) => (
                  <tr key={d.doc_type}>
                    <Td>{d.doc_type}</Td>
                    <Td>
                      {d.required
                        ? t('portal.admission.doc_required')
                        : t('portal.admission.doc_optional')}
                    </Td>
                    <Td>
                      {d.verified ? (
                        <Badge tone="success">{t('portal.admission.doc_checked')}</Badge>
                      ) : d.uploaded ? (
                        <Badge>{t('portal.admission.doc_with_school')}</Badge>
                      ) : (
                        <Badge tone="warning">{t('portal.admission.doc_awaited')}</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            ) : null}
          </Card>
        ))}
      </PageBody>
    </>
  )
}
