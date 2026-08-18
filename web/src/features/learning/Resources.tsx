import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FolderOpen, Link2, FileText } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Select, Field,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Resource {
  id: string
  title: string
  description?: string
  kind: string
  subject?: string
  external_url?: string
  file_id?: string
  uploaded_by?: string
  posted_on: string
}

const KINDS = [
  { value: '', label: 'Everything' },
  { value: 'note', label: 'Notes' },
  { value: 'worksheet', label: 'Worksheets' },
  { value: 'reference', label: 'Reference' },
  { value: 'video', label: 'Video' },
  { value: 'link', label: 'Links' },
  { value: 'syllabus', label: 'Syllabus' },
]

const TONE: Record<string, 'info' | 'success' | 'warning' | 'neutral' | 'primary'> = {
  note: 'info',
  worksheet: 'warning',
  reference: 'neutral',
  video: 'primary',
  link: 'neutral',
  syllabus: 'success',
}

/* Everything the teachers have posted that this child can open.

   Three widths of audience end up here and all three are theirs: posted to
   their own section, posted against a subject their class is taught, and
   posted to the whole school. Filtering to the first alone left the hub empty
   in a school whose teachers file by subject, which is most of them. */
export default function Resources() {
  const { children, studentId, chosen, setChosen } = useChildren()
  const [kind, setKind] = useState('')
  const ready = readyFor(children, studentId)

  const resources = useQuery({
    queryKey: ['learning-resources', studentId, kind],
    queryFn: () =>
      api.get<List<Resource>>(
        `/api/v1/portal/learning/resources${studentQuery(studentId, kind ? `kind=${kind}` : '')}`,
      ),
    enabled: ready,
  })

  if (resources.isLoading && ready) return <Loading label="Fetching your resources…" />
  if (resources.error) return <ErrorState error={resources.error} />

  const rows = resources.data?.items ?? []
  const subjects = new Set(rows.map((r) => r.subject).filter(Boolean))
  const links = rows.filter((r) => r.external_url).length

  return (
    <>
      <PageHead
        eyebrow="Learning"
        title="Resource hub"
        description="Notes, worksheets and reading your teachers have shared with your class."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState
            title="Choose a child"
            body="Resources follow the class, so the list is different for each child."
          />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat label="Items shared" value={rows.length} icon={FolderOpen} />
              <Stat label="Subjects covered" value={subjects.size} icon={FileText} />
              <Stat label="Links out" value={links} icon={Link2} />
            </CellGrid>

            <Card>
              <CardHeader
                title="Shared with you"
                description="Newest first. Anything without a subject was posted to the whole school."
                action={
                  <div className="w-52">
                    <Field label="Kind">
                      <Select value={kind} onChange={setKind} options={KINDS} />
                    </Field>
                  </div>
                }
              />
              {rows.length === 0 ? (
                <EmptyState
                  title="Nothing shared yet"
                  body="When a teacher posts notes or a worksheet for your class it appears here."
                />
              ) : (
                <ul className="divide-y">
                  {rows.map((r) => (
                    <li key={r.id} className="px-5 py-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium">
                            {r.external_url ? (
                              <a
                                href={r.external_url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="underline underline-offset-2 hover:text-primary"
                              >
                                {r.title}
                              </a>
                            ) : (
                              r.title
                            )}
                          </p>
                          {r.description && (
                            <p className="mt-1 text-[13px] text-muted-foreground">
                              {r.description}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          <Badge tone={TONE[r.kind] ?? 'neutral'}>{r.kind}</Badge>
                          {r.subject ? (
                            <Badge>{r.subject}</Badge>
                          ) : (
                            <Badge>Whole school</Badge>
                          )}
                        </div>
                      </div>
                      <p className="mt-2 text-[12.5px] text-muted-foreground">
                        {formatDate(r.posted_on)}
                        {r.uploaded_by ? ` · ${r.uploaded_by}` : ''}
                        {r.file_id && !r.external_url ? ' · file attached' : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
