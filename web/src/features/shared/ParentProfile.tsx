import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Card } from '@/components/ui'
import { PickerMenu } from '@/components/PickerMenu'
import { PhotoViewer } from '@/components/PhotoViewer'
import { useSession } from '@/lib/session'
import { formatDate, cn } from '@/lib/utils'
import { useChildren } from '@/features/portal/use-children'
import { useChildProfile, fileSrc, initials } from '@/features/portal/parent-child'

/* THE PARENT'S PROFILE IS THEIR CHILD (owner, 2026-11-28).

   A parent opening "profile" wants the child's record: photo, class, admission
   number, APAAR ID, date of birth, blood group, and whether the child takes the
   school bus. Anything the school has not recorded reads -NA-, so a parent can
   see what to ask the office for. Staff and students keep their own page. */

const NA = '-NA-'

function Row({ label, value }: { label: string; value?: string | null }) {
  const v = value?.trim()
  return (
    <div className="min-w-0 space-y-1 rounded-xl border p-3.5">
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className={cn('break-words text-[14px] font-semibold', !v && 'text-muted-foreground')}>{v || NA}</div>
    </div>
  )
}

export function ParentChildCard({ parentName }: { parentName?: string }) {
  const session = useSession()
  const kids = useChildren()
  const id = kids.studentId || kids.children[0]?.student_id || ''
  const { data, isLoading } = useChildProfile(id, '', !!id)
  const [viewing, setViewing] = useState(false)
  const school = kids.children.find((c) => c.student_id === id)?.institution_name ?? session.institution?.name ?? ''

  if (!id && !kids.query.isFetched) return null
  if (!id) return null

  const line = [data?.class_name, data?.section_name, data?.academic_year].filter(Boolean).join(' - ')
  return (
    <Card className="overflow-hidden">
      <div className="space-y-4 p-4 sm:p-5">
        {kids.children.length >= 2 && (
          <PickerMenu
            value={id}
            ariaLabel="Choose a child"
            align="start"
            options={kids.children.map((c) => ({ value: c.student_id, label: c.full_name }))}
            onChange={(v) => kids.setChosen(v)}
          />
        )}
        <div className="flex items-center gap-4 rounded-2xl border p-3.5 sm:p-4">
          {data?.photo_file_id ? (
            <button type="button" onClick={() => setViewing(true)} aria-label="View photo"
              className="size-[72px] flex-none overflow-hidden rounded-2xl border sm:size-[84px]">
              <img src={fileSrc(data.photo_file_id)} alt="" className="h-full w-full object-cover" />
            </button>
          ) : (
            <span aria-hidden className="grid size-[72px] flex-none place-items-center rounded-2xl bg-primary/10 text-[24px] font-extrabold text-primary sm:size-[84px]">
              {initials(data?.full_name ?? '')}
            </span>
          )}
          {viewing && data?.photo_file_id && (
            <PhotoViewer src={fileSrc(data.photo_file_id)} name={`${data.full_name}'s photo`} onClose={() => setViewing(false)} />
          )}
          <div className="min-w-0 space-y-1">
            <h2 className="break-words text-[19px] font-bold leading-tight sm:text-[21px]">{data?.full_name ?? (isLoading ? '…' : NA)}</h2>
            <p className="text-[13.5px] text-muted-foreground">{line || NA}</p>
            {school && <p className="text-[13.5px] text-muted-foreground">{school}</p>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
          <Row label="Admission no." value={data?.admission_no} />
          <Row label="APAAR ID" value={data?.apaar_id} />
          <Row label="Parent" value={parentName} />
          <Row label="Date of birth" value={data?.date_of_birth ? formatDate(data.date_of_birth) : null} />
          <Row label="Blood group" value={data?.blood_group} />
          <Row label="School transport" value={data ? (data.has_transport ? 'Yes' : 'No') : null} />
        </div>
      </div>
    </Card>
  )
}

/* A section that starts closed and opens on tap: the parent's password and
   two-factor are rarely needed, so they sit as one line each. */
export function Fold({ icon, title, hint, badge, children }: {
  icon: ReactNode; title: string; hint?: string; badge?: ReactNode; children: ReactNode
}) {
  return (
    <details className="card group overflow-hidden">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        {icon}
        <div className="min-w-0 flex-1">
          <h2 className="text-[14.5px] font-bold leading-tight">{title}</h2>
          {hint && <p className="text-[12.5px] text-muted-foreground">{hint}</p>}
        </div>
        {badge}
        <ChevronDown className="size-4 flex-none text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="border-t">{children}</div>
    </details>
  )
}
