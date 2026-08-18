import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Landmark, Upload, Wand2, Lock, ScrollText } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge,
  Button, ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea,
  Loading, ErrorState, EmptyState,
} from '@/components/ui'
import { useCan } from '@/lib/session'
import {
  bankingBase, bankingQueryKey, inr, signedInr, toPaise, uploadStatement,
  useBankAccounts, bankAccountOptions, MATCH_KIND_LABELS,
  type Reconciliation, type Statement, type StatementLine, type MatchCandidate,
} from './banking-lib'

/* The bank reconciliation statement.

   The screen is arranged around the only question that matters: what is left.
   Totals first, then the residue in two columns — bank lines with no book
   entry, and book entries with no bank line — and the matched majority folded
   away below, because a reconciled line is finished business and reading it
   again is not how the hour is spent.

   Matching is three gestures, in the order an accountant actually works:
   import, let the machine take the unambiguous ones, then work down what is
   left confirming or explaining each. Nothing here matches fuzzily on its own.
   A candidate list is offered and a person clicks; the server refuses to
   auto-apply anything where more than one book entry could be meant, because
   an arbitrary match is worse than none — it is wrong and it looks finished.

   Finalising is a separate permission and a separate button, deliberately far
   from the matching work. It freezes the period: the residue is stored as it
   stood, and a database trigger stops the lines moving afterwards. Reopening
   is possible and asks for a reason, because a closed period that changed with
   nobody's name against it is the finding an auditor writes up. */

export default function BankReconciliation() {
  const can = useCan()
  const mayWrite = can('finance.payments.write')
  const mayFinalise = can('finance.refunds.write')

  const accounts = useBankAccounts()
  const [accountId, setAccountId] = useState('')
  const [openId, setOpenId] = useState('')

  const periods = useQuery({
    queryKey: [bankingQueryKey, 'reconciliations', accountId],
    queryFn: () =>
      api.get<List<Reconciliation>>(
        `${bankingBase}/reconciliations${accountId ? `?bank_account_id=${accountId}` : ''}`,
      ),
  })

  if (accounts.isLoading) return <Loading label="Reading the bank accounts…" />
  if (accounts.error) return <ErrorState error={accounts.error} />

  const accountList = accounts.data?.items ?? []
  const rows = periods.data?.items ?? []

  return (
    <>
      <PageHead
        eyebrow="Accounts"
        title="Bank reconciliation"
        description="Match the bank's statement against the school's books, and close the period once the difference is explained."
        width="wide"
      />
      <PageBody width="wide">
        {accountList.length === 0 ? (
          <Card>
            <CardHeader
              title="No bank account registered yet"
              description="A reconciliation needs an account to reconcile. Register the school's account first — its number and IFSC are also what the payout file debits."
            />
            <div className="p-5">
              <RegisterAccount />
            </div>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader
                title="Periods"
                description="One statement per account per month. A finalised period cannot silently change."
                action={
                  <Select
                    value={accountId}
                    onChange={(v) => { setAccountId(v); setOpenId('') }}
                    options={[
                      { value: '', label: 'All accounts' },
                      ...bankAccountOptions(accountList),
                    ]}
                  />
                }
              />
              {periods.isLoading ? (
                <Loading />
              ) : periods.error ? (
                <ErrorState error={periods.error} />
              ) : (
                <Table
                  head={['Account', 'Period', { label: 'Opening', align: 'right' },
                    { label: 'Closing', align: 'right' }, 'Lines', 'Status', '']}
                  empty={rows.length === 0}
                  emptyLabel="No period opened yet. Open one below and import the statement."
                >
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <Td className="font-medium">{p.account_label}</Td>
                      <Td className="text-muted-foreground">
                        {p.period_start} → {p.period_end}
                      </Td>
                      <Td className="text-right tabular-nums">{inr(p.opening_balance_paise)}</Td>
                      <Td className="text-right tabular-nums">{inr(p.closing_balance_paise)}</Td>
                      <Td className="tabular-nums">
                        {p.matched_count}/{p.line_count}
                        {p.unmatched_count > 0 && (
                          <span className="block text-[12px] text-warning">
                            {p.unmatched_count} unmatched
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={p.status === 'finalised' ? 'success' : 'warning'}>
                          {p.status}
                        </Badge>
                        {p.finalised_by && (
                          <span className="block text-[12px] text-muted-foreground">
                            {p.finalised_by}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Button
                          size="sm"
                          variant={openId === p.id ? 'primary' : 'secondary'}
                          onClick={() => setOpenId(openId === p.id ? '' : p.id)}
                        >
                          {openId === p.id ? 'Close' : 'Open'}
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            {openId && (
              <StatementView
                id={openId}
                mayWrite={mayWrite}
                mayFinalise={mayFinalise}
              />
            )}

            {mayWrite && <OpenPeriod accounts={accountList} />}
            <RegisterAccount />
          </>
        )}
      </PageBody>
    </>
  )
}

// --- the statement -----------------------------------------------------------

function StatementView({
  id, mayWrite, mayFinalise,
}: { id: string; mayWrite: boolean; mayFinalise: boolean }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')

  const q = useQuery({
    queryKey: [bankingQueryKey, 'statement', id],
    queryFn: () => api.get<Statement>(`${bankingBase}/reconciliations/${id}`),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: [bankingQueryKey] })

  const auto = useMutation({
    mutationFn: () =>
      api.post<{ matched: number; ambiguous: number; remaining: number }>(
        `${bankingBase}/reconciliations/${id}/auto-match`, {}),
    onSuccess: (r) => {
      setNote(
        r.matched === 0
          ? `Nothing could be matched without a judgement call. ${r.remaining} line(s) still need you.`
          : `Matched ${r.matched} line(s) exactly. ${r.remaining} left${
              r.ambiguous ? `, and ${r.ambiguous} where more than one entry could be meant` : ''
            }.`,
      )
      invalidate()
    },
  })

  if (q.isLoading) return <Loading label="Building the statement…" />
  if (q.error) return <ErrorState error={q.error} />
  const st = q.data
  if (!st) return null

  const locked = st.status === 'finalised'

  return (
    <>
      <CellGrid cols={4}>
        <Stat
          label="Closing, per the bank"
          value={inr(st.bank_closing_paise)}
          icon={Landmark}
          hint="Typed from the statement"
        />
        <Stat
          label="Closing, per the books"
          value={inr(st.book_closing_paise)}
          hint="Opening plus everything recorded in the period"
        />
        <Stat
          label="Difference"
          value={inr(st.difference_paise)}
          delta={
            st.difference_paise === 0
              ? { value: 'the two sides agree', positive: true }
              : {
                  value: st.difference_explained
                    ? 'accounted for by the residue'
                    : 'not yet accounted for',
                  positive: st.difference_explained,
                }
          }
        />
        <Stat
          label="Still to reconcile"
          value={st.unmatched_bank.length + st.unmatched_book.length}
          icon={ScrollText}
          hint={`${st.unmatched_bank.length} on the bank side, ${st.unmatched_book.length} in the books`}
        />
      </CellGrid>

      <FormNotice error={auto.error} ok={note} />

      {mayWrite && !locked && (
        <Card>
          <CardHeader
            title="Import the statement"
            description="Upload the CSV your bank exports. Importing the same file twice adds nothing — every line is fingerprinted."
            action={
              <Button
                variant="secondary"
                disabled={auto.isPending || st.bank_lines.length === 0}
                onClick={() => auto.mutate()}
              >
                <Wand2 className="h-4 w-4" />
                {auto.isPending ? 'Matching…' : 'Match the obvious ones'}
              </Button>
            }
          />
          <div className="p-5">
            <ImportPanel reconciliationId={id} onDone={invalidate} />
          </div>
        </Card>
      )}

      {locked && (
        <Card>
          <CardHeader
            title="This period is finalised"
            description={
              st.finalised_by
                ? `Closed by ${st.finalised_by}. The statement lines cannot change while it stays closed — the database refuses them, not just this screen.`
                : 'The statement lines cannot change while it stays closed.'
            }
            action={mayFinalise ? <ReopenPeriod id={id} onDone={invalidate} /> : undefined}
          />
        </Card>
      )}

      {/* The residue: the reconciliation statement itself. */}
      <Card>
        <CardHeader
          title="On the statement, not in the books"
          description="Money the bank has recorded that the school has not. Each one is either a receipt nobody entered, or a bank charge to be explained."
        />
        {st.unmatched_bank.length === 0 ? (
          <EmptyState
            title="Nothing outstanding on the bank side"
            body="Every line on the statement is matched or explained."
          />
        ) : (
          <Table
            head={['Date', 'Narration', 'Reference', { label: 'Amount', align: 'right' }, '']}
            empty={false}
          >
            {st.unmatched_bank.map((l) => (
              <UnmatchedLine
                key={l.id}
                line={l}
                reconciliationId={id}
                mayWrite={mayWrite && !locked}
                onDone={invalidate}
              />
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader
          title="In the books, not on the statement"
          description="Money the school has recorded that the bank has not — a cheque not yet presented, a transfer still in flight, or a receipt that never reached the bank at all."
        />
        {st.unmatched_book.length === 0 ? (
          <EmptyState
            title="Nothing outstanding in the books"
            body="Every book entry in this period appears on the statement."
          />
        ) : (
          <Table
            head={['Date', 'Kind', 'Party', 'Reference', { label: 'Amount', align: 'right' }]}
            empty={false}
          >
            {st.unmatched_book.map((e) => (
              <tr key={`${e.kind}:${e.id}`}>
                <Td className="text-muted-foreground">{e.entry_date}</Td>
                <Td>
                  <Badge tone="neutral">{MATCH_KIND_LABELS[e.kind] ?? e.kind}</Badge>
                </Td>
                <Td className="font-medium">{e.party}</Td>
                <Td className="font-mono text-[12px] text-muted-foreground">
                  {e.reference ?? '—'}
                </Td>
                <Td className="text-right tabular-nums">{signedInr(e.amount_paise)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {mayFinalise && !locked && (
        <FinalisePanel statement={st} onDone={invalidate} />
      )}

      <MatchedLines statement={st} mayWrite={mayWrite && !locked} onDone={invalidate} />

      {st.imports.length > 0 && <ImportHistory statement={st} />}
    </>
  )
}

// --- one unmatched bank line -------------------------------------------------

function UnmatchedLine({
  line, reconciliationId, mayWrite, onDone,
}: {
  line: StatementLine
  reconciliationId: string
  mayWrite: boolean
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [explanation, setExplanation] = useState('')

  const candidates = useQuery({
    queryKey: [bankingQueryKey, 'candidates', reconciliationId, line.id],
    queryFn: () =>
      api.get<List<MatchCandidate>>(
        `${bankingBase}/reconciliations/${reconciliationId}/candidates/${line.id}`,
      ),
    enabled: open,
  })

  const decide = useMutation({
    mutationFn: (body: { match_kind?: string; match_id?: string; explained_as?: string }) =>
      api.post(`${bankingBase}/lines/${line.id}/match`, body),
    onSuccess: () => { setOpen(false); onDone() },
  })

  const list = candidates.data?.items ?? []

  return (
    <>
      <tr>
        <Td className="text-muted-foreground">{line.txn_date}</Td>
        <Td className="max-w-[24rem] truncate" >{line.narration || '—'}</Td>
        <Td className="font-mono text-[12px] text-muted-foreground">
          {line.reference_no ?? '—'}
        </Td>
        <Td className="text-right tabular-nums font-medium">{signedInr(line.amount_paise)}</Td>
        <Td>
          {mayWrite && (
            <Button size="sm" variant="secondary" onClick={() => setOpen(!open)}>
              {open ? 'Cancel' : 'Match'}
            </Button>
          )}
        </Td>
      </tr>
      {open && (
        <tr>
          <Td colSpan={5}>
            <div className="space-y-4 py-2">
              {/* The raw line, because the first import from a new bank always
                  parses something wrong and this is where you see it. */}
              <p className="font-mono text-[12px] text-muted-foreground">
                as imported: {line.raw_line}
              </p>

              {candidates.isLoading ? (
                <Loading label="Looking for a matching entry…" />
              ) : candidates.error ? (
                <ErrorState error={candidates.error} />
              ) : list.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">
                  No book entry of exactly {signedInr(line.amount_paise)} within three days of
                  this line. Either it has not been entered yet, or this is not a book entry at
                  all — explain it below.
                </p>
              ) : (
                <div className="space-y-2">
                  {list.map((c) => (
                    <div
                      key={`${c.kind}:${c.id}`}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2"
                    >
                      <div>
                        <p className="text-[14px] font-medium">
                          {c.party}
                          <span className="ml-2 text-[13px] font-normal text-muted-foreground">
                            {MATCH_KIND_LABELS[c.kind] ?? c.kind} · {c.entry_date}
                            {c.reference ? ` · ${c.reference}` : ''}
                          </span>
                        </p>
                        <p className="text-[12px] text-muted-foreground">{c.reason}</p>
                      </div>
                      <Button
                        size="sm"
                        variant={c.exact ? 'primary' : 'secondary'}
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ match_kind: c.kind, match_id: c.id })}
                      >
                        This one
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[320px] flex-1">
                  <Field
                    label="Or explain it"
                    hint="Bank charges, interest credited, a transfer between the school's own accounts — anything that is genuinely not a book entry."
                  >
                    <Input
                      value={explanation}
                      onChange={setExplanation}
                      placeholder="Quarterly bank charges"
                    />
                  </Field>
                </div>
                <Button
                  variant="secondary"
                  disabled={!explanation || decide.isPending}
                  onClick={() => decide.mutate({ explained_as: explanation })}
                >
                  Explain and set aside
                </Button>
              </div>

              <FormNotice error={decide.error} />
            </div>
          </Td>
        </tr>
      )}
    </>
  )
}

// --- the matched majority, folded away ---------------------------------------

function MatchedLines({
  statement, mayWrite, onDone,
}: { statement: Statement; mayWrite: boolean; onDone: () => void }) {
  const [show, setShow] = useState(false)
  const done = statement.bank_lines.filter((l) => l.match_kind || l.explained_as)

  if (done.length === 0) return null

  return (
    <Card>
      <CardHeader
        title="Already reconciled"
        description={`${done.length} line(s) matched or explained. Finished business — kept here so a wrong match can be undone.`}
        action={
          <Button variant="secondary" size="sm" onClick={() => setShow(!show)}>
            {show ? 'Hide' : 'Show'}
          </Button>
        }
      />
      {show && (
        <Table
          head={['Date', 'Narration', { label: 'Amount', align: 'right' }, 'Matched to', 'How', '']}
          empty={false}
        >
          {done.map((l) => (
            <MatchedRow key={l.id} line={l} mayWrite={mayWrite} onDone={onDone} />
          ))}
        </Table>
      )}
    </Card>
  )
}

function MatchedRow({
  line, mayWrite, onDone,
}: { line: StatementLine; mayWrite: boolean; onDone: () => void }) {
  const undo = useMutation({
    mutationFn: () => api.post(`${bankingBase}/lines/${line.id}/unmatch`, {}),
    onSuccess: onDone,
  })
  return (
    <tr>
      <Td className="text-muted-foreground">{line.txn_date}</Td>
      <Td className="max-w-[24rem] truncate">{line.narration || '—'}</Td>
      <Td className="text-right tabular-nums">{signedInr(line.amount_paise)}</Td>
      <Td>
        {line.explained_as ? (
          <span className="text-muted-foreground">{line.explained_as}</span>
        ) : (
          <Badge tone="neutral">
            {MATCH_KIND_LABELS[line.match_kind ?? ''] ?? line.match_kind}
          </Badge>
        )}
      </Td>
      <Td className="text-[13px] text-muted-foreground">
        {line.explained_as ? 'explained' : line.match_confidence}
        {line.matched_by && <span className="block text-[12px]">{line.matched_by}</span>}
      </Td>
      <Td>
        {mayWrite && (
          <Button size="sm" variant="ghost" disabled={undo.isPending} onClick={() => undo.mutate()}>
            Undo
          </Button>
        )}
      </Td>
    </tr>
  )
}

// --- import ------------------------------------------------------------------

function ImportPanel({
  reconciliationId, onDone,
}: { reconciliationId: string; onDone: () => void }) {
  const [csv, setCsv] = useState('')
  const [filename, setFilename] = useState('')

  const run = useMutation({
    mutationFn: () => uploadStatement(reconciliationId, filename || 'statement.csv', csv),
    onSuccess: onDone,
  })

  const r = run.data

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed py-8 text-center transition-colors hover:bg-accent/40">
        <Upload className="h-5 w-5 text-muted-foreground" />
        <span className="text-[14px] font-medium">
          {filename || 'Click to choose the statement CSV'}
        </span>
        <span className="text-[13px] text-muted-foreground">
          A date column and either an amount column or separate debit and credit columns.
          Dates may be dd/mm/yyyy.
        </span>
        <input
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            setFilename(f.name)
            const reader = new FileReader()
            reader.onload = () => setCsv(String(reader.result ?? ''))
            reader.readAsText(f)
          }}
        />
      </label>

      <Button disabled={!csv || run.isPending} onClick={() => run.mutate()}>
        {run.isPending ? 'Importing…' : 'Import the statement'}
      </Button>

      <FormNotice error={run.error} />

      {r && (
        <div className="rounded-md border px-4 py-3 text-[13px]">
          <p>
            <span className="font-medium">{r.rows_read}</span> row(s) read
            {' · '}
            <span className="font-medium text-success">{r.rows_inserted}</span> new
            {' · '}
            <span className="font-medium">{r.rows_duplicate}</span> already imported
            {r.rows_outside_period > 0 && (
              <> · <span className="font-medium">{r.rows_outside_period}</span> outside this period</>
            )}
            {r.rows_rejected > 0 && (
              <> · <span className="font-medium text-destructive">{r.rows_rejected}</span> rejected</>
            )}
          </p>
          {r.rows_inserted === 0 && r.rows_duplicate > 0 && (
            <p className="mt-1 text-muted-foreground">
              This file has already been imported. Nothing was duplicated.
            </p>
          )}
          {r.rejects?.length > 0 && (
            <ul className="mt-2 space-y-1">
              {r.rejects.slice(0, 20).map((x) => (
                <li key={x.line} className="text-destructive">
                  line {x.line}: {x.reason}
                  <span className="ml-2 font-mono text-[12px] text-muted-foreground">{x.raw}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function ImportHistory({ statement }: { statement: Statement }) {
  return (
    <Card>
      <CardHeader
        title="Imports"
        description="Every upload against this account, including the ones that added nothing."
      />
      <Table
        head={['File', 'When', 'By', 'Read', 'New', 'Duplicate', 'Rejected']}
        empty={false}
      >
        {statement.imports.map((i) => (
          <tr key={i.id}>
            <Td className="font-medium">{i.filename}</Td>
            <Td className="text-muted-foreground">{i.imported_at.slice(0, 16).replace('T', ' ')}</Td>
            <Td className="text-muted-foreground">{i.imported_by ?? '—'}</Td>
            <Td className="tabular-nums">{i.rows_read}</Td>
            <Td className="tabular-nums">{i.rows_inserted}</Td>
            <Td className="tabular-nums text-muted-foreground">{i.rows_duplicate}</Td>
            <Td className="tabular-nums">
              {i.rows_rejected > 0 ? (
                <span className="text-destructive">{i.rows_rejected}</span>
              ) : (
                '—'
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  )
}

// --- finalise and reopen -----------------------------------------------------

function FinalisePanel({ statement, onDone }: { statement: Statement; onDone: () => void }) {
  const [notes, setNotes] = useState('')

  const finalise = useMutation({
    mutationFn: (acknowledge: boolean) =>
      api.post(`${bankingBase}/reconciliations/${statement.id}/finalise`, {
        notes,
        acknowledge_difference: acknowledge,
      }),
    onSuccess: onDone,
  })

  const clean = statement.difference_explained

  return (
    <Card>
      <CardHeader
        title="Close the period"
        description="Freezes the statement as it stands. The residue is stored and the lines stop moving — reopening later takes a reason and leaves a record."
      />
      <div className="space-y-4 p-5">
        <div className="rounded-md border px-4 py-3 text-[13px]">
          <p className="tabular-nums">
            Bank {inr(statement.bank_closing_paise)} − books {inr(statement.book_closing_paise)} ={' '}
            <span className="font-medium">{inr(statement.difference_paise)}</span>
          </p>
          <p className="mt-1 text-muted-foreground tabular-nums">
            Residue: {inr(statement.unmatched_bank_paise)} on the bank side,{' '}
            {inr(statement.unmatched_book_paise)} in the books.
          </p>
          <p className={clean ? 'mt-1 text-success' : 'mt-1 text-warning'}>
            {clean
              ? 'The residue accounts for the difference exactly. This period ties.'
              : 'The residue does not account for the difference. Something is unrecorded on both sides, or an amount is wrong.'}
          </p>
        </div>

        <Field label="Notes for whoever reads this next">
          <Textarea
            value={notes}
            onChange={setNotes}
            rows={2}
            placeholder="Two cheques presented in April; bank charges of ₹590 posted to charges."
          />
        </Field>

        <FormNotice error={finalise.error} />

        <div className="flex flex-wrap gap-2">
          <Button disabled={finalise.isPending || !clean} onClick={() => finalise.mutate(false)}>
            <Lock className="h-4 w-4" />
            {finalise.isPending ? 'Closing…' : 'Close the period'}
          </Button>
          {!clean && (
            <ConfirmButton
              confirmLabel="Close it anyway"
              question={`Close with ${inr(statement.difference_paise)} unaccounted for?`}
              onConfirm={() => finalise.mutate(true)}
              disabled={finalise.isPending}
              tone="danger"
            >
              Close with the difference unexplained
            </ConfirmButton>
          )}
        </div>
      </div>
    </Card>
  )
}

function ReopenPeriod({ id, onDone }: { id: string; onDone: () => void }) {
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')

  const reopen = useMutation({
    mutationFn: () => api.post(`${bankingBase}/reconciliations/${id}/reopen`, { reason }),
    onSuccess: () => { setAsking(false); setReason(''); onDone() },
  })

  if (!asking) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>
        Reopen
      </Button>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Input
        value={reason}
        onChange={setReason}
        placeholder="Why is this being reopened?"
        className="min-w-[18rem]"
      />
      <Button size="sm" tone="danger" disabled={!reason || reopen.isPending} onClick={() => reopen.mutate()}>
        Reopen
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </span>
  )
}

// --- opening a period, and registering an account ----------------------------

function OpenPeriod({ accounts }: { accounts: { id: string; label: string; bank_name: string; account_masked: string; is_active: boolean; allows_payouts: boolean }[] }) {
  const qc = useQueryClient()
  const [accountId, setAccountId] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [opening, setOpening] = useState('')
  const [closing, setClosing] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.post(`${bankingBase}/reconciliations`, {
        bank_account_id: accountId,
        period_start: start,
        period_end: end,
        opening_balance_paise: toPaise(opening),
        closing_balance_paise: toPaise(closing),
      }),
    onSuccess: () => {
      setOpening(''); setClosing('')
      qc.invalidateQueries({ queryKey: [bankingQueryKey] })
    },
  })

  return (
    <Card>
      <CardHeader
        title="Open a period"
        description="The opening and closing balances are the bank's own figures, typed from the statement. They are allowed to differ from the books — that difference is what this screen exists to explain."
      />
      <div className="space-y-5 p-5">
        <FormGrid>
          <Field label="Account" required>
            <Select
              value={accountId}
              onChange={setAccountId}
              placeholder="Choose an account"
              options={bankAccountOptions(accounts as never)}
            />
          </Field>
          <Field label="Period" required hint="A calendar month, usually">
            <div className="flex gap-2">
              <Input type="date" value={start} onChange={setStart} />
              <Input type="date" value={end} onChange={setEnd} />
            </div>
          </Field>
          <Field label="Opening balance per the bank (₹)" required>
            <Input type="number" value={opening} onChange={setOpening} />
          </Field>
          <Field label="Closing balance per the bank (₹)" required>
            <Input type="number" value={closing} onChange={setClosing} />
          </Field>
        </FormGrid>
        <FormNotice error={save.error} ok={save.isSuccess ? 'Period opened.' : undefined} />
        <Button
          disabled={!accountId || !start || !end || save.isPending}
          onClick={() => save.mutate()}
        >
          Open the period
        </Button>
      </div>
    </Card>
  )
}

function RegisterAccount() {
  const qc = useQueryClient()
  const can = useCan()
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [bankName, setBankName] = useState('')
  const [branch, setBranch] = useState('')
  const [account, setAccount] = useState('')
  const [ifsc, setIfsc] = useState('')
  const [payouts, setPayouts] = useState(false)

  const save = useMutation({
    mutationFn: () =>
      api.post(`${bankingBase}/accounts`, {
        label, bank_name: bankName, branch,
        account_number: account, ifsc, allows_payouts: payouts,
      }),
    onSuccess: () => {
      setLabel(''); setBankName(''); setBranch(''); setAccount(''); setIfsc('')
      qc.invalidateQueries({ queryKey: [bankingQueryKey] })
    },
  })

  if (!can('finance.payments.write')) return null

  return (
    <Card>
      <CardHeader
        title="Register a bank account"
        description="The school's own accounts. The same record is what a payout batch debits, which is why an account has to be marked for payouts explicitly."
        action={
          <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Add an account'}
          </Button>
        }
      />
      {open && (
        <div className="space-y-5 p-5">
          <FormGrid>
            <Field label="Name it" required hint="What the school calls it">
              <Input value={label} onChange={setLabel} placeholder="SBI main collection" />
            </Field>
            <Field label="Bank" required>
              <Input value={bankName} onChange={setBankName} placeholder="State Bank of India" />
            </Field>
            <Field label="Branch">
              <Input value={branch} onChange={setBranch} placeholder="Ameerpet" />
            </Field>
            <Field label="Account number" required>
              <Input value={account} onChange={setAccount} placeholder="50100234567890" />
            </Field>
            <Field
              label="IFSC"
              required
              hint="Eleven characters: four letters, a zero, then six more"
            >
              <Input value={ifsc} onChange={(v) => setIfsc(v.toUpperCase())} placeholder="SBIN0001234" />
            </Field>
            <Field
              label="Use for payouts"
              hint="Only accounts marked here can be debited by a payout batch. It stops the collection account being emptied by accident."
            >
              <Select
                value={payouts ? 'yes' : 'no'}
                onChange={(v) => setPayouts(v === 'yes')}
                options={[
                  { value: 'no', label: 'Collections only' },
                  { value: 'yes', label: 'Payouts allowed' },
                ]}
              />
            </Field>
          </FormGrid>
          <FormNotice error={save.error} ok={save.isSuccess ? 'Account registered.' : undefined} />
          <Button
            disabled={!label || !bankName || !account || !ifsc || save.isPending}
            onClick={() => save.mutate()}
          >
            Register the account
          </Button>
        </div>
      )}
    </Card>
  )
}
