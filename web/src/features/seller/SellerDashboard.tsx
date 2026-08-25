import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Building2, Megaphone, TrendingUp } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, Button, Input, Textarea, Field, FormGrid, FormNotice, Select,
  Loading, ErrorState, EmptyState, ConfirmButton,
} from '@/components/ui'
import { formatPaise, formatDate } from '@/lib/utils'

/* The vendor's own first screen.

   Every other role in the product opens on a dashboard; Seller Admin opened on
   a table of schools, with the four numbers that actually describe the
   business squeezed above it as a header. So the question "how is the business
   doing" was answered by a directory, and the answer to "is anything wrong
   right now" was nowhere at all.

   Three things belong here and nowhere else: what the book looks like, whether
   the installation is being used, and the one control that talks to every
   school at once. Anything about a single school belongs inside that school —
   a vendor dashboard showing one school's fee collection is a vendor reading
   somebody else's post. */

interface Tenant {
  id: string
  name: string
  status: string
  students: number
  plan?: string
  plan_name?: string
  subscription_status?: string
  renews_on?: string
  licensed_students?: number
  over_by: number
  setup_percent: number
  last_sign_in?: string
  created_on: string
}

interface Plan {
  code: string
  name: string
  price_paise: number
  max_students: number
}

interface Notice {
  id: string
  severity: 'info' | 'warning' | 'critical'
  title: string
  body?: string
  starts_at: string
  ends_at?: string
  created_by?: string
  live: boolean
}

const SEVERITY_TONE = {
  info: 'info',
  warning: 'warning',
  critical: 'danger',
} as const

const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000

export default function SellerDashboard() {
  const qc = useQueryClient()

  const tenants = useQuery({
    queryKey: ['seller-tenants'],
    queryFn: () => api.get<List<Tenant>>('/api/v1/seller/tenants'),
  })
  const plans = useQuery({
    queryKey: ['seller-plans'],
    queryFn: () => api.get<List<Plan>>('/api/v1/seller/plans'),
  })
  const notices = useQuery({
    queryKey: ['platform-broadcasts'],
    queryFn: () => api.get<List<Notice>>('/api/v1/seller/broadcasts'),
  })

  const [composing, setComposing] = useState(false)
  const [form, setForm] = useState({
    severity: 'info',
    title: '',
    body: '',
    starts_at: '',
    ends_at: '',
  })

  const raise = useMutation({
    mutationFn: () =>
      api.post('/api/v1/seller/broadcasts', {
        severity: form.severity,
        title: form.title,
        body: form.body || undefined,
        starts_at: form.starts_at || undefined,
        ends_at: form.ends_at || undefined,
      }),
    onSuccess: () => {
      setComposing(false)
      setForm({ severity: 'info', title: '', body: '', starts_at: '', ends_at: '' })
      qc.invalidateQueries({ queryKey: ['platform-broadcasts'] })
    },
  })

  const retire = useMutation({
    mutationFn: (id: string) => api.del(`/api/v1/seller/broadcasts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-broadcasts'] }),
  })

  if (tenants.isLoading) return <Loading label="Reading the book…" />
  if (tenants.error) return <ErrorState error={tenants.error} />

  const rows = tenants.data?.items ?? []
  const live = rows.filter((t) => t.subscription_status === 'active').length
  const trials = rows.filter((t) => t.subscription_status === 'trial').length
  const suspended = rows.filter((t) => t.status === 'suspended').length

  /* Onboarding and stalled are different questions. A school three days in at
     40% is progressing; counting it as a problem is how a vendor learns to
     ignore the number. Both are shown, and only the second asks for anybody. */
  const onboarding = rows.filter(
    (t) => t.setup_percent < 100 && t.status !== 'suspended',
  ).length
  const stalled = rows.filter(
    (t) => t.setup_percent < 60 && t.status !== 'suspended',
  ).length

  /* Monthly, not annual.

     A book of mixed contracts only adds up if everything is expressed over the
     same period, which is what MRR means and why every vendor reads it. Annual
     plans are divided by twelve rather than dropped. */
  const mrrPaise = rows.reduce((n, t) => {
    if (t.subscription_status !== 'active') return n
    const p = plans.data?.items.find((x) => x.code === t.plan)
    return p ? n + Math.round(p.price_paise / 12) : n
  }, 0)

  /* Whether the thing all of them run on is well.

     There was no health figure anywhere: a vendor could read a panel of green
     revenue while a school's sign-ins were failing. Schools nobody has signed
     into for a fortnight is the cheapest honest proxy — it catches an outage,
     a rollout that stopped, and a school that has quietly given up, all of
     which the vendor wants to know about today rather than at renewal. */
  const quiet = rows.filter((t) => {
    if (t.status === 'suspended') return false
    if (!t.last_sign_in) return true
    const at = Date.parse(t.last_sign_in)
    return Number.isFinite(at) && Date.now() - at > FORTNIGHT_MS
  })

  const overCap = rows.filter((t) => t.over_by > 0)
  const noticeRows = notices.data?.items ?? []
  const liveNotices = noticeRows.filter((n) => n.live)

  return (
    <>
      <PageHead
        eyebrow="Platform"
        title="The business"
        description="What the book looks like, whether the schools are actually using it, and the one place to tell all of them something at once."
        actions={
          <Button onClick={() => setComposing((v) => !v)}>
            <Megaphone className="h-3.5 w-3.5" />
            {composing ? 'Cancel' : 'Broadcast a notice'}
          </Button>
        }
      />
      <PageBody>
        <CellGrid cols={4}>
          <Stat
            label="Active school tenants"
            value={live}
            icon={Building2}
            hint={
              [trials ? `${trials} on trial` : '', suspended ? `${suspended} suspended` : '']
                .filter(Boolean)
                .join(' · ') || `${rows.length} in total`
            }
          />
          <Stat
            label="In onboarding"
            value={onboarding}
            delta={
              stalled
                ? { value: `${stalled} stalled under 60%`, positive: false }
                : { value: 'All progressing', positive: true }
            }
          />
          <Stat
            label="Monthly recurring revenue"
            value={formatPaise(mrrPaise)}
            icon={TrendingUp}
            hint="Annual plans counted as a twelfth"
          />
          <Stat
            label="Infrastructure health"
            value={quiet.length ? `${quiet.length} quiet` : 'All active'}
            icon={Activity}
            delta={
              quiet.length
                ? { value: 'No sign-in in a fortnight', positive: false }
                : { value: 'Every school signed in recently', positive: true }
            }
          />
        </CellGrid>

        {/* The notice, above everything, because a live one is the most
            important thing on the vendor's own screen too — and because a
            vendor who cannot see what they broadcast forgets to take it down. */}
        {composing && (
          <Card>
            <CardHeader
              title="Broadcast to every school"
              description="This appears to every signed-in user on the installation — principals, teachers, parents. Not a circular: a circular belongs to one school and reaches its own families."
            />
            {/* Card draws the border; the screen supplies the padding inside
                it. Without this the fields ran to the card's own edge and the
                button was clipped by it. */}
            <div className="space-y-4 px-5 pb-5">
              {raise.isError && <FormNotice error={raise.error} />}
              <FormGrid>
              <Field label="Kind" required>
                <Select
                  value={form.severity}
                  onChange={(v) => setForm({ ...form, severity: v })}
                  options={[
                    { value: 'info', label: 'Notice — something to know' },
                    { value: 'warning', label: 'Warning — something is coming' },
                    { value: 'critical', label: 'Critical — something is wrong now' },
                  ]}
                />
              </Field>
              <Field label="Title" required hint="The only part most people read.">
                <Input
                  value={form.title}
                  onChange={(v) => setForm({ ...form, title: v })}
                  placeholder="Maintenance on Sunday, 6am to 6.30am"
                />
              </Field>
              <Field label="From" hint="Leave blank to show it now.">
                <Input
                  type="datetime-local"
                  value={form.starts_at}
                  onChange={(v) => setForm({ ...form, starts_at: v })}
                />
              </Field>
              <Field label="Until" hint="Leave blank to keep it up until you take it down.">
                <Input
                  type="datetime-local"
                  value={form.ends_at}
                  onChange={(v) => setForm({ ...form, ends_at: v })}
                />
              </Field>
              <Field label="Detail" wide>
                <Textarea
                  value={form.body}
                  onChange={(v) => setForm({ ...form, body: v })}
                  rows={3}
                  placeholder="Fee payments will be unavailable. Nothing already recorded is affected."
                />
              </Field>
              </FormGrid>
              <Button
                onClick={() => raise.mutate()}
                disabled={!form.title.trim() || raise.isPending}
              >
                {raise.isPending ? 'Publishing…' : 'Publish to every school'}
              </Button>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Notices"
            description={
              liveNotices.length
                ? `${liveNotices.length} showing to every school right now`
                : 'Nothing is showing to the schools at the moment.'
            }
          />
          <Table
            head={['', 'Notice', 'From', 'Until', 'Raised by', '']}
            empty={noticeRows.length === 0}
            emptyLabel="No notice has been broadcast yet."
          >
            {noticeRows.map((n) => (
              <tr key={n.id}>
                <Td>
                  <Badge tone={SEVERITY_TONE[n.severity]}>
                    {n.live ? n.severity : n.ends_at && !n.live ? 'ended' : 'scheduled'}
                  </Badge>
                </Td>
                <Td>
                  <div className="font-medium">{n.title}</div>
                  {n.body && (
                    <div className="text-[12.5px] text-muted-foreground">{n.body}</div>
                  )}
                </Td>
                <Td className="num text-muted-foreground">{n.starts_at.replace('T', ' ')}</Td>
                <Td className="num text-muted-foreground">
                  {n.ends_at ? n.ends_at.replace('T', ' ') : 'until taken down'}
                </Td>
                <Td className="text-muted-foreground">{n.created_by ?? '—'}</Td>
                <Td>
                  {n.live && (
                    <ConfirmButton
                      confirmLabel="Take it down"
                      question="Every school stops seeing this. The record of it is kept."
                      onConfirm={() => retire.mutate(n.id)}
                      disabled={retire.isPending}
                    >
                      Take down
                    </ConfirmButton>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>

        {/* What needs somebody today. Deliberately three narrow lists rather
            than one "alerts" feed: each has a different remedy, and a mixed
            feed is a feed nobody works through. */}
        <Card>
          <CardHeader
            title="Needs attention"
            description="Schools that are stalled, over their plan, or have gone quiet."
          />
          {stalled === 0 && overCap.length === 0 && quiet.length === 0 ? (
            <EmptyState
              title="Nothing to chase"
              body="Every school is progressing, inside its plan, and being used."
            />
          ) : (
            <Table head={['School', 'What', 'Detail']} empty={false}>
              {rows
                .filter(
                  (t) =>
                    t.status !== 'suspended' &&
                    (t.setup_percent < 60 || t.over_by > 0 || quiet.includes(t)),
                )
                .map((t) => {
                  const why =
                    t.setup_percent < 60
                      ? 'Rollout stalled'
                      : t.over_by > 0
                        ? 'Over its plan'
                        : 'Gone quiet'
                  const detail =
                    t.setup_percent < 60
                      ? `${t.setup_percent}% set up`
                      : t.over_by > 0
                        ? `${t.students} students against ${t.licensed_students ?? '—'} licensed — ${t.over_by} over`
                        : t.last_sign_in
                          ? `Last sign-in ${formatDate(t.last_sign_in)}`
                          : 'Nobody has ever signed in'
                  return (
                    <tr key={t.id}>
                      <Td className="font-medium">{t.name}</Td>
                      <Td>
                        <Badge tone={t.over_by > 0 ? 'danger' : 'warning'}>{why}</Badge>
                      </Td>
                      <Td className="text-muted-foreground">{detail}</Td>
                    </tr>
                  )
                })}
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  )
}
