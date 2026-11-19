import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Select, Badge,
  ErrorState, EmptyState,
} from '@/components/ui'
import { Freshness, ScreenSkeleton } from './screen-state'
import { useChildren, childOptions, readyFor } from './use-children'
import { ChooseChild } from '@/features/portal/ChooseChild'
import { useT } from '@/lib/i18n'

/* Update my details.
 *
 * The school's record of the family, as the office sees it on Student 360,
 * with the parts the family owns left open to edit: the home address, the
 * child's blood group, and each parent's own name, phone, email and
 * occupation. It saves to the same rows the office reads, so the correction
 * is on Student 360 the moment it is made — and the next absentee call or fee
 * reminder goes to the number that actually rings.
 *
 * The child's name, date of birth, admission number and class are shown and
 * not editable: a parent spots the mistake here and the office fixes it. */

interface Guardian {
  id: string
  full_name: string
  relation: string
  phone: string
  email?: string | null
  occupation?: string | null
  is_primary: boolean
  is_emergency: boolean
  mine: boolean
}

interface Details {
  student_id: string
  full_name: string
  admission_no: string
  class_name?: string | null
  section_name?: string | null
  date_of_birth?: string | null
  gender?: string | null
  blood_group?: string | null
  address_line1?: string | null
  address_line2?: string | null
  city?: string | null
  state?: string | null
  pincode?: string | null
  guardians: Guardian[]
}

function relationLabel(r: string, fallback = '-') {
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : fallback
}

export default function MyDetails() {
  const t = useT()
  const { children: kids, query: kidsQuery, studentId, setChosen } = useChildren()
  const ready = readyFor(kids, studentId)

  const details = useQuery({
    queryKey: ['family-details', studentId],
    queryFn: () => api.get<Details>(`/api/v1/portal/family-details?student_id=${studentId}`),
    enabled: ready && !!studentId,
  })

  const d = details.data

  return (
    <>
      <PageHead
        eyebrow={t('portal.my_details.eyebrow')}
        title={t('portal.my_details.title')}
        actions={
          kids.length > 1 && (
            <Select value={studentId} onChange={setChosen} placeholder={t('portal.my_details.child_placeholder')} options={childOptions(kids)} />
          )
        }
      />
      <Freshness query={details} />
      <PageBody>
        {kidsQuery.isLoading ? (
          <ScreenSkeleton rows={6} label={t('portal.my_details.loading_children')} />
        ) : kidsQuery.error ? (
          <ErrorState error={kidsQuery.error} />
        ) : kids.length === 0 ? (
          <EmptyState title={t('portal.my_details.unlinked_title')} />
        ) : !ready ? (
          <ChooseChild title={t('portal.my_details.choose_child')} />
        ) : details.isLoading || !d ? (
          <ScreenSkeleton rows={8} label={t('portal.my_details.loading_record')} />
        ) : details.error ? (
          <ErrorState error={details.error} />
        ) : (
          <>
            <Card>
              <CardHeader
                title={d.full_name}
                description={t('portal.my_details.child_description')}
              />
              <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
                <Ro label={t('portal.my_details.admission_no')} value={d.admission_no} mono />
                <Ro label={t('portal.my_details.class')} value={d.class_name ? `${d.class_name} ${d.section_name ?? ''}`.trim() : '-'} />
                <Ro label={t('portal.my_details.date_of_birth')} value={d.date_of_birth ?? '-'} />
                <Ro label={t('portal.my_details.gender')} value={d.gender ? relationLabel(d.gender) : '-'} />
              </dl>
            </Card>

            <Card>
              <CardHeader title={t('portal.my_details.home_title')} description={t('portal.my_details.home_description')} />
              <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
                <Ro label={t('portal.my_details.blood_group')} value={d.blood_group || '—'} />
                <Ro label={t('portal.my_details.address_line1')} value={d.address_line1 || '—'} />
                <Ro label={t('portal.my_details.address_line2')} value={d.address_line2 || '—'} />
                <Ro label={t('portal.my_details.city')} value={d.city || '—'} />
                <Ro label={t('portal.my_details.state')} value={d.state || '—'} />
                <Ro label={t('portal.my_details.pincode')} value={d.pincode || '—'} />
              </dl>
            </Card>

            <Card>
              <CardHeader
                title={t('portal.my_details.guardians_title')}
                description={t('portal.my_details.guardians_description')}
              />
              <div className="divide-y">
                {d.guardians.length === 0 && (
                  <p className="px-5 py-4 text-[13px] text-muted-foreground">
                    {t('portal.my_details.no_guardian')}
                  </p>
                )}
                {d.guardians.map((g) => (
                  <div key={g.id} className="px-5 py-4">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-medium">{relationLabel(g.relation, t('portal.my_details.guardian'))}</span>
                      {g.mine && <Badge tone="info">{t('portal.my_details.badge_you')}</Badge>}
                      {g.is_primary && <Badge>{t('portal.my_details.badge_primary')}</Badge>}
                      {g.is_emergency && <Badge tone="warning">{t('portal.my_details.badge_emergency')}</Badge>}
                    </div>
                    {/* Another adult's row is shown, not edited. It used to be
                        four live inputs with only a "you" badge to tell the
                        rows apart, and the write was scoped to the child --
                        so either parent could put their own number against
                        the other's row and take every alert. */}
                    <dl className="grid gap-x-6 gap-y-2 text-[13.5px] sm:grid-cols-2">
                      <div><dt className="text-[12px] text-muted-foreground">{t('portal.my_details.full_name')}</dt><dd>{g.full_name}</dd></div>
                      <div><dt className="text-[12px] text-muted-foreground">{t('portal.my_details.mobile')}</dt><dd>{g.phone || '—'}</dd></div>
                      <div><dt className="text-[12px] text-muted-foreground">{t('portal.my_details.email')}</dt><dd>{g.email || '—'}</dd></div>
                      <div><dt className="text-[12px] text-muted-foreground">{t('portal.my_details.occupation')}</dt><dd>{g.occupation || '—'}</dd></div>
                    </dl>
                  </div>
                ))}
              </div>
            </Card>

            {/* View-only for parents (Yajur, 2026-11-19: "no need to edit their
                details"). A parent spots a mistake here; the office corrects it
                on Student 360. */}
            <p className="text-[12.5px] text-muted-foreground">{t('portal.my_details.others_row_note')}</p>
          </>
        )}
      </PageBody>
    </>
  )
}

function Ro({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono' : ''}>{value}</dd>
    </div>
  )
}
