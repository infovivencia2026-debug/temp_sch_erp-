import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Button, Loading, ErrorState,
} from '@/components/ui'

/* Everything this account may take out of the system, in one place.
 *
 * The export endpoint is permission-filtered server-side: it returns only the
 * datasets the caller's grants allow, so a class teacher sees students and a
 * finance clerk sees the fee ledger, from the same screen and the same URL.
 * That is why this is one page rather than a download button hidden on each
 * module -- the answer to "what can I get out of this" should not require
 * visiting eleven screens to discover.
 *
 * Downloads go straight to the CSV endpoint rather than through fetch: the
 * browser handles the file, the session cookie goes with it, and nothing has
 * to buffer a large export in memory to hand it back as a blob.
 */

interface ExportSpec {
  name: string
  /* What a school calls it. The names used to live here, in a map covering
   * three of the thirteen datasets — so the other ten showed a URL slug,
   * "staff-attendance", to somebody choosing what to send their trustee. They
   * now come from the server beside the query each one runs, which is the only
   * place that cannot fall out of step with the list. */
  title?: string
  about?: string
  url: string
  columns: string[]
}


export default function Exports() {
  const q = useQuery({
    queryKey: ['exports'],
    queryFn: () => api.get<List<ExportSpec>>('/api/v1/export'),
  })

  const items = q.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Reports"
        title="Data exports"
        description="Download any dataset your role permits as CSV. The list below is filtered to what you may take out."
      />
      <PageBody width="form">
        <Card>
          <CardHeader
            title="Available exports"
            description={items.length ? `${items.length} datasets` : undefined}
          />
          {q.isLoading ? (
            <Loading />
          ) : q.error ? (
            <ErrorState error={q.error} />
          ) : (
            <Table
              head={['Dataset', 'Columns', '']}
              empty={!items.length}
              emptyLabel="Your role does not permit any export."
            >
              {items.map((x) => {
                const label = { title: x.title ?? x.name, blurb: x.about ?? '' }
                return (
                  <tr key={x.name}>
                    <Td className="font-medium">
                      {label.title}
                      {label.blurb && (
                        <span className="block text-[12.5px] font-normal text-muted-foreground">
                          {label.blurb}
                        </span>
                      )}
                    </Td>
                    <Td className="text-[12.5px] text-muted-foreground">
                      {x.columns.length} columns
                      <span className="block max-w-[42ch] truncate">{x.columns.join(', ')}</span>
                    </Td>
                    <Td>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          window.location.href = x.url
                        }}
                      >
                        <Download className="h-3.5 w-3.5" /> CSV
                      </Button>
                    </Td>
                  </tr>
                )
              })}
            </Table>
          )}
        </Card>

        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          Exports carry the same scope as the screens: a teacher's student export contains their own
          sections, an administrator's contains the school. Every download is recorded in the audit
          log against your account.
        </p>
      </PageBody>
    </>
  )
}
