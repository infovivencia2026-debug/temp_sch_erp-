import { useQuery } from '@tanstack/react-query'
import { ShieldCheck, Users } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, Loading, ErrorState, PrintButton,
} from '@/components/ui'
import { useT } from '@/lib/i18n'

/* The guardian's own card for the school gate.

   It lists the children, because that is what the guard is actually checking:
   not that this person exists, but that they have business inside. A card with
   a name and no children on it tells them nothing they can act on.

   The code is derived from a secret held against the card, not stored — so a
   leak of the table is not a set of working passes, which is precisely what a
   printed plastic card already is. It changes every couple of minutes and the
   gate accepts a window either side, because the tablet at the gate and the
   phone in the queue are never quite agreed on the time. */

interface IDCard {
  user_id: string
  full_name: string
  phone?: string
  email?: string
  relation?: string
  school_name: string
}

interface Child {
  student_id: string
  full_name: string
  class_name?: string
  section_name?: string
}

interface Pass {
  serial: string
  code: string
  scan: string
  expires_in_seconds: number
}

export default function ParentIDCard() {
  const t = useT()
  const query = useQuery({
    queryKey: ['parent-id-card'],
    queryFn: () =>
      api.get<{ card: IDCard; children: Child[]; pass: Pass }>(
        '/api/v1/portal/profile/parent-id-card',
      ),
    refetchInterval: 60_000,
  })

  if (query.isLoading) return <Loading label={t('portal.parent_id_card.loading')} />
  if (query.error) return <ErrorState error={query.error} />

  const card = query.data?.card
  const pass = query.data?.pass
  const children = query.data?.children ?? []
  if (!card || !pass) return <ErrorState error={new Error(t('portal.parent_id_card.no_card'))} />

  return (
    <>
      <PageHead
        eyebrow={t('portal.parent_id_card.eyebrow')}
        title={t('portal.parent_id_card.title')}
        description={t('portal.parent_id_card.description')}
        actions={<PrintButton label={t('portal.parent_id_card.action_print')} />}
      />
      <PageBody width="form">
        <Card className="overflow-hidden">
          <div className="border-b bg-muted/40 px-5 py-4">
            <p className="text-[13px] text-muted-foreground">{card.school_name}</p>
            <p className="text-[12px] text-muted-foreground">
              {t('portal.parent_id_card.card_kind')}
            </p>
          </div>

          <div className="px-5 py-5">
            <p className="text-[20px] font-semibold tracking-[-0.01em]">{card.full_name}</p>
            <p className="text-[14px] text-muted-foreground">
              {[card.relation, card.phone, card.email].filter(Boolean).join(' · ')}
            </p>
          </div>

          <div className="border-t px-5 py-4">
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              {children.length === 0
                ? t('portal.parent_id_card.no_children')
                : children.length === 1
                  ? t('portal.parent_id_card.guardian_of_one')
                  : t('portal.parent_id_card.guardian_of_many', { count: children.length })}
            </p>
            <ul className="mt-2 space-y-1">
              {children.map((c) => (
                <li key={c.student_id} className="text-[14px]">
                  {c.full_name}
                  {(c.class_name || c.section_name) && (
                    <span className="text-muted-foreground">
                      {' · '}
                      {[c.class_name, c.section_name].filter(Boolean).join(' ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="border-t px-5 py-5">
            <p className="text-[13px] text-muted-foreground">
              {t('portal.parent_id_card.pass_number', { serial: pass.serial })}
            </p>
            <p className="mt-1 font-mono text-[32px] tracking-[0.2em]">{pass.code}</p>
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('portal.parent_id_card.gate_note')}
            </p>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
