import { Announcements } from './Announcements'
import { useQuery } from '@tanstack/react-query'
import { Activity, Building2, TrendingUp } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td,
  Badge, SkeletonTiles, ErrorState, EmptyState,
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

const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000

export default function SellerDashboard() {
  const tenants = useQuery({
    queryKey: ['seller-tenants'],
    queryFn: () => api.get<List<Tenant>>('/api/v1/seller/tenants'),
  })
  const plans = useQuery({
    queryKey: ['seller-plans'],
    queryFn: () => api.get<List<Plan>>('/api/v1/seller/plans'),
  })
  if (tenants.isLoading && !tenants.data) return <SkeletonTiles count={2} label="Reading the book…" />
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
  return (
    <>
      <PageHead
        eyebrow="Platform"
        title="The business"
        description="What the book looks like, whether the schools are actually using it, and the one place to tell all of them something at once."
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

        <Announcements />

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
                        ? `${t.students} students against ${t.licensed_students ?? '-'} licensed · ${t.over_by} over`
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
