import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type List } from '@/lib/api'
import { Button, ErrorState } from '@/components/ui'
import { printDocument } from '@/lib/print'

/* THE FORM AS THE FAMILY FILLED IT IN.

   Every answer the online or counter form captured, section by section, from
   GET /admissions/applications/{id}/answers. Shown on request rather than
   always: most days the ladder above is what the desk needs, and the whole
   form is what a principal or an inspector asks to see on paper. "Print"
   builds the school's letterhead sheet from exactly what is on screen. */

interface Answer {
  section: string
  code: string
  label: string
  field_type: string
  value: string
  file_id?: string
  external_url?: string
}

export default function ApplicationAnswers({ applicationId, applicationNo, name }: {
  applicationId: string
  applicationNo: string
  name: string
}) {
  const [show, setShow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const q = useQuery({
    queryKey: ['application-answers', applicationId],
    queryFn: () => api.get<List<Answer>>(`/api/v1/admissions/applications/${applicationId}/answers`),
    enabled: show,
  })
  const items = q.data?.items ?? []
  const sections: [string, Answer[]][] = []
  for (const a of items) {
    const last = sections[sections.length - 1]
    if (last && last[0] === a.section) last[1].push(a)
    else sections.push([a.section, [a]])
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="eyebrow mr-auto">Application form</p>
        <Button size="sm" variant="secondary" onClick={() => setShow((v) => !v)}>
          {show ? 'Hide answers' : 'Show answers'}
        </Button>
        {show && items.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => printDocument({ source: ref.current, title: `Application form: ${name}`, docNo: applicationNo })}
          >
            Print
          </Button>
        )}
      </div>
      {show && (
        q.isLoading ? (
          <p className="mt-2 text-[13px] text-muted-foreground">Reading the form…</p>
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : items.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            No form answers are recorded for this application. It was taken down at the desk without the online form.
          </p>
        ) : (
          <div ref={ref} className="mt-3 flex flex-col gap-4">
            {sections.map(([title, rows]) => (
              <section key={title}>
                <h3 className="mb-1 text-[13px] font-semibold">{title}</h3>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[minmax(0,14rem)_1fr]">
                  {rows.map((r) => (
                    <div key={r.code} className="contents">
                      <dt className="text-muted-foreground">{r.label}</dt>
                      <dd>
                        {r.value ||
                          (r.external_url ? r.external_url : r.file_id ? 'File attached' : '-')}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        )
      )}
    </div>
  )
}
