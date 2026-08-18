import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link2, ListChecks, ServerOff, Building2 } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Input, Select, Checkbox, Field, FormGrid, Button, FormNotice,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import { useToast } from '@/components/Toast'
import { fyOptions, fyLabel, currentFY } from './ledger-lib'
import {
  tallyConnectorBase, tallyQk, useTallyConnector, useTallyMutation,
  voucherTypeLabel,
  type TallyAccount, type TallyGateway, type TallyVoucherType,
} from './tally-lib'

/* Mapping this school's books onto the Tally company its auditor already reads.
 *
 * The two vocabularies do not agree and there is no reason they should. This
 * product calls it "4100 Tuition Fee Income" because that is what the fee
 * module posts to; the school's Tally has had a ledger called "Tuition Fees
 * A/c" since 2013, and the auditor knows it by that name. Nothing here guesses
 * the correspondence, because an automatic mapping would silently create a
 * hundred new ledgers in Tally on first import — all plausible, none matching
 * the ones already there — and the school's opening balances would sit in the
 * old ledgers while the year's postings went to the new.
 *
 * The screen is ordered by how much each account matters rather than by code.
 * A chart of accounts has a hundred leaves and six of them carry the term's fee
 * receipts; the one blocking two hundred vouchers belongs above the one
 * blocking none, because that is the order somebody with twenty minutes should
 * work in.
 *
 * The bar across the top says plainly that there is no live push. Tally Prime
 * has no cloud API — its gateway is a listener the accountant's own machine
 * opens on the school LAN while Tally is running — and a screen that implied
 * otherwise would be the kind of promise a school discovers at the worst
 * moment.
 */

export default function TallyConnector() {
  /* platform.tenants.write throughout (tally.go:113). institution_admin holds
     every other key in this product and deliberately not this one, which is
     what keeps a school out of the gateway address — so a school administrator
     who reaches this screen must not be shown its Save buttons. */
  const can = useCan()
  const mayConfigure = can('platform.tenants.write')
  const toast = useToast()
  const conn = useTallyConnector()

  const [company, setCompany] = useState('')
  const [fy, setFy] = useState(String(currentFY()))
  const [enabled, setEnabled] = useState(false)

  // Seeded from the server once loaded, then left to the operator. A useEffect
  // keyed on the fetched value rather than a defaultValue, so a save elsewhere
  // is reflected instead of being overwritten by a stale form.
  const loaded = conn.data?.settings
  useEffect(() => {
    if (!loaded) return
    setCompany(loaded.company_name ?? '')
    setFy(String(loaded.default_fy_start_year ?? currentFY()))
    setEnabled(loaded.is_enabled)
  }, [loaded])

  const saveSettings = useTallyMutation(
    () =>
      api.put(tallyConnectorBase, {
        company_name: company,
        default_fy_start_year: Number(fy),
        delivery: 'file',
        is_enabled: enabled,
      }),
    () => toast.ok('The Tally connector was saved.'),
  )

  if (conn.isLoading) return <Loading label="Reading the connector…" />
  if (conn.error) return <ErrorState error={conn.error} />

  const c = conn.data
  const unmapped = c?.unmapped_accounts ?? 0
  const ready = unmapped === 0 && (c?.settings.company_name ?? '') !== ''

  return (
    <>
      <PageHead
        eyebrow="Platform Setup"
        title="Tally ERP / Prime connector"
        description="Map this school's chart of accounts onto the ledger names its Tally company already uses. Until every account a voucher touches is mapped, an export produces a file Tally refuses."
        width="wide"
      />
      <PageBody width="wide">
        <CellGrid cols={3}>
          <Stat
            label="Accounts mapped"
            value={`${c?.mapped_accounts ?? 0} of ${c?.postable_accounts ?? 0}`}
            icon={Link2}
            delta={
              unmapped
                ? { value: `${unmapped} still to map`, positive: false }
                : { value: 'Every postable account is mapped', positive: true }
            }
          />
          <Stat
            label="Tally company"
            value={c?.settings.company_name || '—'}
            icon={Building2}
            hint="Vouchers import into this company and no other"
          />
          <Stat
            label="Connector"
            value={ready && c?.settings.is_enabled ? 'Ready' : 'Not ready'}
            icon={ListChecks}
            hint={ready ? 'The export screen may produce a file' : 'Finish the mapping first'}
          />
        </CellGrid>

        {/* Stated once, prominently, and taken from the server rather than
            hardcoded here — whether a live push exists is a fact about the
            deployment, not a label a screen gets to choose. */}
        <Card>
          <CardHeader
            title="There is no direct push to Tally"
            description={c?.live_push_note}
            action={<Badge tone="warning">File export only</Badge>}
          />
        </Card>

        <Card>
          <CardHeader
            title="The company and the year"
            description="The company name must match the one in Tally exactly. An import that names no company lands in whichever company happens to be open, which is how one school's fees end up in another's books."
          />
          <div className="space-y-4 p-5">
          <FormGrid>
            <Field label="Tally company name" required hint="As it appears in Tally's company list.">
              <Input value={company} onChange={setCompany} placeholder="Sri Sai Vidya Niketan" />
            </Field>
            <Field label="Financial year" hint="April to March. The export defaults to this year.">
              <Select value={fy} onChange={setFy} options={fyOptions()} />
            </Field>
            <Field label="Enabled" wide>
              <Checkbox
                checked={enabled}
                onChange={setEnabled}
                label="The accountant may export to Tally"
                hint="Leave off until the mapping below is complete."
              />
            </Field>
          </FormGrid>
          <FormNotice error={saveSettings.error} ok={saveSettings.isSuccess ? 'Saved.' : undefined} />
          <Button
            onClick={() => saveSettings.mutate(undefined as never)}
            disabled={!mayConfigure || saveSettings.isPending}
          >
            Save the connector
          </Button>
          </div>
        </Card>

        <VoucherTypes types={c?.voucher_types ?? []} erpTypes={c?.erp_voucher_types ?? []} />
        {/* Keyed by the year. The half-typed mapping is a draft against the
            chart of accounts on screen; changing the year refetched that chart
            but kept the draft, and Save posts the whole draft — so names typed
            against one year's accounts were written while looking at another's.
            Resetting on the year is the same rule the rest of the app uses for
            a form whose subject has been swapped. */}
        <LedgerMapping key={fy} fy={fy} />
        <Gateway />
      </PageBody>
    </>
  )
}

/* The voucher type map.
 *
 * Mostly one-to-one and mostly identical, which is exactly why it is editable:
 * the names that differ are the ones that matter. A school that renamed
 * "Receipt" to "Fee Receipt" in Tally — ordinary, so the daybook reads sensibly
 * — would otherwise get every receipt rejected, with an error naming the
 * voucher type rather than explaining it.
 *
 * Depreciation, opening and closing have no Tally equivalent at all. They are
 * Journals there, which is said here once rather than left for somebody to
 * rediscover.
 */
function VoucherTypes({ types, erpTypes }: { types: TallyVoucherType[]; erpTypes: string[] }) {
  const mayConfigure = useCan()('platform.tenants.write')
  const toast = useToast()
  const [draft, setDraft] = useState<Record<string, string>>({})

  const current = useMemo(() => {
    const m: Record<string, string> = {}
    for (const t of types) m[t.voucher_type] = t.tally_voucher_type
    return m
  }, [types])

  const value = (k: string) => draft[k] ?? current[k] ?? ''

  const save = useTallyMutation(
    () =>
      api.put(`${tallyConnectorBase}/voucher-types`, {
        voucher_types: erpTypes.map((k) => ({
          voucher_type: k,
          tally_voucher_type: value(k),
        })),
      }),
    () => {
      setDraft({})
      toast.ok('Voucher types saved.')
    },
  )

  const seed = useTallyMutation(
    () => api.post<{ added: number }>(`${tallyConnectorBase}/voucher-types/defaults`),
    (r) =>
      toast.ok(
        r.added ? `${r.added} standard voucher type(s) added.` : 'Every voucher type was already mapped.',
      ),
  )

  const missing = erpTypes.filter((k) => !value(k)).length

  return (
    <Card>
      <CardHeader
        title="Voucher types"
        description="This ERP's voucher types against Tally's. Depreciation, opening and closing entries are Journals in Tally — it has no separate type for them."
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => seed.mutate(undefined as never)}
            disabled={!mayConfigure || seed.isPending}
          >
            Apply the standard types
          </Button>
        }
      />
      <Table head={['This ERP', 'Tally voucher type', { label: 'Status', align: 'right' }]} empty={false}>
        {erpTypes.map((k) => (
          <tr key={k}>
            <Td className="font-medium">{voucherTypeLabel(k)}</Td>
            <Td>
              <Input
                value={value(k)}
                onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
                placeholder="Journal"
              />
            </Td>
            <Td className="text-right">
              {value(k) ? (
                <Badge tone="success">Mapped</Badge>
              ) : (
                <Badge tone="danger">Unmapped</Badge>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <div className="space-y-3 p-5">
      <FormNotice error={save.error ?? seed.error} ok={save.isSuccess ? 'Saved.' : undefined} />
      <div className="flex items-center gap-3">
        <Button
          onClick={() => save.mutate(undefined as never)}
          disabled={!mayConfigure || save.isPending}
        >
          Save voucher types
        </Button>
        {missing > 0 && (
          <span className="text-sm text-muted-foreground">
            {missing} unmapped. A voucher of an unmapped type blocks the whole export.
          </span>
        )}
      </div>
      </div>
    </Card>
  )
}

/* The mapping workbench.
 *
 * Sorted by traffic, not by code: the account carrying two hundred vouchers is
 * the one to fix first, and a screen sorted by code buries it among the ones
 * nobody posts to. Group headings are absent because they cannot be posted to
 * at all — asking somebody to map "Assets" would be busywork that then reads as
 * a permanently incomplete mapping.
 */
function LedgerMapping({ fy }: { fy: string }) {
  const mayConfigure = useCan()('platform.tenants.write')
  const toast = useToast()
  const [onlyUnmapped, setOnlyUnmapped] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})

  const accounts = useQuery({
    queryKey: tallyQk.accounts(fy),
    queryFn: () =>
      api.get<{ items: TallyAccount[]; fy: number }>(
        `${tallyConnectorBase}/accounts?fy=${encodeURIComponent(fy)}`,
      ),
  })

  const save = useTallyMutation(
    () =>
      api.put(`${tallyConnectorBase}/mappings`, {
        mappings: Object.entries(draft).map(([account_id, tally_ledger_name]) => ({
          account_id,
          tally_ledger_name,
        })),
      }),
    () => {
      setDraft({})
      toast.ok('The ledger mapping was saved.')
    },
  )

  if (accounts.isLoading) return <Loading label="Reading the chart of accounts…" />
  if (accounts.error) return <ErrorState error={accounts.error} />

  const all = accounts.data?.items ?? []
  const value = (a: TallyAccount) => draft[a.id] ?? a.tally_ledger_name ?? ''
  const rows = onlyUnmapped ? all.filter((a) => !value(a)) : all
  const dirty = Object.keys(draft).length

  return (
    <Card>
      <CardHeader
        title={`Ledger mapping for ${fyLabel(Number(fy))}`}
        description="Each account, with the Tally ledger name it imports as. Busiest first: the account blocking the most vouchers is the one worth mapping first. Clearing a name unmaps the account."
        action={
          <Checkbox
            checked={onlyUnmapped}
            onChange={setOnlyUnmapped}
            label="Unmapped only"
          />
        }
      />
      {rows.length === 0 ? (
        <EmptyState
          title={onlyUnmapped ? 'Every account is mapped' : 'No postable accounts'}
          body={
            onlyUnmapped
              ? 'Nothing is blocking an export.'
              : 'Set up the chart of accounts before mapping it onto Tally.'
          }
        />
      ) : (
        <Table
          head={[
            'Code',
            'Account',
            { label: 'Vouchers', align: 'right' },
            'Tally ledger name',
            { label: 'Status', align: 'right' },
          ]}
          empty={false}
        >
          {rows.map((a) => (
            <tr key={a.id}>
              <Td className="tabular-nums text-muted-foreground">{a.code}</Td>
              <Td className="font-medium">{a.name}</Td>
              <Td className="text-right tabular-nums">{a.vouchers || '—'}</Td>
              <Td>
                <Input
                  value={value(a)}
                  onChange={(v) => setDraft((d) => ({ ...d, [a.id]: v }))}
                  placeholder="Tuition Fees A/c"
                />
              </Td>
              <Td className="text-right">
                {value(a) ? <Badge tone="success">Mapped</Badge> : <Badge tone="danger">Unmapped</Badge>}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <div className="space-y-3 p-5">
        <FormNotice error={save.error} ok={save.isSuccess ? 'Mapping saved.' : undefined} />
        <Button
          onClick={() => save.mutate(undefined as never)}
          disabled={!mayConfigure || !dirty || save.isPending}
        >
          {dirty ? `Save ${dirty} change(s)` : 'Save the mapping'}
        </Button>
      </div>
    </Card>
  )
}

/* The gateway address.
 *
 * Recorded, never called. Tally's HTTP gateway is a listener that a running
 * copy of Tally opens on the school's own LAN, on the accountant's desktop,
 * while they are sitting at it — a hosted server cannot reach it, and a feature
 * that timed out silently would be worse than one that says what it needs.
 *
 * It lives on this screen and not on the school's own settings because the RLS
 * policy behind it is platform-admin only: the address describes the school's
 * internal network, and an institution administrator cannot read it even for
 * their own school.
 */
function Gateway() {
  const mayConfigure = useCan()('platform.tenants.write')
  const toast = useToast()
  const gw = useQuery({
    queryKey: tallyQk.gateway,
    queryFn: () => api.get<TallyGateway>(`${tallyConnectorBase}/gateway`),
  })

  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [notes, setNotes] = useState('')

  const loaded = gw.data
  useEffect(() => {
    if (!loaded) return
    setUrl(loaded.gateway_url ?? '')
    setNotes(loaded.notes ?? '')
  }, [loaded])

  const save = useTallyMutation(
    () =>
      api.put(`${tallyConnectorBase}/gateway`, {
        gateway_url: url,
        notes,
        // Absent leaves the stored secret alone. Sending "" from an untouched
        // field would wipe a credential this screen was never shown.
        ...(secret ? { secret } : {}),
      }),
    () => {
      setSecret('')
      toast.ok('The gateway details were saved.')
    },
  )

  if (gw.isLoading) return <Loading label="Reading the gateway…" />
  if (gw.error) return <ErrorState error={gw.error} />

  return (
    <Card>
      <CardHeader
        title="On-site gateway (not in use)"
        description={gw.data?.note}
        action={<Badge tone="neutral">Platform only</Badge>}
      />
      <div className="space-y-4 p-5">
      <FormGrid>
        <Field
          label="Gateway address"
          hint="For a future on-site relay. Nothing is sent to it today."
        >
          <Input value={url} onChange={setUrl} placeholder="http://192.168.1.7:9000" />
        </Field>
        <Field
          label="Secret"
          hint={
            gw.data?.has_credentials
              ? 'A secret is stored. Leave blank to keep it; type to replace it.'
              : 'Stored encrypted. Never shown again once saved.'
          }
        >
          <Input value={secret} onChange={setSecret} type="password" placeholder="••••••••" />
        </Field>
        <Field label="Notes" wide>
          <Input value={notes} onChange={setNotes} placeholder="Whose machine, and when it is on." />
        </Field>
      </FormGrid>
      <FormNotice error={save.error} ok={save.isSuccess ? 'Saved.' : undefined} />
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => save.mutate(undefined as never)}
          disabled={!mayConfigure || save.isPending}
        >
          Save the gateway details
        </Button>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ServerOff className="h-3.5 w-3.5" />
          No request is made to this address.
        </span>
      </div>
      </div>
    </Card>
  )
}
