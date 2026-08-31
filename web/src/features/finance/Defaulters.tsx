import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Phone } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid,
  Table, Td, Badge, Button, Input, Select, Loading, ErrorState, ExportButton, useSort, FormNotice,
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
  balance_paise: number; oldest_due?: string; days_overdue: number; bucket: string
}

const BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const
const TONE: Record<string, 'neutral' | 'warning' | 'danger'> = {
  '0-30': 'neutral', '31-60': 'warning', '61-90': 'danger', '90+': 'danger',
}

/** Aging report. The guardian's phone is on every row because the only useful
    next action from this screen is to call them. */
export default function Defaulters() {
  const [bucket, setBucket] = useState('')
  /* Which section is being looked at, if any.

     "₹23.7K overdue across 2 students" is the whole school in one number, and
     the person chasing it works a section at a time — the class teacher they
     ring, the parents' evening they raise it at. A list of names sorted by
     amount cannot be worked that way: it interleaves eleven sections and the
     reader has to hold the grouping in their head. */
  const [section, setSection] = useState('')
  /* Who to chase. Ticked explicitly rather than "everybody shown", because a
     filter re-read at the moment the button is pressed can have gained a
     family since the accountant looked. */
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  /* The app alert always goes; these cost money per message, so they are
     chosen per send rather than assumed. */
  const [channels, setChannels] = useState<Record<string, boolean>>({})
  const [sent, setSent] = useState('')

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
      api.post<{ told: number; messages_queued: number }>('/api/v1/fees/reminders/send', {
        student_ids: ids,
        channels: Object.keys(channels).filter((k) => channels[k]),
      }),
    onSuccess: (r) => {
      const paid = Object.keys(channels).filter((k) => channels[k])
      setSent(
        `Reminded ${r.told} ${r.told === 1 ? 'person' : 'people'} in the app`
        + (r.messages_queued
          ? ` · ${r.messages_queued} ${paid.join(' / ')} ${r.messages_queued === 1 ? 'message' : 'messages'} queued.`
          : '.'),
      )
      setPicked({})
    },
    onError: () => setSent(''),
  })

  const { data, isLoading, error } = useQuery({
    queryKey: ['defaulters'],
    queryFn: () => api.get<List<Defaulter>>('/api/v1/fees/defaulters'),
  })

  const all = data?.items ?? []

  /** One line per class-section: how many families, and how much. */
  const bySection = (() => {
    const m = new Map<string, { label: string; students: number; paise: number }>()
    for (const d of all) {
      const label = d.class_name ? `${d.class_name}-${d.section_name ?? ''}` : 'No class'
      const row = m.get(label) ?? { label, students: 0, paise: 0 }
      row.students += 1
      row.paise += d.balance_paise
      m.set(label, row)
    }
    // Most owed first: it is the order somebody would work them in.
    return [...m.values()].sort((a, b) => b.paise - a.paise)
  })()

  const labelOf = (d: Defaulter) =>
    d.class_name ? `${d.class_name}-${d.section_name ?? ''}` : 'No class'

  const rows = all
    .filter((d) => (bucket ? d.bucket === bucket : true))
    .filter((d) => (section ? labelOf(d) === section : true))

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
            <CardHeader title="Automatic reminder" />
            <div className="flex flex-wrap items-end gap-4 px-5 pb-5 pt-4">
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={plan.active}
                  onChange={(e) => setSched({ ...plan, active: e.target.checked })}
                />
                On
              </label>
              <label className="flex flex-col gap-1 text-[12.5px]">
                <span className="text-muted-foreground">Days before the due date</span>
                <Input
                  type="number"
                  className="w-28"
                  value={String(plan.days_before)}
                  onChange={(v) => setSched({ ...plan, days_before: Number(v) || 0 })}
                />
              </label>
              <div className="flex flex-col gap-1 text-[12.5px]">
                <span className="text-muted-foreground">By</span>
                <div className="flex flex-wrap items-center gap-3 pb-2 text-[13px]">
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
              <label className="flex flex-col gap-1 text-[12.5px]">
                <span className="text-muted-foreground">Then repeat every</span>
                <Input
                  type="number"
                  className="w-28"
                  value={String(plan.repeat_days)}
                  onChange={(v) => setSched({ ...plan, repeat_days: Number(v) || 0 })}
                />
              </label>
              <label className="flex flex-col gap-1 text-[12.5px]">
                <span className="text-muted-foreground">At most</span>
                <Input
                  type="number"
                  className="w-24"
                  value={String(plan.max_attempts)}
                  onChange={(v) => setSched({ ...plan, max_attempts: Number(v) || 1 })}
                />
              </label>
              <Button
                disabled={saveSchedule.isPending || !sched}
                onClick={() => sched && saveSchedule.mutate(sched)}
              >
                {saveSchedule.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
            <p className="px-5 pb-4 text-[12.5px] text-muted-foreground">
              {/* Read back as a sentence, because a row of numbered boxes is
                  not something anybody can check at a glance. */}
              {plan.active && plan.channels.length > 0
                ? `Every family gets a ${plan.channels.join(' and ')} reminder ${plan.days_before} day${plan.days_before === 1 ? '' : 's'} before their instalment is due`
                  + (plan.repeat_days > 0
                    ? `, then every ${plan.repeat_days} days, ${plan.max_attempts} time${plan.max_attempts === 1 ? '' : 's'} at most.`
                    : '.')
                  + ' The parent and the student are both told in the app; it stops as soon as the money is in.'
                : plan.active
                  ? 'Choose at least one channel, or switch this off.'
                  : 'Nothing is sent automatically. Families are chased only when somebody presses Remind below.'}
            </p>
            <div className="px-5 pb-4">
              <FormNotice error={saveSchedule.error} />
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

        {/* Section by section, before name by name.

            Somebody chasing fees works a section at a time — the class teacher
            they ring, the parents' evening they raise it at — and a list of
            names sorted by amount interleaves eleven sections and leaves the
            reader to do the grouping in their head. Press one to see only its
            families; press it again to come back out. */}
        {bySection.length > 1 && (
          <Card>
            <CardHeader
              title={section ? `${section} — the rest of the school is hidden` : 'By class and section'}
              action={
                section ? (
                  <button
                    type="button"
                    onClick={() => setSection('')}
                    className="text-[13px] font-medium text-primary hover:underline"
                  >
                    Show every section
                  </button>
                ) : undefined
              }
            />
            <ul className="divide-y">
              {bySection.map((r) => (
                <li key={r.label}>
                  <button
                    type="button"
                    onClick={() => setSection(section === r.label ? '' : r.label)}
                    className={cn(
                      'flex w-full flex-wrap items-center gap-3 px-5 py-2.5 text-left hover:bg-muted/40',
                      section === r.label && 'bg-muted/60',
                    )}
                  >
                    <span className="min-w-[7rem] font-medium">{r.label}</span>
                    <span className="flex-1 text-[13px] text-muted-foreground">
                      {r.students} {r.students === 1 ? 'family' : 'families'}
                    </span>
                    <span className="text-[14px] font-semibold tabular-nums">
                      {formatPaise(r.paise)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* "Overdue", not "outstanding". This list is invoices past their due
            date and nothing else; the fee overview's outstanding is this
            year's bills whether due or not, and the executive dashboard's is
            every unpaid invoice of every year. Calling all three "outstanding"
            is what made one screen say ₹6,66,625 while another said ₹6,32,875
            about what looked like the same money. */}
        <Card>
          <CardHeader
            title="Overdue accounts"
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
                { label: 'Age', key: 'days_overdue' },
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
                  <Td><Badge tone={TONE[d.bucket]}>{d.bucket}</Badge></Td>
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
          )}
        </Card>
      </PageBody>
    </>
  )
}
