import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Landmark, FileCheck2, Wallet, HandCoins } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Select, Input, Textarea, Field, FormGrid, FormNotice,
  SkeletonTable, ErrorState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import {
  collectionsBase, collectionsKey, inr, toPaise, fyLabel, currentFY, fyOptions,
  useGrantHeads, useGrantSanctions, useGrantSanction, useGrantUtilisation,
  useGrantCertificates, useGrantCertificate, GRANT_CATEGORIES, DISPOSITION_LABEL,
  type GrantSanction, type GrantCertificate,
} from './collections-lib'

/* Grant-in-aid.

   Ordinary government accounting, and worth saying plainly because the word
   "Aid" once had this feature misfiled as machine learning.

   An aided school does not receive a grant. It receives a sanction against a
   named head -- teaching salaries, non-salary, maintenance, contingency -- and
   is answerable for three figures per head per year that are routinely spoken
   about as one and are never the same number:

     sanctioned  what the government order approved
     received    what the treasury actually released, in tranches
     utilised    what was spent, booked against that head

   The screen keeps them apart because the two questions a school is asked
   depend on different pairs. "How much is still to come" is sanctioned less
   received, and is a letter to the department. "How much is unspent" is
   received less utilised, and is money in the bank that has to be carried or
   returned. Collapsing them into a single "balance" makes both unanswerable,
   which is the state most aided schools are actually in.

   Spending outside the sanctioned head is a diversion and the server refuses
   it. There is no override on this screen, deliberately: an override would be
   used, and used at exactly the moment somebody wanted the figure to come out
   right.

   The utilisation certificate is what the school files. Issuing one freezes
   every figure on it, because a signed statement must not be rewritten by a
   voucher entered the following week. */

export default function GrantInAid() {
  const can = useCan()
  const mayWrite = can('finance.fees.write')
  const mayCertify = can('finance.refunds.write')

  const [fy, setFY] = useState(currentFY())
  const [openSanction, setOpenSanction] = useState<string | null>(null)

  const heads = useGrantHeads()
  const sanctions = useGrantSanctions(fy)
  const utilisation = useGrantUtilisation(fy)

  if (heads.isLoading || sanctions.isLoading) return <SkeletonTable columns={9} label="Reading the sanctions…" />
  if (heads.error) return <ErrorState error={heads.error} />
  if (sanctions.error) return <ErrorState error={sanctions.error} />
  // The totals band is the first thing read and would otherwise show four
  // confident zeroes for a query that failed.
  if (utilisation.error) return <ErrorState error={utilisation.error} />

  const rows = sanctions.data?.items ?? []
  const u = utilisation.data

  return (
    <>
      <PageHead
        eyebrow="Concessions & refunds"
        title="Grant-in-aid"
        description="Sanctions by head, what the treasury has released, what has been spent against it, and the certificate the school files."
        width="wide"
        actions={
          <Select
            value={String(fy)}
            onChange={(v) => setFY(Number(v))}
            options={fyOptions(5).map((o) => ({ value: String(o.value), label: o.label }))}
          />
        }
      />
      <PageBody width="wide">
        <CellGrid cols={4}>
          <Stat label="Sanctioned" value={inr(u?.sanctioned_paise ?? 0)} icon={Landmark}
            period={fyLabel(fy)} />
          <Stat label="Received" value={inr(u?.received_paise ?? 0)} icon={HandCoins}
            hint={u ? `${inr(u.awaited_paise)} still awaited` : undefined} />
          <Stat label="Utilised" value={inr(u?.utilised_paise ?? 0)} icon={Wallet}
            hint="Booked against a sanctioned head" />
          <Stat label="Unspent" value={inr(u?.unspent_paise ?? 0)} icon={FileCheck2}
            hint="Received less utilised. It has to be carried or returned." />
        </CellGrid>

        <Card>
          <CardHeader
            title={`Sanctions for ${fyLabel(fy)}`}
            description="One row per head. Utilisation is measured against the sanction plus anything carried in."
          />
          <Table
            head={[
              'Head', 'Sanction',
              { label: 'Sanctioned', align: 'right' },
              { label: 'Received', align: 'right' },
              { label: 'Utilised', align: 'right' },
              { label: 'Left to spend', align: 'right' },
              { label: 'Used', align: 'right' },
              '',
            ]}
            empty={rows.length === 0}
            emptyLabel="No sanction has been recorded for this year."
          >
            {rows.map((s) => (
              <tr key={s.id}>
                <Td className="font-medium">
                  {s.head_name}
                  {s.sanctioned_posts != null ? ` · ${s.sanctioned_posts} posts` : ''}
                </Td>
                <Td>{s.sanction_no}</Td>
                <Td className="text-right tabular-nums">{inr(s.sanctioned_paise)}</Td>
                <Td className="text-right tabular-nums">{inr(s.received_paise)}</Td>
                <Td className="text-right tabular-nums">{inr(s.utilised_paise)}</Td>
                <Td className="text-right tabular-nums">{inr(s.available_paise)}</Td>
                <Td className="text-right tabular-nums">
                  <Badge tone={s.utilisation_pct >= 95 ? 'warning' : 'neutral'}>
                    {s.utilisation_pct}%
                  </Badge>
                </Td>
                <Td>
                  <Button size="sm" variant="ghost"
                    onClick={() => setOpenSanction(openSanction === s.id ? null : s.id)}>
                    {openSanction === s.id ? 'Close' : 'Open'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {openSanction && (
          // Keyed on the sanction: the panel holds two forms in local state,
          // and without the key opening a second head would reuse the first
          // one's typed amounts.
          <SanctionDetail key={openSanction} id={openSanction} disabled={!mayWrite} />
        )}

        <NewSanction fy={fy} heads={heads.data?.items ?? []} disabled={!mayWrite} />
        <HeadsPanel disabled={!mayWrite} />
        <Certificates fy={fy} mayWrite={mayWrite} mayCertify={mayCertify} />
      </PageBody>
    </>
  )
}

function SanctionDetail({ id, disabled }: { id: string; disabled: boolean }) {
  const qc = useQueryClient()
  const q = useGrantSanction(id)

  const [rAmount, setRAmount] = useState('')
  const [rOn, setROn] = useState('')
  const [rMode, setRMode] = useState('bank_transfer')
  const [rRef, setRRef] = useState('')
  const [rPost, setRPost] = useState(false)

  const [eAmount, setEAmount] = useState('')
  const [eOn, setEOn] = useState('')
  const [eWhat, setEWhat] = useState('')
  const [eVoucher, setEVoucher] = useState('')
  const [ePost, setEPost] = useState(false)

  const receipt = useMutation({
    mutationFn: () =>
      api.post(`${collectionsBase}/grants/sanctions/${id}/receipts`, {
        amount_paise: rAmount.trim() === '' ? null : toPaise(rAmount),
        received_on: rOn,
        mode: rMode,
        reference_no: rRef,
        post_to_ledger: rPost,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      setRAmount(''); setRRef('')
    },
  })

  const spend = useMutation({
    mutationFn: () =>
      api.post(`${collectionsBase}/grants/sanctions/${id}/expenditures`, {
        amount_paise: eAmount.trim() === '' ? null : toPaise(eAmount),
        spent_on: eOn,
        particulars: eWhat,
        voucher_ref: eVoucher,
        post_to_ledger: ePost,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      setEAmount(''); setEWhat(''); setEVoucher('')
    },
  })

  if (q.isLoading) return <SkeletonTable columns={5} label="Opening the sanction…" />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data
  if (!d) return null
  const s = d.sanction

  return (
    <Card>
      <CardHeader
        title={`${s.head_name} — ${s.sanction_no}`}
        description={`${s.authority ?? 'Sanctioning authority not recorded'} · ${s.sanction_date} · ${fyLabel(s.fy_start_year)}`}
        action={<Badge tone={s.status === 'closed' ? 'neutral' : 'success'}>{s.status}</Badge>}
      />
      <div className="p-5">
        <CellGrid cols={4}>
          <Stat label="Sanctioned" value={inr(s.sanctioned_paise)}
            hint={s.opening_unspent_paise ? `+ ${inr(s.opening_unspent_paise)} carried in` : undefined} />
          <Stat label="Received" value={inr(s.received_paise)} hint={`${s.receipt_count} tranches`} />
          <Stat label="Utilised" value={inr(s.utilised_paise)} hint={`${s.expenditure_count} entries`} />
          <Stat label="Left to spend" value={inr(s.available_paise)}
            hint="Booking past this is a diversion and is refused" />
        </CellGrid>
      </div>

      <Table
        head={['Received', { label: 'Amount', align: 'right' }, 'Mode', 'Reference', 'Voucher']}
        empty={d.receipts.length === 0}
        emptyLabel="No tranche has been received yet."
      >
        {d.receipts.map((r) => (
          <tr key={r.id}>
            <Td>{r.received_on}</Td>
            <Td className="text-right tabular-nums">{inr(r.amount_paise)}</Td>
            <Td>{r.mode.replace(/_/g, ' ')}</Td>
            <Td>{r.reference_no ?? '—'}</Td>
            <Td>{r.voucher_no ?? '—'}</Td>
          </tr>
        ))}
      </Table>

      <div className="p-5">
        <FormGrid>
          <Field label="Tranche received (₹)" required>
            <Input value={rAmount} onChange={setRAmount} type="number" srLabel="Amount received in rupees" />
          </Field>
          <Field label="On" hint="Blank means today.">
            <Input value={rOn} onChange={setROn} type="date" srLabel="Date received" />
          </Field>
          <Field label="How">
            <Select value={rMode} onChange={setRMode} options={[
              { value: 'bank_transfer', label: 'Bank transfer' },
              { value: 'cheque', label: 'Cheque' },
              { value: 'dd', label: 'Demand draft' },
              { value: 'adjustment', label: 'Adjustment' },
            ]} />
          </Field>
          <Field label="Reference"><Input value={rRef} onChange={setRRef} srLabel="Treasury reference" /></Field>
        </FormGrid>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Select
            value={rPost ? 'yes' : 'no'}
            onChange={(v) => setRPost(v === 'yes')}
            options={[
              { value: 'no', label: 'Record only' },
              { value: 'yes', label: 'Record and post to the ledger' },
            ]}
          />
          <Button disabled={disabled || receipt.isPending || rAmount.trim() === ''}
            onClick={() => receipt.mutate()}>
            {receipt.isPending ? 'Recording…' : 'Record the tranche'}
          </Button>
        </div>
        <FormNotice error={receipt.error} />
      </div>

      <Table
        head={['Spent', { label: 'Amount', align: 'right' }, 'Particulars', 'Voucher', 'Ledger']}
        empty={d.expenditures.length === 0}
        emptyLabel="Nothing has been booked against this head."
      >
        {d.expenditures.map((e) => (
          <tr key={e.id}>
            <Td>{e.spent_on}</Td>
            <Td className="text-right tabular-nums">{inr(e.amount_paise)}</Td>
            <Td className="font-medium">{e.particulars}</Td>
            <Td>{e.voucher_ref ?? '—'}</Td>
            <Td>{e.voucher_no ?? '—'}</Td>
          </tr>
        ))}
      </Table>

      <div className="p-5">
        <FormGrid>
          <Field label="Spent (₹)" required
            hint={`${inr(s.available_paise)} left under this head.`}>
            <Input value={eAmount} onChange={setEAmount} type="number" srLabel="Amount spent in rupees" />
          </Field>
          <Field label="On" hint="Must fall in the sanction’s own financial year.">
            <Input value={eOn} onChange={setEOn} type="date" srLabel="Date spent" />
          </Field>
          <Field label="Particulars" required wide
            hint="What the money went on. A blank entry is one nobody can certify.">
            <Input value={eWhat} onChange={setEWhat} srLabel="Particulars of the expenditure" />
          </Field>
          <Field label="Voucher reference" hint="The file number on the school’s own paper.">
            <Input value={eVoucher} onChange={setEVoucher} srLabel="Voucher reference" />
          </Field>
        </FormGrid>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Select
            value={ePost ? 'yes' : 'no'}
            onChange={(v) => setEPost(v === 'yes')}
            options={[
              { value: 'no', label: 'Record only' },
              { value: 'yes', label: 'Record and post to the ledger' },
            ]}
          />
          <Button disabled={disabled || spend.isPending || eAmount.trim() === '' || !eWhat.trim()}
            onClick={() => spend.mutate()}>
            {spend.isPending ? 'Booking…' : 'Book the expenditure'}
          </Button>
        </div>
        <FormNotice error={spend.error} />
      </div>
    </Card>
  )
}

function NewSanction({
  fy, heads, disabled,
}: {
  fy: number
  heads: { id: string; name: string; is_active: boolean }[]
  disabled: boolean
}) {
  const qc = useQueryClient()
  const [headId, setHeadId] = useState('')
  const [no, setNo] = useState('')
  const [date, setDate] = useState('')
  const [amount, setAmount] = useState('')
  const [posts, setPosts] = useState('')
  const [authority, setAuthority] = useState('')
  const [notes, setNotes] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`${collectionsBase}/grants/sanctions`, {
        head_id: headId,
        fy_start_year: fy,
        sanction_no: no,
        sanction_date: date,
        authority,
        sanctioned_paise: amount.trim() === '' ? null : toPaise(amount),
        sanctioned_posts: posts.trim() === '' ? null : Number(posts),
        notes,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      setNo(''); setAmount(''); setPosts(''); setNotes('')
    },
  })

  return (
    <Card>
      <CardHeader
        title="Record a sanction"
        description={`A government order for ${fyLabel(fy)}. One row per head, even where a single order covers several.`}
      />
      <div className="p-5">
        <FormGrid>
          <Field label="Head" required>
            <Select
              value={headId}
              onChange={setHeadId}
              options={heads.filter((h) => h.is_active).map((h) => ({ value: h.id, label: h.name }))}
              placeholder="Which sanctioned head?"
            />
          </Field>
          <Field label="Sanction order number" required>
            <Input value={no} onChange={setNo} srLabel="Sanction order number" />
          </Field>
          <Field label="Order dated" required>
            <Input value={date} onChange={setDate} type="date" srLabel="Sanction order date" />
          </Field>
          <Field label="Amount sanctioned (₹)" required>
            <Input value={amount} onChange={setAmount} type="number" srLabel="Sanctioned amount in rupees" />
          </Field>
          <Field label="Posts sanctioned" hint="Salary heads are sanctioned by post as well as by rupee.">
            <Input value={posts} onChange={setPosts} type="number" srLabel="Number of sanctioned posts" />
          </Field>
          <Field label="Sanctioning authority">
            <Input value={authority} onChange={setAuthority} srLabel="Sanctioning authority" />
          </Field>
          <Field label="Notes" wide>
            <Textarea value={notes} onChange={setNotes} rows={2} />
          </Field>
        </FormGrid>
        <div className="mt-5">
          <Button
            disabled={disabled || save.isPending || !headId || !no.trim() || !date || amount.trim() === ''}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Record the sanction'}
          </Button>
        </div>
        <FormNotice error={save.error} />
      </div>
    </Card>
  )
}

/* The heads.

   A school sets these up once from its sanction orders. expense_account_id
   ties each to the chart of accounts, which is what lets an expenditure be
   posted as a voucher rather than kept in a spreadsheet beside the books --
   and it is optional, so a school that has not finished its chart can still
   record what it was given. */
function HeadsPanel({ disabled }: { disabled: boolean }) {
  const qc = useQueryClient()
  const heads = useGrantHeads()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState('non_salary')

  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`${collectionsBase}/grants/heads`, {
        code, name, category,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      setCode(''); setName('')
    },
  })

  return (
    <Card>
      <CardHeader
        title="Sanctioned heads"
        description="The heads the department sanctions against. Money sanctioned under one may only be spent under it."
      />
      {heads.error ? (
        <div className="p-5"><ErrorState error={heads.error} /></div>
      ) : (
        <Table
          head={['Code', 'Head', 'Category', 'Ledger account', 'By post']}
          empty={(heads.data?.items ?? []).length === 0}
          emptyLabel="No heads have been set up."
        >
          {(heads.data?.items ?? []).map((h) => (
            <tr key={h.id}>
              <Td className="font-medium">{h.code}</Td>
              <Td>{h.name}</Td>
              <Td>{h.category.replace(/_/g, ' ')}</Td>
              <Td>{h.expense_account_name ?? '—'}</Td>
              <Td>{h.is_post_based ? <Badge tone="info">Posts</Badge> : '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
      <div className="p-5">
        <FormGrid>
          <Field label="Code" required><Input value={code} onChange={setCode} srLabel="Head code" /></Field>
          <Field label="Head" required><Input value={name} onChange={setName} srLabel="Head name" /></Field>
          <Field label="Category" required>
            <Select value={category} onChange={setCategory} options={GRANT_CATEGORIES} />
          </Field>
        </FormGrid>
        <div className="mt-5">
          <Button disabled={disabled || save.isPending || !code.trim() || !name.trim()}
            onClick={() => save.mutate()}>
            {save.isPending ? 'Adding…' : 'Add the head'}
          </Button>
        </div>
        <FormNotice error={save.error} />
      </div>
    </Card>
  )
}

/* Utilisation certificates.

   A draft recomputes from the sanctions every time it is opened, because that
   is what a draft is for. Issuing it copies every figure onto the certificate
   and stops recomputing, because the document is a statement a named person
   made on a date.

   The unspent balance is then a decision with a deadline. Carrying it forward
   is not a note: it lands on next year's sanction as its opening balance, so
   next year's utilisation is measured against what the head actually had. */
function Certificates({
  fy, mayWrite, mayCertify,
}: {
  fy: number
  mayWrite: boolean
  mayCertify: boolean
}) {
  const qc = useQueryClient()
  const list = useGrantCertificates()
  const [open, setOpen] = useState<string | null>(null)
  const [no, setNo] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`${collectionsBase}/grants/certificates`, {
        certificate_no: no,
        fy_start_year: fy,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: [collectionsKey] })
      setNo('')
      setOpen(r.id)
    },
  })

  return (
    <>
      <Card>
        <CardHeader
          title="Utilisation certificates"
          description="What the school files. Issuing one freezes its figures; a voucher entered next week will not rewrite it."
        />
        {list.error ? (
          <div className="p-5"><ErrorState error={list.error} /></div>
        ) : (
          <Table
            head={[
              'Number', 'Year', 'Status',
              { label: 'Received', align: 'right' },
              { label: 'Utilised', align: 'right' },
              { label: 'Unspent', align: 'right' },
              'Balance', '',
            ]}
            empty={(list.data?.items ?? []).length === 0}
            emptyLabel="No certificate has been raised."
          >
            {(list.data?.items ?? []).map((c) => (
              <tr key={c.id}>
                <Td className="font-medium">{c.certificate_no}</Td>
                <Td>{c.fy_label}</Td>
                <Td>
                  <Badge tone={c.status === 'draft' ? 'warning' : c.status === 'filed' ? 'success' : 'info'}>
                    {c.status}
                  </Badge>
                </Td>
                <Td className="text-right tabular-nums">{inr(c.received_paise)}</Td>
                <Td className="text-right tabular-nums">{inr(c.utilised_paise)}</Td>
                <Td className="text-right tabular-nums">{inr(c.unspent_paise)}</Td>
                <Td>{DISPOSITION_LABEL[c.unspent_disposition]}</Td>
                <Td>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(open === c.id ? null : c.id)}>
                    {open === c.id ? 'Close' : 'Open'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="p-5">
          <FormGrid>
            <Field label="Certificate number" required
              hint={`Raised as a draft for ${fyLabel(fy)} and recomputed until it is issued.`}>
              <Input value={no} onChange={setNo} srLabel="Certificate number" />
            </Field>
          </FormGrid>
          <div className="mt-5">
            <Button disabled={!mayWrite || create.isPending || !no.trim()} onClick={() => create.mutate()}>
              {create.isPending ? 'Raising…' : 'Raise a draft'}
            </Button>
          </div>
          <FormNotice error={create.error} />
        </div>
      </Card>
      {open && <CertificateDetail key={open} id={open} mayCertify={mayCertify} />}
    </>
  )
}

function CertificateDetail({ id, mayCertify }: { id: string; mayCertify: boolean }) {
  const qc = useQueryClient()
  const q = useGrantCertificate(id)
  const [by, setBy] = useState('')
  const [disposition, setDisposition] = useState('carried_forward')
  const [carryTo, setCarryTo] = useState('')
  const [refundedOn, setRefundedOn] = useState('')
  const [refundRef, setRefundRef] = useState('')
  const [filedOn, setFiledOn] = useState('')
  const [filedRef, setFiledRef] = useState('')

  const nextFY = (q.data?.certificate.fy_start_year ?? currentFY()) + 1
  const next = useGrantSanctions(nextFY)

  const issue = useMutation({
    mutationFn: () =>
      api.post(`${collectionsBase}/grants/certificates/${id}/issue`, { certified_by: by }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [collectionsKey] }),
  })

  const dispose = useMutation({
    mutationFn: () =>
      api.post(`${collectionsBase}/grants/certificates/${id}/dispose`, {
        disposition,
        carry_to_sanction_id: carryTo,
        refunded_on: refundedOn,
        refund_reference: refundRef,
        filed_on: filedOn,
        filed_reference: filedRef,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [collectionsKey] }),
  })

  if (q.isLoading) return <SkeletonTable columns={8} label="Opening the certificate…" />
  if (q.error) return <ErrorState error={q.error} />
  const d = q.data
  if (!d) return null
  const c: GrantCertificate = d.certificate

  return (
    <Card>
      <CardHeader
        title={`Certificate ${c.certificate_no}`}
        description={
          c.status === 'draft'
            ? `Draft for ${c.fy_label}. Every figure below is live and will be frozen when it is issued.`
            : `Issued ${c.issued_on} by ${c.certified_by}. These figures are the ones that were signed for.`
        }
        action={<Badge tone={c.status === 'draft' ? 'warning' : 'success'}>{c.status}</Badge>}
      />
      <Table
        head={[
          'Head', 'Sanction',
          { label: 'Carried in', align: 'right' },
          { label: 'Sanctioned', align: 'right' },
          { label: 'Received', align: 'right' },
          { label: 'Utilised', align: 'right' },
          { label: 'Unspent', align: 'right' },
        ]}
        empty={d.lines.length === 0}
        emptyLabel="No sanctions fall in this certificate’s year."
      >
        {d.lines.map((l) => (
          <tr key={l.sanction_id}>
            <Td className="font-medium">{l.head_name}</Td>
            <Td>{l.sanction_no}</Td>
            <Td className="text-right tabular-nums">{inr(l.opening_unspent_paise)}</Td>
            <Td className="text-right tabular-nums">{inr(l.sanctioned_paise)}</Td>
            <Td className="text-right tabular-nums">{inr(l.received_paise)}</Td>
            <Td className="text-right tabular-nums">{inr(l.utilised_paise)}</Td>
            <Td className="text-right tabular-nums">{inr(l.unspent_paise)}</Td>
          </tr>
        ))}
      </Table>

      <div className="p-5">
        <CellGrid cols={4}>
          <Stat label="Sanctioned" value={inr(c.sanctioned_paise || d.lines.reduce((n, l) => n + l.sanctioned_paise, 0))} />
          <Stat label="Received" value={inr(c.received_paise || d.lines.reduce((n, l) => n + l.received_paise, 0))} />
          <Stat label="Utilised" value={inr(c.utilised_paise || d.lines.reduce((n, l) => n + l.utilised_paise, 0))} />
          <Stat label="Unspent" value={inr(c.unspent_paise || d.lines.reduce((n, l) => n + l.unspent_paise, 0))} />
        </CellGrid>
      </div>

      {c.status === 'draft' ? (
        <div className="p-5">
          <FormGrid>
            <Field label="Certified by" required
              hint="The name that goes on the document. The department will not accept it unsigned.">
              <Input value={by} onChange={setBy} srLabel="Name of the certifying officer" />
            </Field>
          </FormGrid>
          <div className="mt-5">
            <ConfirmButton
              confirmLabel="Issue the certificate"
              question="Issuing freezes every figure on this certificate. Later vouchers will not change it, and it cannot be edited afterwards."
              disabled={!mayCertify || issue.isPending || !by.trim()}
              onConfirm={() => issue.mutate()}
            >
              {issue.isPending ? 'Issuing…' : 'Issue the certificate'}
            </ConfirmButton>
          </div>
          <FormNotice error={issue.error} />
        </div>
      ) : (
        <div className="p-5">
          <FormGrid>
            <Field label="What happens to the unspent balance?" required
              hint="Carrying it forward puts it on next year's sanction as its opening balance.">
              <Select value={disposition} onChange={setDisposition} options={[
                { value: 'carried_forward', label: 'Carried into next year' },
                { value: 'refunded', label: 'Refunded to the treasury' },
                { value: 'none', label: 'Nothing is unspent' },
              ]} />
            </Field>
            {disposition === 'carried_forward' && (
              <Field label={`Carry into which ${fyLabel(nextFY)} sanction?`} required>
                <Select
                  value={carryTo}
                  onChange={setCarryTo}
                  options={(next.data?.items ?? []).map((s: GrantSanction) => ({
                    value: s.id,
                    label: `${s.head_name} · ${s.sanction_no}`,
                  }))}
                  placeholder={
                    (next.data?.items ?? []).length
                      ? 'Which head takes the balance?'
                      : `Record a ${fyLabel(nextFY)} sanction first`
                  }
                />
              </Field>
            )}
            {disposition === 'refunded' && (
              <>
                <Field label="Refunded on" required>
                  <Input value={refundedOn} onChange={setRefundedOn} type="date" srLabel="Date refunded" />
                </Field>
                <Field label="Challan or transaction reference" required>
                  <Input value={refundRef} onChange={setRefundRef} srLabel="Refund reference" />
                </Field>
              </>
            )}
            <Field label="Filed with the department on" hint="Optional. Recording it marks the certificate filed.">
              <Input value={filedOn} onChange={setFiledOn} type="date" srLabel="Date filed" />
            </Field>
            <Field label="Filing reference">
              <Input value={filedRef} onChange={setFiledRef} srLabel="Filing reference" />
            </Field>
          </FormGrid>
          <div className="mt-5">
            <Button
              disabled={
                !mayCertify || dispose.isPending ||
                (disposition === 'carried_forward' && !carryTo) ||
                (disposition === 'refunded' && (!refundedOn || !refundRef.trim()))
              }
              onClick={() => dispose.mutate()}
            >
              {dispose.isPending ? 'Recording…' : 'Record the disposition'}
            </Button>
          </div>
          <FormNotice error={dispose.error}
            ok={dispose.isSuccess ? 'Recorded.' : undefined} />
        </div>
      )}
    </Card>
  )
}
