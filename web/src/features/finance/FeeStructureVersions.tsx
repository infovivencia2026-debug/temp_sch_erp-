import { useState } from 'react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Button, ConfirmButton, Badge, Input, Field, FormGrid, FormNotice,
  Skeleton, ErrorState, EmptyState,
} from '@/components/ui'
import { useToast } from '@/components/Toast'
import { useCan } from '@/lib/session'
import { formatDate } from '@/lib/utils'
import { inr, toPaise } from './ledger-lib'
import {
  feeEngineBase, statusTone, useFeeEngineMutation,
  useStructureVersions, useVersionedStructures,
  type StructureVersion, type VersionItem,
} from './fee-engine-lib'

/* Fee structure versioning.

   A school revises a class's fee in September. The obvious implementation —
   edit fee_structure_items — quietly rewrites history: the ledger says a parent
   owes ₹45,000, the structure now says ₹48,000, and nobody can say which is
   right or what was actually agreed in April.

   So a revision is a new version, not an edit. Invoices keep pointing at the
   version they were raised under, and an activated version is never editable
   again. That is why this screen is built around three verbs — open a revision,
   set its lines, activate it — rather than around a form with a Save button. */

export default function FeeStructureVersions() {
  const toast = useToast()
  const can = useCan()
  const mayEdit = can('finance.fees.write')

  const [openId, setOpenId] = useState('')
  const structures = useVersionedStructures()
  const history = useStructureVersions(openId)

  const rows = structures.data?.items ?? []
  const revised = rows.filter((s) => s.versions > 1).length
  const drafts = rows.filter((s) => s.draft_version).length
  const pinned = rows.reduce((n, s) => n + s.invoices_raised, 0)

  return (
    <>
      <PageHead
        eyebrow="Fees"
        title="Fee structure versioning"
        description="Revise a fee mid-year without changing what was already billed."
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat label="Fee structures" value={rows.length} />
          <Stat
            label="Revised at least once"
            value={revised}
            hint={revised ? 'Earlier versions kept intact' : 'None revised yet'}
          />
          <Stat
            label="Draft revisions open"
            value={drafts}
            hint={drafts ? 'Not yet billing anything' : 'Nothing in progress'}
          />
          <Stat
            label="Invoices pinned to a version"
            value={pinned}
            hint="These cannot change if the fee is revised"
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Structures"
            description="The live version of each, and how often it has been revised"
          />
          {structures.isLoading ? (
            <Skeleton />
          ) : structures.error ? (
            <ErrorState error={structures.error} />
          ) : (
            <Table
              head={['Structure', 'Class', 'Year', 'Live version', 'In force since', 'Billing', 'Invoices', '']}
              empty={!rows.length}
              emptyLabel="No fee structures configured yet."
            >
              {rows.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium">
                    {s.name}
                    {s.draft_version && (
                      <span className="ml-2">
                        <Badge tone="warning">v{s.draft_version} draft</Badge>
                      </span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{s.class_name ?? 'All classes'}</Td>
                  <Td className="text-muted-foreground">{s.academic_year ?? '—'}</Td>
                  <Td>
                    {s.active_version ? (
                      <Badge tone="success">v{s.active_version}</Badge>
                    ) : (
                      <span className="text-muted-foreground">No live version</span>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">
                    {s.effective_from ? formatDate(s.effective_from) : '—'}
                  </Td>
                  <Td className="tabular-nums font-medium">
                    {s.active_total_paise ? inr(s.active_total_paise) : '—'}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">{s.invoices_raised}</Td>
                  <Td>
                    <Button
                      size="sm"
                      variant={openId === s.id ? 'primary' : 'secondary'}
                      onClick={() => setOpenId(openId === s.id ? '' : s.id)}
                    >
                      {openId === s.id ? 'Close' : 'History'}
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        {openId && (
          <VersionHistoryPanel
            structureId={openId}
            mayEdit={mayEdit}
            loading={history.isLoading}
            error={history.error}
            title={history.data?.structure.name ?? 'Version history'}
            versions={history.data?.items ?? []}
            onNotify={toast.ok}
          />
        )}
      </PageBody>
    </>
  )
}

function VersionHistoryPanel({
  structureId, mayEdit, loading, error, title, versions, onNotify,
}: {
  structureId: string
  mayEdit: boolean
  loading: boolean
  error: unknown
  title: string
  versions: StructureVersion[]
  onNotify: (m: string) => void
}) {
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [note, setNote] = useState('')

  const openRevision = useFeeEngineMutation(
    () =>
      api.post<{ version_no: number }>(`${feeEngineBase}/versions`, {
        structure_id: structureId,
        effective_from: effectiveFrom,
        revision_note: note || undefined,
      }),
    (res) => {
      setEffectiveFrom('')
      setNote('')
      // Named, not "Saved": the next thing to do is set its lines, and the
      // version number is what the school will refer to it by.
      onNotify(`Draft v${res.version_no} opened. Set its fee lines, then activate it.`)
    },
  )

  const activate = useFeeEngineMutation(
    (id: string) => api.post<{ version_no: number }>(`${feeEngineBase}/versions/${id}/activate`, {}),
    (res) =>
      onNotify(
        `v${res.version_no} is now live. Invoices already raised keep their earlier version.`,
      ),
  )

  const discard = useFeeEngineMutation(
    (id: string) => api.del(`${feeEngineBase}/versions/${id}`),
    () => onNotify('Draft discarded.'),
  )

  const draft = versions.find((v) => v.status === 'draft')

  return (
    <Card>
      <CardHeader
        title={title}
        description="Newest first. An activated version is frozen — revise it by opening a new one."
      />
      {loading ? (
        <Skeleton />
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <div className="space-y-4">
          <FormNotice
            error={openRevision.error ?? activate.error ?? discard.error}
          />

          {mayEdit && !draft && (
            <div className="rounded-md border border-border p-4">
              <FormGrid>
                <Field
                  label="Open a revision from"
                  required
                  hint="The date the new amounts start to apply. Invoices raised before it are untouched."
                >
                  <Input type="date" value={effectiveFrom} onChange={setEffectiveFrom} />
                </Field>
                <Field label="What changed" hint="Shown beside the version, so nobody has to infer it from two amounts">
                  <Input
                    value={note}
                    onChange={setNote}
                    placeholder="Transport fee revised for the second term"
                  />
                </Field>
              </FormGrid>
              <Button
                onClick={() => openRevision.mutate(undefined as never)}
                disabled={!effectiveFrom || openRevision.isPending}
              >
                Open a draft revision
              </Button>
              <p className="mt-2 text-[11.5px] text-muted-foreground">
                The draft copies the live version's lines, so a revision is a change to what
                exists rather than a blank sheet that might silently drop a head.
              </p>
            </div>
          )}

          {!versions.length ? (
            <EmptyState
              title="No versions recorded"
              body="This structure has no version history yet."
            />
          ) : (
            versions.map((v) => (
              <VersionCard
                key={v.id}
                version={v}
                mayEdit={mayEdit}
                onActivate={() => activate.mutate(v.id)}
                onDiscard={() => discard.mutate(v.id)}
                busy={activate.isPending || discard.isPending}
                onNotify={onNotify}
              />
            ))
          )}
        </div>
      )}
    </Card>
  )
}

function VersionCard({
  version, mayEdit, onActivate, onDiscard, busy, onNotify,
}: {
  version: StructureVersion
  mayEdit: boolean
  onActivate: () => void
  onDiscard: () => void
  busy: boolean
  onNotify: (m: string) => void
}) {
  const editable = version.status === 'draft' && mayEdit

  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Version {version.version_no}</span>
          <Badge tone={statusTone(version.status)}>{version.status}</Badge>
          <span className="text-[11.5px] text-muted-foreground">
            in force from {formatDate(version.effective_from)}
            {version.effective_to ? ` to ${formatDate(version.effective_to)}` : ''}
          </span>
          {version.invoice_count > 0 && (
            <span className="text-[11.5px] text-muted-foreground">
              · {version.invoice_count} invoice{version.invoice_count === 1 ? '' : 's'} raised under it
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums font-medium">{inr(version.total_paise)}</span>
          {editable && (
            <>
              <ConfirmButton
                confirmLabel="Activate"
                question="New invoices will use these amounts. Invoices already raised keep their current version."
                onConfirm={onActivate}
                disabled={busy}
              >
                Activate
              </ConfirmButton>
              <ConfirmButton
                confirmLabel="Discard"
                question="The draft and its lines are removed."
                onConfirm={onDiscard}
                disabled={busy}
                tone="danger"
              >
                Discard
              </ConfirmButton>
            </>
          )}
        </span>
      </div>

      {version.revision_note && (
        <p className="border-b border-border px-4 py-2 text-[12.5px] text-muted-foreground">
          {version.revision_note}
        </p>
      )}

      {editable ? (
        <DraftLineEditor versionId={version.id} items={version.items} onNotify={onNotify} />
      ) : (
        <Table
          head={['Fee head', 'Instalment', 'Due', { label: 'Amount', align: 'right' }, 'Change']}
          empty={!version.items.length}
          emptyLabel="No fee lines on this version."
        >
          {version.items.map((it) => (
            <tr key={it.id}>
              <Td className="font-medium">{it.fee_head}</Td>
              <Td className="text-muted-foreground">{it.instalment_no}</Td>
              <Td className="text-muted-foreground">{it.due_on ? formatDate(it.due_on) : '—'}</Td>
              <Td className="text-right tabular-nums">{inr(it.amount_paise)}</Td>
              <Td>
                <Delta current={it.amount_paise} previous={it.previous_paise} />
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {version.activated_at && (
        <p className="border-t border-border px-4 py-2 text-[11.5px] text-muted-foreground">
          Activated {formatDate(version.activated_at)}
          {version.activated_by ? ` by ${version.activated_by}` : ''}
        </p>
      )}
    </div>
  )
}

/* A revision read as a change rather than as a fresh list of numbers.

   Showing only the new amount makes the reader do the subtraction, and the
   whole point of a version is that somebody can see what moved. */
function Delta({ current, previous }: { current: number; previous?: number }) {
  if (previous === undefined || previous === null) {
    return <span className="text-[11.5px] text-muted-foreground">new</span>
  }
  const diff = current - previous
  if (diff === 0) return <span className="text-[11.5px] text-muted-foreground">unchanged</span>
  return (
    <span className={diff > 0 ? 'text-[11.5px] text-amber-600' : 'text-[11.5px] text-emerald-600'}>
      {diff > 0 ? '+' : '−'}
      {inr(Math.abs(diff))} from {inr(previous)}
    </span>
  )
}

function DraftLineEditor({
  versionId, items, onNotify,
}: {
  versionId: string
  items: VersionItem[]
  onNotify: (m: string) => void
}) {
  // Rupees in the boxes, paise on the wire. The API never sees a decimal.
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((i) => [i.id, String(i.amount_paise / 100)])),
  )

  const save = useFeeEngineMutation(
    () =>
      api.put(`${feeEngineBase}/versions/${versionId}/items`, {
        items: items.map((i) => ({
          fee_head_id: i.fee_head_id,
          instalment_no: i.instalment_no,
          amount_paise: toPaise(amounts[i.id] ?? String(i.amount_paise / 100)),
          due_on: i.due_on || undefined,
        })),
      }),
    () => onNotify('Draft lines saved. Activate the version to start billing them.'),
  )

  if (!items.length) {
    return (
      <div className="px-4 py-4">
        <EmptyState
          title="This draft has no fee lines"
          body="It was copied from a structure with no items. Add fee lines to the structure, then open a fresh revision."
        />
      </div>
    )
  }

  return (
    <div className="space-y-3 px-4 py-3">
      <Table
        head={['Fee head', 'Instalment', { label: 'Amount (₹)', align: 'right' }, 'Was']}
        empty={false}
      >
        {items.map((it) => (
          <tr key={it.id}>
            <Td className="font-medium">{it.fee_head}</Td>
            <Td className="text-muted-foreground">{it.instalment_no}</Td>
            <Td className="text-right">
              <Input
                type="number"
                className="text-right"
                value={amounts[it.id] ?? ''}
                onChange={(v) => setAmounts({ ...amounts, [it.id]: v })}
              />
            </Td>
            <Td className="tabular-nums text-muted-foreground">
              {it.previous_paise !== undefined ? inr(it.previous_paise) : '—'}
            </Td>
          </tr>
        ))}
      </Table>
      <FormNotice error={save.error} ok={save.isSuccess ? 'Saved.' : undefined} />
      <Button onClick={() => save.mutate(undefined as never)} disabled={save.isPending}>
        Save the draft's amounts
      </Button>
    </div>
  )
}
