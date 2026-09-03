import { useState } from 'react'
import {
  Card, CardHeader, Button, Input, Field, FormGrid, FormNotice, Badge,
  Table, Td, SkeletonTable, ErrorState, EmptyState,
} from '@/components/ui'
import {
  useCredits, useCreditEntries, useTopUpCredits,
  type CreditBalance,
} from '@/features/super_admin/messaging-lib'
import { formatDate } from '@/lib/utils'

/* HOW MANY MESSAGES ARE LEFT, AND WHERE THE REST WENT.

   Every SMS and every WhatsApp template costs real money on the school's own
   vendor account. Nothing counted them before, so a reminder rule aimed at the
   wrong audience spent that money at whatever rate the dispatcher managed and
   the first anybody knew was the bill.

   This is a meter, not a till. Nothing is sold here and no money moves through
   the product: the school pays its vendor, and these numbers exist so somebody
   can put a ceiling on a term's sending and have it hold.

   A credit is one message rather than an amount, because that is the unit the
   dispatcher can actually count. Rates differ by vendor, by destination and by
   template, so a rupee figure on this screen would drift from the vendor's own
   invoice while looking authoritative.

   NOT METERED IS NOT THE SAME AS EMPTY, and the screen says so in different
   words. A channel with no meter sends freely; a channel with a meter at zero
   is stopped. Showing "0 left" for the first would be a lie about a channel
   that is working. */
export default function MessageCredits() {
  const credits = useCredits()

  if (credits.isLoading) return <SkeletonTable columns={4} label="Counting what is left…" />
  if (credits.error) return <ErrorState error={credits.error} />

  const items = credits.data?.items ?? []
  return (
    <div className="space-y-5">
      {items.map((c) => (
        <ChannelMeter key={c.channel} credit={c} />
      ))}
    </div>
  )
}

const NAMES: Record<string, string> = { sms: 'SMS', whatsapp: 'WhatsApp' }

function ChannelMeter({ credit }: { credit: CreditBalance }) {
  const name = NAMES[credit.channel] ?? credit.channel
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [low, setLow] = useState(String(credit.low_water))
  const [open, setOpen] = useState(false)
  const topUp = useTopUpCredits(credit.channel)
  const entries = useCreditEntries(credit.channel)

  const n = Number(amount)
  const valid = amount.trim() !== '' && Number.isInteger(n) && n !== 0

  return (
    <Card>
      <CardHeader
        title={`${name} credits`}
        action={
          credit.metered ? (
            <Badge tone={credit.empty ? 'danger' : credit.low ? 'warning' : 'success'}>
              {credit.balance.toLocaleString('en-IN')} left
            </Badge>
          ) : (
            <Badge tone="neutral">Not metered</Badge>
          )
        }
      />

      <div className="px-5 pb-5">
        {/* The state of the channel in one sentence, because the number alone
            does not say what will happen next. */}
        <p className="text-[13px] text-muted-foreground">
          {!credit.metered ? (
            <>
              {name} is sending without a limit. Set a balance to cap what this school can
              spend on your vendor account — until you do, nothing here restricts it.
            </>
          ) : credit.empty ? (
            <>
              {name} is <strong>stopped</strong>. Messages are being held, not thrown away:
              they say so on the message log and go out as soon as you top up.
            </>
          ) : credit.low ? (
            <>Below the {credit.low_water.toLocaleString('en-IN')} you set as the warning point.</>
          ) : (
            <>Each message sent takes one. Email and in-app cost nothing and are never metered.</>
          )}
        </p>

        <div className="mt-4"><FormGrid>
          <Field
            label={credit.metered ? 'Add or remove' : 'Starting balance'}
            hint="A whole number of messages. Negative corrects a mistake."
          >
            <Input
              value={amount}
              onChange={setAmount}
              placeholder="10000"
            />
          </Field>
          <Field label="Warn below" hint="Shown as a warning before it stops.">
            <Input value={low} onChange={setLow} />
          </Field>
          <Field label="Note" hint="What was bought, so the history reads as a record.">
            <Input
              value={note}
              onChange={setNote}
              placeholder="MSG91 · 10k transactional"
            />
          </Field>
        </FormGrid></div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            disabled={!valid || topUp.isPending}
            onClick={() =>
              topUp.mutate(
                {
                  delta: n,
                  low_water: Number.isInteger(Number(low)) ? Number(low) : undefined,
                  note,
                  reason: n < 0 ? 'adjustment' : 'topup',
                },
                { onSuccess: () => { setAmount(''); setNote('') } },
              )
            }
          >
            {n < 0 ? 'Remove credits' : 'Add credits'}
          </Button>
          <Button variant="secondary" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide history' : 'History'}
          </Button>
        </div>

        <FormNotice error={topUp.error} />
      </div>

      {open && (
        <div className="border-t">
          {entries.isLoading ? (
            <SkeletonTable columns={4} label="Reading the history…" />
          ) : entries.error ? (
            <ErrorState error={entries.error} />
          ) : (entries.data?.items ?? []).length === 0 ? (
            <EmptyState
              title="Nothing has moved yet"
              body="Top-ups and sends both appear here, so a vendor's bill can be checked against it."
            />
          ) : (
            <Table head={['When', 'Change', 'Why', 'Who']}>
              {(entries.data?.items ?? []).map((e) => (
                <tr key={e.id}>
                  <Td>{formatDate(e.created_at)}</Td>
                  <Td className={e.delta < 0 ? 'text-muted-foreground' : 'font-medium'}>
                    {e.delta > 0 ? `+${e.delta}` : e.delta}
                  </Td>
                  <Td>
                    {e.reason}
                    {e.note ? <span className="text-muted-foreground"> · {e.note}</span> : null}
                  </Td>
                  <Td className="text-muted-foreground">{e.actor ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      )}
    </Card>
  )
}
