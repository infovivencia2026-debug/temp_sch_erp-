import { useState } from 'react'
import { Card, CardHeader, Button, Badge, FormNotice } from '@/components/ui'
import {
  useRecharges, useRechargeSizes, useRequestRecharge, useCancelRecharge,
  type CreditBalance,
} from '@/features/super_admin/messaging-lib'

/* ASKING FOR MORE, WHEN THERE ARE NONE LEFT.

   Before this, a school that ran out saw a balance of zero and a top-up form
   it has no permission to use. The next step was a phone call nobody recorded,
   and in the meantime every reminder and absence alert sat held with no
   indication that anybody was dealing with it.

   So there is a button, and pressing it does something: it puts a row in a
   queue the seller works from, and the school can see it sitting there. That
   is worth more than the payment machinery it does not have — what somebody
   needs at this moment is to know the request has landed and that messages
   will resume, not a card form.

   THE UNIT IS MESSAGES AND NOTHING ELSE. No rupees, no vendor names, no
   "transactional". A school counts what it sends; what a bundle costs and what
   a gateway calls it are the seller's business and would be two more numbers to
   keep in step with a bill this screen cannot see. */
export default function Recharge({ credit, name }: { credit: CreditBalance; name: string }) {
  const sizes = useRechargeSizes()
  const recharges = useRecharges()
  const request = useRequestRecharge(credit.channel)
  const cancel = useCancelRecharge()
  const [picked, setPicked] = useState<number | null>(null)

  const open = recharges.data?.items.find(
    (r) => r.channel === credit.channel && r.status === 'pending',
  )
  const lastSettled = recharges.data?.items.find(
    (r) => r.channel === credit.channel && r.status !== 'pending',
  )

  /* Only when it matters. A recharge offer permanently under a healthy balance
     is an advertisement; under an empty or nearly empty one it is the next
     thing to do. */
  if (!credit.metered || (!credit.empty && !credit.low && !open)) return null

  if (open) {
    return (
      <Card>
        <CardHeader
          title={`${name} recharge requested`}
          action={<Badge tone="info">Waiting</Badge>}
        />
        <div className="px-5 pb-5">
          <p className="text-[13px] text-muted-foreground">
            {open.messages.toLocaleString('en-IN')} messages requested. You will see the
            balance change here as soon as it is granted — nothing else is needed from you,
            and messages queued in the meantime go out rather than being lost.
          </p>
          <div className="mt-3">
            <Button variant="ghost" size="sm" onClick={() => cancel.mutate(open.id)}>
              Withdraw the request
            </Button>
          </div>
          <FormNotice error={cancel.error} />
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader
        title={`Recharge ${name}`}
        action={credit.empty ? <Badge tone="danger">Empty</Badge> : <Badge tone="warning">Low</Badge>}
      />
      <div className="px-5 pb-5">
        <p className="text-[13px] text-muted-foreground">
          {credit.empty ? (
            <>
              {name} has stopped. Messages are being held rather than thrown away — ask for
              more and everything queued goes out.
            </>
          ) : (
            <>Running low. Ask for more before it stops.</>
          )}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {(sizes.data?.items ?? []).map((n) => (
            <Button
              key={n}
              size="sm"
              variant={picked === n ? 'primary' : 'secondary'}
              onClick={() => setPicked(n)}
            >
              {n.toLocaleString('en-IN')}
            </Button>
          ))}
        </div>

        <div className="mt-4">
          <Button
            disabled={!picked || request.isPending}
            onClick={() =>
              picked && request.mutate({ messages: picked }, { onSuccess: () => setPicked(null) })
            }
          >
            {picked ? `Ask for ${picked.toLocaleString('en-IN')} messages` : 'Choose an amount'}
          </Button>
        </div>

        <FormNotice error={request.error} />

        {lastSettled && (
          <p className="mt-3 text-[13px] text-muted-foreground">
            Last request: {lastSettled.messages.toLocaleString('en-IN')} asked,{' '}
            {lastSettled.status === 'granted'
              ? `${(lastSettled.granted ?? 0).toLocaleString('en-IN')} granted`
              : lastSettled.status}
            {lastSettled.response ? ` — ${lastSettled.response}` : ''}
          </p>
        )}
      </div>
    </Card>
  )
}
