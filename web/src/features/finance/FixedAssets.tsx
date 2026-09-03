import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, TrendingDown, Calculator, Landmark } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Checkbox, Field, FormGrid, FormNotice, Input, Select,
  SkeletonTiles, ErrorState,
} from '@/components/ui'
import {
  inr, rupees, toPaise, fyOptions, currentFY, useAccounts, accountOptions,
  ledgerBase, type FixedAsset, type DepreciationPreview,
} from './ledger-lib'

/* The fixed asset register.

   Both depreciation methods are here and the choice is made per asset, because
   an Indian school genuinely needs both. Straight line is what the trust's own
   accounts and the auditor's working papers use; written-down value at the
   prescribed rate is what the Income Tax Act requires and what goes on the
   return. The two disagree permanently, and that difference is a real
   reconciliation rather than a bug — a register offering only one has to be
   redone by hand every March.

   The run is previewed before it posts. Depreciation is charged once a year
   and the database refuses a second charge, so seeing the numbers first is the
   only chance to catch a wrong useful life before it is in the books. */

export default function FixedAssets() {
  const [fy, setFy] = useState(String(currentFY()))
  const assets = useQuery({
    queryKey: ['ledgers', 'assets'],
    queryFn: () => api.get<List<FixedAsset>>(`${ledgerBase}/assets`),
  })

  if (assets.isLoading) return <SkeletonTiles count={4} label="Reading the register…" />
  if (assets.error) return <ErrorState error={assets.error} />

  const rows = assets.data?.items ?? []
  const inUse = rows.filter((a) => a.status === 'in_use')
  const cost = inUse.reduce((s, a) => s + a.cost_paise, 0)
  const wdv = inUse.reduce((s, a) => s + a.written_down_value_paise, 0)
  const charged = inUse.reduce((s, a) => s + a.accumulated_depreciation_paise, 0)
  const sl = inUse.filter((a) => a.method === 'straight_line').length

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Fixed assets and depreciation"
        description="What the school owns, what it has written off, and what it is worth in the books. Straight line and written-down value side by side, chosen per asset."
        width="wide"
        actions={<div className="w-44"><Select value={fy} onChange={setFy} options={fyOptions()} /></div>}
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Assets in use" value={inUse.length} icon={Boxes}
            hint={`${sl} straight line, ${inUse.length - sl} written-down value`} />
          <Stat label="At cost" value={inr(cost)} icon={Landmark} />
          <Stat label="Written off to date" value={inr(charged)} icon={TrendingDown} />
          <Stat label="Book value" value={inr(wdv)} icon={Calculator}
            hint="Cost less accumulated depreciation" />
        </CellGrid>

        <DepreciationRun fy={fy} />
        <NewAsset />

        <Card>
          <CardHeader title="The register"
            description="Each asset carries its own method and its own input — a useful life for straight line, a prescribed rate for written-down value. Neither can be inferred from the other, so an asset with neither cannot be depreciated at all and the schema refuses it." />
          <Table head={['Tag', 'Asset', 'Account', 'Bought', 'Method',
            { label: 'Cost', align: 'right' }, { label: 'Depreciation', align: 'right' },
            { label: 'Book value', align: 'right' }, 'Years', 'Status']}
            empty={rows.length === 0} emptyLabel="No assets in the register yet.">
            {rows.map((a) => (
              <tr key={a.id}>
                <Td className="font-medium tabular-nums">{a.tag_no}</Td>
                <Td>
                  {a.name}
                  {a.location && (
                    <div className="text-[12px] text-muted-foreground">{a.location}</div>
                  )}
                </Td>
                <Td className="text-[13px] text-muted-foreground">{a.account_code} {a.account_name}</Td>
                <Td className="text-muted-foreground">
                  {a.purchased_on}
                  <div className="text-[12px]">{a.age_years} yr old</div>
                </Td>
                <Td>
                  <Badge tone={a.method === 'straight_line' ? 'info' : 'primary'}>
                    {a.method === 'straight_line' ? 'straight line' : 'WDV'}
                  </Badge>
                  <div className="text-[12px] text-muted-foreground">
                    {a.method === 'straight_line'
                      ? `${a.useful_life_years} yr life`
                      : `${a.wdv_rate_percent}%`}
                  </div>
                </Td>
                <Td className="text-right tabular-nums">{rupees(a.cost_paise)}</Td>
                <Td className="text-right tabular-nums text-muted-foreground">
                  {rupees(a.accumulated_depreciation_paise)}
                </Td>
                <Td className="text-right font-medium tabular-nums">
                  {rupees(a.written_down_value_paise)}
                </Td>
                <Td className="tabular-nums text-muted-foreground">{a.years_charged || '—'}</Td>
                <Td>
                  <Badge tone={a.status === 'in_use' ? 'success' : 'neutral'}>
                    {a.status.replace('_', ' ')}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </PageBody>
    </>
  )
}

function DepreciationRun({ fy }: { fy: string }) {
  const qc = useQueryClient()
  const [preview, setPreview] = useState<DepreciationPreview | null>(null)

  const dry = useMutation({
    mutationFn: () =>
      api.post<DepreciationPreview>(`${ledgerBase}/assets/depreciate`, {
        fy_start_year: Number(fy), dry_run: true,
      }),
    onSuccess: (d) => setPreview(d),
  })
  const run = useMutation({
    mutationFn: () =>
      api.post<DepreciationPreview>(`${ledgerBase}/assets/depreciate`, {
        fy_start_year: Number(fy),
      }),
    onSuccess: () => {
      setPreview(null)
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  return (
    <Card>
      <CardHeader
        title="Charge the year's depreciation"
        description="Charged annually, not monthly: schools close their books once a year and the statutory rates are annual, so a monthly charge would only invent twelve chances to round differently. The first year is apportioned — pro-rata by days on straight line, half rate under 180 days on written-down value."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => dry.mutate()} disabled={dry.isPending}>
              Preview
            </Button>
            {preview && preview.charge_paise > 0 && (
              <ConfirmButton confirmLabel="Post it" variant="primary"
                question={`Post ${rupees(preview.charge_paise)} of depreciation for ${preview.fy_label}? It can only be charged once for the year.`}
                disabled={run.isPending}
                onConfirm={() => run.mutate()}>
                Post the charge
              </ConfirmButton>
            )}
          </div>
        }
      />
      <div className="p-5">
        <FormNotice error={dry.error ?? run.error}
          ok={run.isSuccess ? `Posted as ${run.data?.voucher_no}.` : undefined} />
      </div>
      {preview && (
        <Table head={['Tag', 'Asset', 'Method', { label: 'Opening', align: 'right' },
          { label: 'Charge', align: 'right' }, { label: 'Closing', align: 'right' }, 'Note']}
          empty={preview.assets.length === 0}
          emptyLabel="No assets to depreciate for this year.">
          {preview.assets.map((a) => (
            <tr key={a.asset_id}>
              <Td className="tabular-nums text-muted-foreground">{a.tag_no}</Td>
              <Td>{a.name}</Td>
              <Td className="text-muted-foreground">
                {a.method === 'straight_line' ? 'straight line' : 'WDV'}
              </Td>
              <Td className="text-right tabular-nums">{rupees(a.opening_wdv_paise)}</Td>
              <Td className="text-right font-medium tabular-nums">
                {a.charge_paise ? rupees(a.charge_paise) : '—'}
              </Td>
              <Td className="text-right tabular-nums">{rupees(a.closing_wdv_paise)}</Td>
              <Td className="text-[13px] text-muted-foreground">{a.note ?? ''}</Td>
            </tr>
          ))}
          <tr className="font-medium">
            <Td colSpan={4} className="text-right text-muted-foreground">
              Total charge for {preview.fy_label}
            </Td>
            <Td className="text-right tabular-nums">{rupees(preview.charge_paise)}</Td>
            <Td colSpan={2} />
          </tr>
        </Table>
      )}
    </Card>
  )
}

function NewAsset() {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const [name, setName] = useState('')
  const [category, setCategory] = useState('equipment')
  const [account, setAccount] = useState('')
  const [purchased, setPurchased] = useState('')
  const [cost, setCost] = useState('')
  const [salvage, setSalvage] = useState('')
  const [method, setMethod] = useState('straight_line')
  const [life, setLife] = useState('10')
  const [rate, setRate] = useState('15.00')
  const [location, setLocation] = useState('')
  const [capitalise, setCapitalise] = useState(false)

  const save = useMutation({
    mutationFn: () =>
      api.post<{ tag_no: string; voucher_no?: string }>(`${ledgerBase}/assets`, {
        name, category, asset_account_id: account, purchased_on: purchased,
        cost_paise: toPaise(cost), salvage_paise: toPaise(salvage),
        method,
        useful_life_years: method === 'straight_line' ? Number(life || 0) : undefined,
        wdv_rate_percent: method === 'wdv' ? rate : undefined,
        location: location || undefined,
        capitalise,
      }),
    onSuccess: () => {
      setName(''); setCost(''); setSalvage(''); setLocation('')
      qc.invalidateQueries({ queryKey: ['ledgers'] })
    },
  })

  return (
    <Card>
      <CardHeader title="Add an asset"
        description="The register is a subsidiary ledger and has to agree with the account it summarises. The audit report reconciles the two, so an asset entered here whose purchase never reached the books shows up rather than quietly understating what the school owns." />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Asset" required>
            <Input value={name} onChange={setName} placeholder="Dell OptiPlex lab desktops (20)" />
          </Field>
          <Field label="Category"><Input value={category} onChange={setCategory} /></Field>
          <Field label="Asset account" required hint="Where the cost sits on the balance sheet">
            <Select value={account} onChange={setAccount} placeholder="Choose an account"
              options={accountOptions(accounts.data?.items, 'asset')} />
          </Field>
          <Field label="Bought on" required>
            <Input type="date" value={purchased} onChange={setPurchased} />
          </Field>
          <Field label="Cost (₹)" required><Input type="number" value={cost} onChange={setCost} /></Field>
          <Field label="Salvage value (₹)"
            hint="What it should fetch at the end. Straight line spreads cost less salvage; written-down value ignores it.">
            <Input type="number" value={salvage} onChange={setSalvage} />
          </Field>
          <Field label="Method"
            hint="Straight line for the trust's accounts, written-down value for the tax return">
            <Select value={method} onChange={setMethod} options={[
              { value: 'straight_line', label: 'Straight line' },
              { value: 'wdv', label: 'Written-down value' },
            ]} />
          </Field>
          {method === 'straight_line' ? (
            <Field label="Useful life (years)" required>
              <Input type="number" value={life} onChange={setLife} />
            </Field>
          ) : (
            <Field label="Rate (% a year)" required hint="The prescribed rate for the block">
              <Input value={rate} onChange={setRate} placeholder="15.00" />
            </Field>
          )}
          <Field label="Location"><Input value={location} onChange={setLocation} placeholder="Computer lab 1" /></Field>
        </FormGrid>
        <Checkbox checked={capitalise} onChange={setCapitalise}
          label="Also post the purchase to the ledger"
          hint="Leave off when the purchase was already booked through a vendor bill or is an opening balance — capitalising again would record the same asset twice." />
        <FormNotice error={save.error}
          ok={save.isSuccess
            ? `Added as ${save.data?.tag_no}${save.data?.voucher_no ? ` and posted as ${save.data.voucher_no}` : ''}.`
            : undefined} />
        <Button onClick={() => save.mutate()}
          disabled={!name || !account || !purchased || !cost || save.isPending}>
          Add to the register
        </Button>
      </div>
    </Card>
  )
}
