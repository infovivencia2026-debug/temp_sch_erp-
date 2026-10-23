import { printDocument } from '@/lib/print'
import { Barcode } from '@/lib/barcode'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Cake, Droplet, House, Phone, Printer, ShieldCheck, UserRound } from 'lucide-react'
import { api } from '@/lib/api'
import { ErrorState } from '@/components/ui'
import { useTabVisible, passRefetch } from '@/lib/visible'
import { formatDate } from '@/lib/utils'
import { Bone, HUE, PullToRefresh, StudentHeader, StudentPage } from './student-kit'

/* MY ID CARD, as a card: the school on top, my photo or initials, my name
   big, and the gate code under it with a bar that runs down to its next
   change. Everything is read live from the records (see StudentIDCard.tsx for
   why nothing here is stored as a card); the pass refetches just after the
   code it holds runs out. My details sit below, as plain rows. */

interface IDCard {
  full_name: string; admission_no: string; class_name?: string; section_name?: string; roll_no?: number
  date_of_birth?: string; blood_group?: string; allergies?: string; house?: string; photo_file_id?: string
  guardian_name?: string; guardian_phone?: string; school_name: string; campus_name?: string; status: string
}
interface Pass { serial: string; code: string; expires_in_seconds: number }

export default function StudentMyCard() {
  const qc = useQueryClient()
  const visible = useTabVisible()
  const q = useQuery({
    queryKey: ['student-id-card', ''],
    queryFn: () => api.get<{ card: IDCard; pass: Pass }>('/api/v1/portal/profile/student-id-card'),
    refetchInterval: passRefetch(visible),
  })
  const card = q.data?.card, pass = q.data?.pass
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (!pass) return
    const until = Date.now() + pass.expires_in_seconds * 1000
    setLeft(pass.expires_in_seconds)
    const t = setInterval(() => setLeft(Math.max(0, Math.round((until - Date.now()) / 1000))), 1000)
    return () => clearInterval(t)
  }, [pass])
  const initials = card?.full_name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()

  return (
    <PullToRefresh onRefresh={() => qc.invalidateQueries({ queryKey: ['student-id-card', ''] })}>
      <StudentPage>
        <StudentHeader title="My ID card" sub="Show this screen at the gate or the library"
          right={<button type="button" onClick={() => printDocument({ title: 'Student ID card' })} aria-label="Print my card" className="card stu-press inline-flex h-11 w-11 items-center justify-center"><Printer className="h-5 w-5" strokeWidth={1.75} /></button>} />

        {q.error ? <ErrorState error={q.error} /> : !card || !pass ? (
          <><Bone className="h-[360px] w-full rounded-3xl" /><Bone className="h-[220px] w-full rounded-2xl" /></>
        ) : (
          <>
            <section className="card stu-rise overflow-hidden p-0" aria-label="ID card">
              <div className="bg-[linear-gradient(135deg,hsl(var(--sys-indigo)/0.16),hsl(var(--sys-blue)/0.12))] px-5 pb-12 pt-4">
                <p className="text-[15px] font-semibold">{card.school_name}</p>
                <p className="text-[12px] text-muted-foreground">{card.campus_name ?? 'Student ID'}</p>
              </div>
              <div className="-mt-10 flex flex-col items-center px-5 pb-5 text-center">
                {card.photo_file_id
                  ? <img src={`/api/v1/files/${card.photo_file_id}`} alt="" width={88} height={88} className="h-[88px] w-[88px] rounded-full border-4 border-[var(--color-card,white)] object-cover" />
                  : <span className="flex h-[88px] w-[88px] items-center justify-center rounded-full border-4 border-[var(--color-card,white)] bg-[color-mix(in_oklab,#6366f1_18%,white)] text-[28px] font-semibold text-[#4338ca] dark:bg-[#312e81] dark:text-[#c7d2fe]">{initials}</span>}
                <p className="mt-2 text-[22px] font-semibold leading-tight">{card.full_name}</p>
                <p className="text-[14px] text-muted-foreground">{[card.class_name && `${card.class_name} ${card.section_name ?? ''}`.trim(), card.roll_no && `Roll ${card.roll_no}`].filter(Boolean).join(' · ')}</p>
                <p className="mt-1 font-mono text-[13px] tracking-wide text-muted-foreground">{card.admission_no}</p>
                <Barcode value={card.admission_no} height={22} label={false} className="mt-2 h-6 w-40 max-w-full" />
              </div>
              <div className="border-t border-dashed px-5 py-4">
                <p className="flex items-center justify-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground"><ShieldCheck className="h-4 w-4 text-success" /> Gate code</p>
                <p className="mt-1 text-center font-mono text-[30px] font-semibold tracking-[0.22em] tabular-nums" aria-live="polite">{pass.code}</p>
                <span className="mx-auto mt-2 block h-1.5 max-w-[220px] overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span className="block h-full origin-left rounded-full bg-success transition-transform duration-1000 ease-linear" style={{ transform: `scaleX(${Math.min(1, left / 150)})` }} />
                </span>
                <p className="mt-1.5 text-center text-[12px] text-muted-foreground">Changes every couple of minutes, so a photo of it will not work. Card {pass.serial}</p>
              </div>
            </section>

            <section className="card stu-rise p-0" style={{ ['--i' as string]: 1 }} aria-label="My details">
              <h2 className="px-4 pb-1 pt-3 text-[16px] font-semibold">My details</h2>
              <dl className="divide-y">
                <Detail icon={Cake} hue="rose" label="Birthday" value={card.date_of_birth ? formatDate(card.date_of_birth) : undefined} />
                <Detail icon={Droplet} hue="rose" label="Blood group" value={card.blood_group} />
                <Detail icon={House} hue="amber" label="House" value={card.house} />
                <Detail icon={UserRound} hue="indigo" label="In an emergency" value={card.guardian_name} />
                <Detail icon={Phone} hue="emerald" label="Their phone" value={card.guardian_phone && <a className="inline-flex min-h-[44px] items-center text-primary" href={`tel:${card.guardian_phone}`}>{card.guardian_phone}</a>} />
                {card.allergies && <Detail icon={ShieldCheck} hue="amber" label="Allergies" value={card.allergies} />}
              </dl>
              <p className="px-4 pb-3 pt-1 text-[12px] text-muted-foreground">Something wrong? Tell your class teacher or the school office.</p>
            </section>
          </>
        )}
      </StudentPage>
    </PullToRefresh>
  )
}

function Detail({ icon: Icon, hue, label, value }: { icon: typeof Cake; hue: keyof typeof HUE; label: string; value?: React.ReactNode }) {
  return (
    <div className="flex min-h-[56px] items-center gap-3 px-4 py-2">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${HUE[hue].bg} ${HUE[hue].fg}`}><Icon className="h-[18px] w-[18px]" strokeWidth={1.75} /></span>
      <dt className="shrink-0 whitespace-nowrap text-[14px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-right text-[15px] font-medium [overflow-wrap:anywhere]">{value || <span className="text-muted-foreground">Not recorded</span>}</dd>
    </div>
  )
}
