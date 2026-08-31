import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Phone } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid,
  Table, Td, Button, Input, Select, Loading, ErrorState, ExportButton, useSort, FormNotice,
} from '@/components/ui'
import { formatPaise, formatDate, cn } from '@/lib/utils'

interface Schedule {
  days_before: number
  /* Several, not one. A school that wants both a text and a WhatsApp message
     is not unusual, and the two reach different people in the same house. */
  channels: string[]
  active: boolean
  repeat_days: number
  max_attempts: number
}

interface Defaulter {
  student_id: string; admission_no: string; full_name: string
  class_name?: string; section_name?: string
  guardian_name?: string; phone?: string
  /* When this family was last chased. An accountant working down a list needs
     to know they wrote yesterday, or the diligent families get four reminders
     in a week and stop reading any of them. */
  last_reminded?: string
  balance_paise: number; oldest_due?: string; days_overdue: number; bucket: string
}

const BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const

/** Aging report. The guardian's phone is on every row because the only useful
    next action from this screen is to call them. */
export default function Defaulters() {
  const qc = useQueryClient()
  const [bucket, setBucket] = useState('')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  /* The app alert always goes; these cost money per message, so they are
     chosen per send rather than assumed. */
  const [channels, setChannels] = useState<Record<string, boolean>>({})
  const [sent, setSent] = useState('')
  const [find, setFind] = useState('')

  /* Chasing now, rather than by rule. The plan engine keeps the standing
     arrangement; this is the Tuesday somebody looks at a section and wants
     those eleven families told today. */
  /* The standing arrangement: remind the family N days before the fee is due.

     The rules engine has expressed this all along — a plan whose first chase
     is a negative number of days fires before the deadline — but the screen
     that edits plans asks for an event, a condition, an audience, a template
     code and a quiet window. That is right for somebody building an
     automation and wrong for the person who wants one sentence to be true. */
  const schedule = useQuery({
    queryKey: ['fee-reminder-schedule'],
    queryFn: () => api.get<Schedule>('/api/v1/fees/reminders/schedule'),
  })
  const [sched, setSched] = useState<Schedule | null>(null)
  const plan = sched ?? schedule.data ?? null
  const saveSchedule = useMutation({
    mutationFn: (v: Schedule) => api.put('/api/v1/fees/reminders/schedule', v),
    onSuccess: () => {
      setSched(null)
      schedule.refetch()
      setSent('Automatic reminder saved.')
    },
  })

  const remind = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ told: number; messages_queued: number; no_account: number }>(
        '/api/v1/fees/reminders/send', {
          student_ids: ids,
          channels: Object.keys(channels).filter((k) => channels[k]),
        }),
    onSuccess: (r) => {
      const paid = Object.keys(channels).filter((k) => channels[k])
      /* Said in full, because "Reminded 0 people in the app" about a send
         that texted eleven families reads as a broken button. A family with
         no login is reachable by SMS and not by the bell. */
      setSent(
        `Reminded ${r.told} in the app`
        + (r.messages_queued
          ? ` · ${r.messages_queued} ${paid.join(' / ')} ${r.messages_queued === 1 ? 'message' : 'messages'} queued`
          : '')
        + (r.no_account
          ? ` · ${r.no_account} ${r.no_account === 1 ? 'parent has' : 'parents have'} no app account`
          : '')
        + '.'
        + (r.told === 0 && r.messages_queued === 0
          ? ' Nothing was sent: these families have no app account, and no channel was ticked.'
          : ''),
      )
      setPicked({})
      /* The list has to come again, or "Last reminded" still says never about
         the family somebody has just written to — which reads as a send that
         did not happen. */
      qc.invalidateQueries({ queryKey: ['defaulters'] })
    },
    onError: () => setSent(''),
  })

  /* Everybody who owes, not only the late.

     This was an ageing report — invoices past their due date — which is right
     for "who is late" and wrong for "who do I chase". A school sending the
     September reminder wants the family whose instalment falls due next week
     as much as the one already a fortnight over, and that family was invisible
     here: two names on screen while eleven owed money. */
  const { data, isLoading, error } = useQuery({
    queryKey: ['defaulters', 'all'],
    queryFn: () => api.get<List<Defaulter>>('/api/v1/fees/defaulters?all=1'),
  })

  const all = data?.items ?? []

  const needle = find.trim().toLowerCase()
  const rows = all
    .filter((d) => (bucket ? d.bucket === bucket : true))
    .filter((d) =>
      !needle
      || d.full_name.toLowerCase().includes(needle)
      || d.admission_no.toLowerCase().includes(needle)
      || (d.guardian_name ?? '').toLowerCase().includes(needle))

  const ticked = rows.filter((d) => picked[d.student_id])
  // Nothing ticked means everybody on screen — the same rule the report card
  // queues follow, so one habit works across the product.
  const toRemind = ticked.length ? ticked : rows
  /* Biggest balance first by default.

     A defaulter list read in admission-number order is a list nobody works
     down; the money is the reason the screen exists. */
  const sort = useSort<Defaulter>(
    rows,
    (d, k) => (d as unknown as Record<string, string | number | undefined>)[k],
    { key: 'balance_paise', dir: 'desc' },
  )
  const totals = BUCKETS.map((b) => ({
    bucket: b,
    count: all.filter((d) => d.bucket === b).length,
    amount: all.filter((d) => d.bucket === b).reduce((a, d) => a + d.balance_paise, 0),
  }))

  return (
    <>
      <PageHead
        eyebrow="Fee Workspace"
        title="Defaulters & aging"
        description="Balances past their due date, bucketed by age, with the guardian to contact. Not the same figure as the fee overview's outstanding, which is this year's bills whether due yet or not."
        actions={
          <>
            {/* Finding one child in six hundred.

                An accountant opens this because a parent is at the counter or
                on the telephone, not to read the whole list — and the list is
                sorted by money, which is the wrong order for finding a name.
                Name, admission number and the guardian all match, because
                which of the three they have to hand depends on who rang. */}
            <Input
              value={find}
              onChange={setFind}
              placeholder="Find a student, admission no. or parent"
              className="w-72"
            />
            <ExportButton report="defaulters" />
            <Select
              value={bucket}
              onChange={setBucket}
              placeholder="All buckets"
              options={BUCKETS.map((b) => ({ value: b, label: `${b} days` }))}
            />
          </>
        }
      />
      <PageBody>
        {/* THE STANDING ARRANGEMENT, ABOVE THE ONE-OFF.

            A school sets this once a year and then chases by hand only the
            families the automation has not moved. Putting it first says which
            of the two is meant to do most of the work. */}
        {plan && (
          <Card>
            <CardHeader
              title="Automatic reminder"
              action={
                /* The state, where a person looks for it: at the top right of
                   the thing it governs, not in a tick box among the numbers. */
                <label className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={plan.active}
                    onChange={(e) => setSched({ ...plan, active: e.target.checked })}
                  />
                  <span className={plan.active ? 'font-medium text-success' : 'text-muted-foreground'}>
                    {plan.active ? 'On' : 'Off'}
                  </span>
                </label>
              }
            />
            <div className="space-y-5 px-5 pb-5 pt-4">
              {/* Two questions, asked in the order somebody answers them:
                  what do we send it on, and when. The numbers used to sit in a
                  row of five boxes with their labels above them, which reads
                  as a form rather than as a sentence about what will happen. */}
              <div>
                <p className="eyebrow mb-2">Send messages via</p>
                <div className="flex flex-wrap items-center gap-4 text-[13px]">
                  {(['whatsapp', 'sms', 'email'] as const).map((ch) => (
                    <label key={ch} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={plan.channels.includes(ch)}
                        onChange={(e) =>
                          setSched({
                            ...plan,
                            channels: e.target.checked
                              ? [...plan.channels, ch]
                              : plan.channels.filter((x) => x !== ch),
                          })}
                      />
                      {ch === 'sms' ? 'SMS' : ch === 'whatsapp' ? 'WhatsApp' : 'Email'}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <p className="eyebrow mb-2">Schedule</p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-3 text-[13px]">
                  <span>Start sending</span>
                  <Input
                    type="number"
                    className="w-20 text-center"
                    value={String(plan.days_before)}
                    onChange={(v) => setSched({ ...plan, days_before: Number(v) || 0 })}
                  />
                  <span>days before the due date, then repeat every</span>
                  <Input
                    type="number"
                    className="w-20 text-center"
                    value={String(plan.repeat_days)}
                    onChange={(v) => setSched({ ...plan, repeat_days: Number(v) || 0 })}
                  />
                  <span>days, up to</span>
                  <Input
                    type="number"
                    className="w-16 text-center"
                    value={String(plan.max_attempts)}
                    onChange={(v) => setSched({ ...plan, max_attempts: Number(v) || 1 })}
                  />
                  <span>times.</span>
                </div>
              </div>

              <p className="rounded-xl border bg-muted/30 p-3 text-[12.5px] text-muted-foreground">
                {plan.active && plan.channels.length > 0
                  ? `Parents and the student get a ${plan.channels.join(' and ')} reminder ${plan.days_before} day${plan.days_before === 1 ? '' : 's'} before the instalment is due`
                    + (plan.repeat_days > 0
                      ? `, then every ${plan.repeat_days} days, ${plan.max_attempts} time${plan.max_attempts === 1 ? '' : 's'} at most. `
                      : '. ')
                    + 'Reminders stop the moment the money is in.'
                  : plan.active
                    ? 'Choose at least one channel, or switch this off.'
                    : 'Nothing is sent automatically. Families are chased only when somebody presses Remind below.'}
              </p>

              <div className="flex items-center justify-end gap-3">
                <FormNotice error={saveSchedule.error} />
                <Button
                  disabled={saveSchedule.isPending || !sched}
                  onClick={() => sched && saveSchedule.mutate(sched)}
                >
                  {saveSchedule.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* The summary IS the filter.

            Four figures and a separate dropdown asking the same question is
            one control too many: somebody reading "₹23,667 in 0–30 days" wants
            those families, and reaching for a select to say so is a step that
            exists only because the figures were not pressable. */}
        <CellGrid cols={4}>
          {totals.map((t) => (
            <button
              key={t.bucket}
              type="button"
              onClick={() => setBucket(bucket === t.bucket ? '' : t.bucket)}
              className={cn('cell text-left', bucket === t.bucket && 'ring-2 ring-primary')}
            >
              <span className="block text-[12px] text-muted-foreground">{t.bucket} days</span>
              <span className="mt-1 block text-[22px] font-semibold tabular-nums">
                {formatPaise(t.amount)}
              </span>
              <span className="mt-0.5 block text-[12px] text-muted-foreground">
                {t.count} {t.count === 1 ? 'student' : 'students'}
                {bucket === t.bucket && ' · showing'}
              </span>
            </button>
          ))}
        </CellGrid>

        {/* The by-section card is gone. It answered "which section owes",
            which is a question about a report; this screen is worked one
            family at a time, and the grouping was a second list to read
            before reaching the first. */}

        {/* "Overdue", not "outstanding". This list is invoices past their due
            date and nothing else; the fee overview's outstanding is this
            year's bills whether due or not, and the executive dashboard's is
            every unpaid invoice of every year. Calling all three "outstanding"
            is what made one screen say ₹6,66,625 while another said ₹6,32,875
            about what looked like the same money. */}
        <Card>
          {/* "Overdue accounts" was the old truth: the list is everybody who
              owes now, whether the date has passed or not. */}
          <CardHeader
            title="Who owes"
            action={
              <div className="flex flex-wrap items-center gap-3">
                {(['sms', 'whatsapp', 'email'] as const).map((ch) => (
                  <label key={ch} className="flex items-center gap-1.5 text-[13px]">
                    <input
                      type="checkbox"
                      checked={!!channels[ch]}
                      onChange={(e) => setChannels({ ...channels, [ch]: e.target.checked })}
                    />
                    {ch === 'sms' ? 'SMS' : ch === 'whatsapp' ? 'WhatsApp' : 'Email'}
                  </label>
                ))}
                <Button
                  size="sm"
                  disabled={remind.isPending || toRemind.length === 0}
                  onClick={() => remind.mutate(toRemind.map((d) => d.student_id))}
                >
                  {remind.isPending
                    ? 'Sending…'
                    : ticked.length
                      ? `Remind ${ticked.length} selected`
                      : `Remind all ${rows.length} shown`}
                </Button>
              </div>
            }
          />
          {/* Said next to the button, because it is what the button will do. */}
          <p className="px-5 pt-3 text-[13px] text-muted-foreground">
            {rows.length} of {all.length} ·{' '}
            {formatPaise(rows.reduce((a, d) => a + d.balance_paise, 0))} overdue.
            The app alert always goes to the parent and the student; the boxes
            above are what the school pays for.
          </p>
          <div className="px-5">
            <FormNotice error={remind.error} ok={sent} />
          </div>
          {isLoading ? (
            <Loading />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <>
            <Table
              head={[
                '',
                { label: 'Admission no.', key: 'admission_no' },
                { label: 'Student', key: 'full_name' },
                { label: 'Class', key: 'class_name' },
                'Guardian',
                { label: 'Oldest due', key: 'oldest_due' },
                { label: 'Overdue', key: 'days_overdue' },
                { label: 'Balance', key: 'balance_paise' },
                'Last reminded',
                '',
              ]}
              sort={sort}
              empty={!rows.length}
              emptyLabel="No overdue balances."
            >
              {sort.sorted.map((d) => (
                <tr key={d.student_id}>
                  <Td>
                    <input
                      type="checkbox"
                      checked={!!picked[d.student_id]}
                      onChange={(e) =>
                        setPicked({ ...picked, [d.student_id]: e.target.checked })}
                      aria-label={`Select ${d.full_name}`}
                    />
                  </Td>
                  <Td className="whitespace-nowrap font-mono text-[12px]">{d.admission_no}</Td>
                  <Td className="font-medium">{d.full_name}</Td>
                  <Td>{d.class_name ? `${d.class_name}-${d.section_name}` : '—'}</Td>
                  <Td>
                    {d.guardian_name ?? '—'}
                    {d.phone && (
                      <a href={`tel:${d.phone}`} className="ml-2 inline-flex items-center gap-1 text-[12px] text-primary">
                        <Phone className="h-3 w-3" />{d.phone}
                      </a>
                    )}
                  </Td>
                  <Td className="text-muted-foreground">{formatDate(d.oldest_due)}</Td>
                  <Td>{d.days_overdue}d</Td>
                  <Td className="whitespace-nowrap font-medium tabular-nums">
                    {formatPaise(d.balance_paise)}
                  </Td>
                  {/* So nobody sends a fourth reminder in a week to the family
                      who has been reading all of them. */}
                  <Td className="whitespace-nowrap text-[12.5px] text-muted-foreground">
                    {d.last_reminded ? d.last_reminded.replace('T', ' ') : 'never'}
                  </Td>
                  <Td>
                    {/* One family, without ticking anything. The commonest
                        send is a single reminder to the family somebody has
                        just been reading about. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={remind.isPending}
                      onClick={() => remind.mutate([d.student_id])}
                    >
                      Remind
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
            </>
          )}
        </Card>
      </PageBody>
    </>
  )
}
