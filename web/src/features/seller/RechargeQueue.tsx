import { useState } from 'react'
import {
  PageHead, PageBody, Card, CardHeader, Table, Td, Badge, Button, Input,
  FormNotice, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import { useSellerRecharges, useDecideRecharge, type Recharge } from '@/features/super_admin/messaging-lib'
import { formatDate } from '@/lib/utils'

/* THE QUEUE A SCHOOL'S "ASK FOR MORE" LANDS IN.

   The school side of this shipped first: a button that puts a request in a
   queue and shows it sitting there. What did not ship was the queue. A request
   could be made and could be answered only by hand against the API, which
   means it could not be answered at all by the person whose job it is.

   Oldest pending first, because a school that asked yesterday has messages
   held since yesterday, and the fee reminders behind them were due then.

   GRANTING IS ONE STEP AND ONE TRANSACTION. Pressing Grant adds the credits
   and settles the request together, server-side, so a school is never told it
   was handled while still unable to send. The amount defaults to what was
   asked; it can be changed for a partial grant and the difference is recorded
   as what it is, so a year from now the ledger still matches the balance.

   NO MONEY HERE, and that is deliberate. The unit is messages — the one
   quantity both sides can check against the same evidence. Whether the school
   paid, and what for, belongs to whatever you invoice with; this screen would
   only ever hold a second, drifting copy of it. */
export default function RechargeQueue() {
  const q = useSellerRecharges()
  if (q.isLoading) return <SkeletonTable columns={6} label="Reading the recharge queue…" />
  if (q.error) return <ErrorState error={q.error} />

  const items = q.data?.items ?? []
  const pending = items.filter((r) => r.status === 'pending')
  const settled = items.filter((r) => r.status !== 'pending')

  return (
    <>
      <PageHead
        eyebrow="Subscriptions & Billing"
        title="Message credits"
        description="Schools asking for more SMS or WhatsApp messages. Granting adds the credits the same moment; declining tells the school why."
      />
      <PageBody>
        <Card>
          <CardHeader
            title="Waiting"
            action={<Badge tone={pending.length ? 'warning' : 'neutral'}>{pending.length}</Badge>}
          />
          {pending.length === 0 ? (
            <EmptyState
              title="Nothing waiting"
              body="A school's request appears here the moment it is made, oldest first."
            />
          ) : (
            <Table head={['School', 'Channel', 'Asked', 'When', 'By', 'Decision']}>
              {pending.map((r) => <PendingRow key={r.id} r={r} />)}
            </Table>
          )}
        </Card>

        {settled.length > 0 && (
          <Card>
            <CardHeader title="Settled" />
            <Table head={['School', 'Channel', 'Asked', 'Granted', 'Outcome', 'When']}>
              {settled.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.school}</Td>
                  <Td>{label(r.channel)}</Td>
                  <Td>{r.messages.toLocaleString('en-IN')}</Td>
                  <Td>{r.granted != null ? r.granted.toLocaleString('en-IN') : '—'}</Td>
                  <Td>
                    <Badge tone={r.status === 'granted' ? 'success' : r.status === 'declined' ? 'danger' : 'neutral'}>
                      {r.status}
                    </Badge>
                    {r.response ? <span className="ml-2 text-muted-foreground">{r.response}</span> : null}
                  </Td>
                  <Td className="text-muted-foreground">{r.decided_at ? formatDate(r.decided_at) : '—'}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </PageBody>
    </>
  )
}

const label = (ch: string) => (ch === 'sms' ? 'SMS' : ch === 'whatsapp' ? 'WhatsApp' : ch)

function PendingRow({ r }: { r: Recharge }) {
  const decide = useDecideRecharge()
  // Defaults to what was asked, so the common case is one press and no typing.
  const [amount, setAmount] = useState(String(r.messages))
  const [response, setResponse] = useState('')
  const n = Number(amount)
  const valid = Number.isInteger(n) && n >= 0

  return (
    <tr>
      <Td className="font-medium">
        {r.school}
        {r.note ? <div className="text-[12px] text-muted-foreground">“{r.note}”</div> : null}
      </Td>
      <Td>{label(r.channel)}</Td>
      <Td>{r.messages.toLocaleString('en-IN')}</Td>
      <Td className="text-muted-foreground">{formatDate(r.requested_at)}</Td>
      <Td className="text-muted-foreground">{r.requested_by ?? '—'}</Td>
      <Td>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={amount} onChange={setAmount} className="w-[110px]" srLabel="Messages to grant" />
          <Input value={response} onChange={setResponse} placeholder="Note to the school" className="w-[180px]" />
          <Button
            size="sm"
            disabled={!valid || decide.isPending}
            onClick={() => decide.mutate({ id: r.id, decision: 'grant', messages: n, response })}
          >
            Grant{n !== r.messages && valid ? ` ${n.toLocaleString('en-IN')}` : ''}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: r.id, decision: 'decline', response })}
          >
            Decline
          </Button>
        </div>
        <FormNotice error={decide.error} />
      </Td>
    </tr>
  )
}
