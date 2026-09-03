import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, HardDrive, MessageSquare, Server } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Input, Field, FormGrid, FormNotice, SkeletonTiles, ErrorState,
} from '@/components/ui'
import { formatPaise } from '@/lib/utils'

/* What each school uses, and what it costs to provide.

   A vendor could read what every school pays and nothing about what any of them
   costs, which makes revenue half a sentence: ₹8,000 a month is a good customer
   or a bad one depending on a number nobody had written down.

   The screen is deliberately in two registers, and says which is which.
   Measured facts — bytes stored, records held, messages sent — come from the
   database and are exact. The share of the monthly bill is an allocation, not a
   measurement, because per-school CPU and bandwidth genuinely do not exist in
   this product. Presenting the second as though it were the first is how a
   vendor ends up pricing against a number that was invented. */

interface Costs {
  infra_paise: number
  storage_paise_per_gb: number
  sms_paise: number
  email_paise: number
  whatsapp_paise: number
  notes?: string
  updated_at?: string
  updated_by?: string
}

interface SchoolUsage {
  institution_id: string
  school: string
  status: string
  students: number
  staff: number
  stored_bytes: number
  file_count: number
  rows: number
  messages: number
  share_pct: number
  infra_paise: number
  storage_paise: number
  cost_paise: number
}

interface UsageResponse {
  costs: Costs
  items: SchoolUsage[]
  totals: SchoolUsage
  not_measured: string
}

/** Bytes as a person reads them, not as a machine stores them. */
function bytes(n: number): string {
  if (n <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Rupees in, paise stored. The form talks in the unit the invoice is in. */
const toPaise = (rupees: string) => Math.round((Number(rupees) || 0) * 100)
const toRupees = (paise: number) => (paise / 100).toString()

export default function UsageCost() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['platform-usage'],
    queryFn: () => api.get<UsageResponse>('/api/v1/seller/usage'),
  })

  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({
    infra: '',
    storage: '',
    sms: '',
    email: '',
    whatsapp: '',
    notes: '',
  })

  /* The form is seeded from what is stored, once it has arrived. Without this
     a vendor opening it sees empty boxes and cannot tell whether the costs are
     unset or merely not loaded — and saving would then zero them. */
  useEffect(() => {
    if (!data) return
    setForm({
      infra: toRupees(data.costs.infra_paise),
      storage: toRupees(data.costs.storage_paise_per_gb),
      sms: toRupees(data.costs.sms_paise),
      email: toRupees(data.costs.email_paise),
      whatsapp: toRupees(data.costs.whatsapp_paise),
      notes: data.costs.notes ?? '',
    })
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/seller/costs', {
        infra_paise: toPaise(form.infra),
        storage_paise_per_gb: toPaise(form.storage),
        sms_paise: toPaise(form.sms),
        email_paise: toPaise(form.email),
        whatsapp_paise: toPaise(form.whatsapp),
        notes: form.notes,
      }),
    onSuccess: () => {
      setEditing(false)
      qc.invalidateQueries({ queryKey: ['platform-usage'] })
    },
  })

  if (isLoading) return <SkeletonTiles count={4} label="Adding up what everybody uses…" />
  if (error) return <ErrorState error={error} />
  if (!data) return null

  const rows = [...data.items].sort((a, b) => b.cost_paise - a.cost_paise)
  const unset = data.costs.infra_paise === 0 && data.costs.storage_paise_per_gb === 0

  return (
    <>
      <PageHead
        eyebrow="Usage & health"
        title="Usage & cost"
        description="What each school actually uses, against what the installation costs to run."
        actions={
          <Button onClick={() => setEditing((v) => !v)}>
            {editing ? 'Cancel' : unset ? 'Enter the monthly bill' : 'Edit the bill'}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Files stored"
            value={bytes(data.totals.stored_bytes)}
            icon={HardDrive}
            hint={`${data.totals.file_count} files across every school`}
          />
          <Stat
            label="Records held"
            value={data.totals.rows.toLocaleString('en-IN')}
            icon={Database}
            hint="Attendance, marks, invoices and notices"
          />
          <Stat
            label="Messages sent"
            value={data.totals.messages.toLocaleString('en-IN')}
            icon={MessageSquare}
            hint="Everything the schools have sent out"
          />
          <Stat
            label="Cost to run, a month"
            value={unset ? 'Not entered' : formatPaise(data.totals.cost_paise)}
            icon={Server}
            delta={
              unset
                ? { value: 'Enter the bill to see it per school', positive: false }
                : undefined
            }
          />
        </CellGrid>

        {editing && (
          <Card>
            <CardHeader
              title="What the installation costs you"
              description="Nothing in the product knows what your server or your storage costs — those arrive as invoices by email. Enter them once and every school's share is worked out from what it actually uses."
            />
            <div className="space-y-4 px-5 pb-5">
              {save.isError && <FormNotice error={save.error} />}
              <FormGrid>
                <Field
                  label="Servers and everything monthly (₹)"
                  hint="Hosting, backups, monitoring — anything billed the same whether one school uses it or fifty."
                >
                  <Input value={form.infra} onChange={(v) => setForm({ ...form, infra: v })} placeholder="12000" />
                </Field>
                <Field label="Storage, per GB a month (₹)" hint="Applied to what each school has actually stored.">
                  <Input value={form.storage} onChange={(v) => setForm({ ...form, storage: v })} placeholder="2" />
                </Field>
                <Field label="Per SMS (₹)">
                  <Input value={form.sms} onChange={(v) => setForm({ ...form, sms: v })} placeholder="0.15" />
                </Field>
                <Field label="Per email (₹)">
                  <Input value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="0.02" />
                </Field>
                <Field label="Per WhatsApp message (₹)">
                  <Input value={form.whatsapp} onChange={(v) => setForm({ ...form, whatsapp: v })} placeholder="0.8" />
                </Field>
                <Field label="Note" hint="What these figures came from, for whoever reads them next year." wide>
                  <Input value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} placeholder="Hetzner CPX41 + 500GB volume, invoice of 1 Aug" />
                </Field>
              </FormGrid>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save the bill'}
              </Button>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="School by school"
            description={
              data.costs.updated_at
                ? `Bill entered ${data.costs.updated_at.replace('T', ' ')}${data.costs.updated_by ? ` by ${data.costs.updated_by}` : ''}.`
                : undefined
            }
          />
          <Table
            wide
            head={[
              'School',
              'Students',
              'Stored',
              'Records',
              'Messages',
              'Share',
              'Cost a month',
            ]}
            empty={rows.length === 0}
            emptyLabel="No schools yet."
          >
            {rows.map((s) => (
              <tr key={s.institution_id}>
                <Td className="whitespace-nowrap font-medium">
                  {s.school}
                  {s.status === 'suspended' && (
                    <span className="ml-2 align-middle">
                      <Badge tone="neutral">suspended</Badge>
                    </span>
                  )}
                </Td>
                <Td className="num">{s.students}</Td>
                <Td className="num">
                  {bytes(s.stored_bytes)}
                  {s.file_count > 0 && (
                    <span className="block text-[12px] text-muted-foreground">
                      {s.file_count} files
                    </span>
                  )}
                </Td>
                <Td className="num">{s.rows.toLocaleString('en-IN')}</Td>
                <Td className="num">{s.messages.toLocaleString('en-IN')}</Td>
                {/* The share is an allocation, so it is shown as one — a
                    percentage of the roll, not a measurement of the machine. */}
                <Td className="num text-muted-foreground">{s.share_pct.toFixed(1)}%</Td>
                <Td className="num font-medium">
                  {unset ? '—' : formatPaise(s.cost_paise)}
                  {!unset && s.storage_paise > 0 && (
                    <span className="block text-[12px] font-normal text-muted-foreground">
                      incl. {formatPaise(s.storage_paise)} storage
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {/* Said out loud rather than left to be assumed. A vendor who thinks
            the cost column is measured will price against it. */}
        <Card>
          <CardHeader title="What this screen cannot tell you" />
          <p className="max-w-[72ch] px-5 pb-5 text-[14px] text-muted-foreground">
            {data.not_measured}
          </p>
        </Card>
      </PageBody>
    </>
  )
}
