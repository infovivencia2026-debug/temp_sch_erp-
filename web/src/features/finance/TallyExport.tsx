import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, FileWarning, History, CheckCircle2, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Field, FormGrid, Button, Checkbox, FormNotice, Loading, ErrorState,
  EmptyState, UnavailableState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { formatDate } from '@/lib/utils'
import { inr, rupees } from './ledger-lib'
import {
  tallyExportBase, tallyQk, useTallyExportSettings, useTallyMutation,
  voucherTypeLabel,
  type TallyExportCreated, type TallyRun, type TallyValidation,
} from './tally-lib'

/* The accountant's quarterly half hour.
 *
 * A date range, a voucher type filter, and a file. What makes it more than a
 * download button is the two things it refuses to let happen.
 *
 * First: Tally rejects the FILE, not the voucher. One unmapped fee head and the
 * whole import fails — after the accountant has downloaded it, opened Tally,
 * found the import screen and waited. So the validation runs before anything is
 * produced, and when it blocks it names the accounts rather than saying
 * "invalid".
 *
 * Second: there is no undo for a Tally import. The vouchers land, and removing
 * them is a manual delete of each one. "Have I already pushed March" is the
 * question somebody actually has in April, and the screen answers it from what
 * was recorded rather than asking them to remember. New vouchers only is the
 * default for exactly that reason.
 */

const VOUCHER_TYPES = [
  'receipt', 'payment', 'journal', 'contra',
  'purchase', 'sales', 'depreciation', 'opening', 'closing',
]

export default function TallyExport() {
  const toast = useToast()
  const settings = useTallyExportSettings()

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [types, setTypes] = useState<string[]>([])
  const [includeExported, setIncludeExported] = useState(false)
  const [created, setCreated] = useState<TallyExportCreated | null>(null)

  // The financial year is the sensible default and the server supplies it, so
  // the April-to-March arithmetic is not restated in the browser.
  const f = from || settings.data?.suggested_from || ''
  const t = to || settings.data?.suggested_to || ''
  const typeParam = types.join(',')

  const check = useQuery({
    queryKey: tallyQk.validate(f, t, typeParam, includeExported),
    queryFn: () =>
      api.get<TallyValidation>(
        `${tallyExportBase}/validate?from=${f}&to=${t}` +
          `&types=${encodeURIComponent(typeParam)}` +
          `&include_exported=${includeExported ? 'true' : 'false'}`,
      ),
    enabled: Boolean(f && t && settings.data?.configured),
  })

  const runs = useQuery({
    queryKey: tallyQk.runs,
    queryFn: () => api.get<{ items: TallyRun[] }>(`${tallyExportBase}/runs`),
  })

  const exportNow = useTallyMutation(
    () =>
      api.post<TallyExportCreated>(`${tallyExportBase}/export`, {
        from: f,
        to: t,
        voucher_types: types,
        include_exported: includeExported,
      }),
    (r) => {
      setCreated(r)
      toast.ok(`${r.voucher_count} voucher(s) exported. The file is ready to download.`)
    },
  )

  const confirm = useTallyMutation(
    (id: string) => api.post(`${tallyExportBase}/runs/${id}/confirm`),
    () => toast.ok('Recorded as imported into Tally.'),
  )

  if (settings.isLoading) return <Loading label="Reading the connector…" />
  if (settings.error) return <ErrorState error={settings.error} />

  const s = settings.data

  /* Nothing configured is not an error, it is a different screen. An export
     button offered before the mapping exists is a button that produces a file
     Tally refuses. */
  if (!s?.configured) {
    return (
      <>
        <PageHead
          eyebrow="Accounting"
          title="Tally Prime XML export"
          description="Export vouchers in the XML format Tally Prime imports."
          width="wide"
        />
        <PageBody width="wide">
          <UnavailableState
            title="The Tally connector has not been set up for this school"
            body="Exporting needs the Tally company name and this school's chart of accounts mapped onto the ledger names your Tally company already uses. That is done once, on the Tally ERP / Prime connector screen under Platform Setup. Ask whoever administers the installation."
            technical={[
              { label: 'Accounts still unmapped', value: String(s?.unmapped_accounts ?? 0) },
              { label: 'Tally company', value: s?.settings.company_name || 'not set' },
            ]}
          />
        </PageBody>
      </>
    )
  }

  const v = check.data
  const blocked = Boolean(v && !v.ok)

  return (
    <>
      <PageHead
        eyebrow="Accounting"
        title="Tally Prime XML export"
        description={`Vouchers for ${s.settings.company_name}, in the envelope Tally Prime imports. The file is checked before it is produced: Tally rejects a whole import for one unmapped ledger.`}
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={3}>
          <Stat
            label="Vouchers in this period"
            value={v ? String(v.voucher_count) : '—'}
            icon={Download}
            hint={includeExported ? 'Including ones exported before' : 'New since the last export'}
          />
          <Stat
            label="Value"
            value={v ? inr(v.total_paise) : '—'}
            hint="Debit total, which is what the batch is worth"
          />
          <Stat
            label="Already exported"
            value={v ? String(v.already_exported) : '—'}
            icon={History}
            delta={
              v && v.already_exported > 0
                ? { value: 'A duplicate import is undone one voucher at a time', positive: false }
                : { value: 'None of these have gone out', positive: true }
            }
          />
        </CellGrid>

        {/* Said plainly, from the server. The product does not have a live push
            and this screen does not imply one. */}
        <Card>
          <CardHeader
            title="This produces a file you import in Tally"
            description={s.live_push_note}
            action={<Badge tone="warning">No direct push</Badge>}
          />
        </Card>

        <Card>
          <CardHeader
            title="The period"
            description={`Defaults to the financial year ${s.fy_label}. Leave the voucher types unticked for all of them.`}
          />
          <FormGrid>
            <Field label="From">
              <input
                type="date"
                className="field"
                value={f}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="To">
              <input
                type="date"
                className="field"
                value={t}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Field label="Voucher types" wide hint="All types when nothing is ticked.">
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {VOUCHER_TYPES.map((k) => (
                  <Checkbox
                    key={k}
                    checked={types.includes(k)}
                    onChange={(on) =>
                      setTypes((cur) => (on ? [...cur, k] : cur.filter((x) => x !== k)))
                    }
                    label={voucherTypeLabel(k)}
                  />
                ))}
              </div>
            </Field>
            <Field label="Already exported vouchers" wide>
              <Checkbox
                checked={includeExported}
                onChange={setIncludeExported}
                label="Include vouchers that have been exported before"
                hint="Off by default. Importing the same voucher into Tally twice has to be undone by deleting each one."
              />
            </Field>
          </FormGrid>
        </Card>

        {check.isLoading && <Loading label="Checking the period…" />}
        {check.error && <ErrorState error={check.error} />}

        {v && blocked && <Blocked v={v} />}

        {v && !blocked && (
          <Card>
            <CardHeader
              title="Ready to export"
              description={`${v.voucher_count} voucher(s) worth ${inr(v.total_paise)}, from ${formatDate(v.from_date)} to ${formatDate(v.to_date)}, into the Tally company "${v.company_name}".`}
            />
            {v.warnings.map((wmsg) => (
              <p key={wmsg} className="flex items-start gap-2 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {wmsg}
              </p>
            ))}
            {v.overlapping_runs.length > 0 && (
              <p className="text-sm text-muted-foreground">
                This range overlaps {v.overlapping_runs.length} earlier export(s) — the most recent
                was {formatDate(v.overlapping_runs[0].exported_at)}, covering{' '}
                {formatDate(v.overlapping_runs[0].from_date)} to{' '}
                {formatDate(v.overlapping_runs[0].to_date)}.
              </p>
            )}
            <FormNotice error={exportNow.error} />
            <Button
              onClick={() => exportNow.mutate(undefined as never)}
              disabled={exportNow.isPending}
            >
              <Download className="h-3.5 w-3.5" />
              Export {v.voucher_count} voucher(s)
            </Button>
          </Card>
        )}

        {created && (
          <Card>
            <CardHeader
              title="The file is ready"
              description={created.note}
              action={<Badge tone="success">Recorded</Badge>}
            />
            {/* A plain anchor rather than a fetch-and-blob: the browser streams
                the file straight to disk, and the session cookie goes with it.
                The GET is idempotent, so downloading it again does not record a
                second export. */}
            <a href={created.download_url} download>
              <Button>
                <Download className="h-3.5 w-3.5" />
                Download the XML
              </Button>
            </a>
          </Card>
        )}

        <Runs
          runs={runs.data?.items ?? []}
          loading={runs.isLoading}
          error={runs.error}
          onConfirm={(id) => confirm.mutate(id)}
        />
      </PageBody>
    </>
  )
}

/* Why the export is refused, and what to do about it.
 *
 * The list is the answer. "Export failed" sends somebody to support; nine named
 * accounts, busiest first, sends them to the connector screen with a job that
 * takes ten minutes.
 */
function Blocked({ v }: { v: TallyValidation }) {
  return (
    <Card>
      <CardHeader
        title="This period cannot be exported yet"
        description="Tally rejects an entire import for one unmapped ledger, so the file is not produced until every account below has a Tally name against it."
        action={<Badge tone="danger">Blocked</Badge>}
      />
      {v.blocking.map((b) => (
        <p key={b} className="flex items-start gap-2 text-sm">
          <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          {b}
        </p>
      ))}

      {v.unmapped_accounts.length > 0 && (
        <Table
          head={['Code', 'Account', { label: 'Vouchers blocked', align: 'right' }]}
          empty={false}
        >
          {v.unmapped_accounts.map((a) => (
            <tr key={a.account_id}>
              <Td className="tabular-nums text-muted-foreground">{a.code}</Td>
              <Td className="font-medium">{a.name}</Td>
              <Td className="text-right tabular-nums">{a.vouchers}</Td>
            </tr>
          ))}
        </Table>
      )}

      {v.unmapped_voucher_types.length > 0 && (
        <Table head={['Voucher type', { label: 'Vouchers blocked', align: 'right' }]} empty={false}>
          {v.unmapped_voucher_types.map((tt) => (
            <tr key={tt.voucher_type}>
              <Td className="font-medium">{voucherTypeLabel(tt.voucher_type)}</Td>
              <Td className="text-right tabular-nums">{tt.vouchers}</Td>
            </tr>
          ))}
        </Table>
      )}

      <p className="text-sm text-muted-foreground">
        Mapping is done on the Tally ERP / Prime connector screen under Platform Setup.
      </p>
    </Card>
  )
}

/* What has gone out, and when.
 *
 * The register that answers "have I already pushed March". Confirming is the
 * accountant saying the file reached Tally — the product cannot observe an
 * import that happens in another application on another machine, and pretending
 * to would be worse than asking.
 */
function Runs({
  runs, loading, error, onConfirm,
}: {
  runs: TallyRun[]
  loading: boolean
  error: unknown
  onConfirm: (id: string) => void
}) {
  if (loading) return <Loading label="Reading the export history…" />
  if (error) return <ErrorState error={error} />

  return (
    <Card>
      <CardHeader
        title="Exports so far"
        description="Every file this school has produced. A voucher already in Tally is painful to remove, so this is the record that stops it being sent twice."
      />
      {runs.length === 0 ? (
        <EmptyState
          title="Nothing has been exported yet"
          body="The first export will be listed here with its period and voucher count."
        />
      ) : (
        <Table
          head={[
            'Period',
            'Types',
            { label: 'Vouchers', align: 'right' },
            { label: 'Value', align: 'right' },
            'Exported',
            'Imported',
            '',
          ]}
          empty={false}
        >
          {runs.map((r) => (
            <tr key={r.id}>
              <Td className="font-medium">
                {formatDate(r.from_date)} – {formatDate(r.to_date)}
              </Td>
              <Td className="text-muted-foreground">
                {r.voucher_types.length === 0
                  ? 'All'
                  : r.voucher_types.map(voucherTypeLabel).join(', ')}
              </Td>
              <Td className="text-right tabular-nums">{r.voucher_count}</Td>
              <Td className="text-right tabular-nums">{rupees(r.total_paise)}</Td>
              <Td className="text-muted-foreground">
                {formatDate(r.exported_at)}
                {r.exported_by ? ` · ${r.exported_by}` : ''}
              </Td>
              <Td>
                {r.confirmed_at ? (
                  <Badge tone="success">{formatDate(r.confirmed_at)}</Badge>
                ) : (
                  <Badge tone="neutral">Not confirmed</Badge>
                )}
              </Td>
              <Td className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <a href={`${tallyExportBase}/runs/${r.id}/file`} download>
                    <Button variant="ghost" size="sm">
                      <Download className="h-3.5 w-3.5" />
                      File
                    </Button>
                  </a>
                  {!r.confirmed_at && (
                    <Button variant="ghost" size="sm" onClick={() => onConfirm(r.id)}>
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Mark imported
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
