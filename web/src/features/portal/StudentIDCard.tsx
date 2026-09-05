import { useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, Badge, Select, Field, EmptyState, PrintButton } from '@/components/ui'
import { ScreenError } from './screen-error'
import { Freshness, ScreenSkeleton } from './screen-state'
import { formatDate } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useChildren, childOptions, readyFor } from './use-children'

/* The child's identity card, rendered live.

   Nothing on this card is stored as a card. The name, the class, the blood
   group and the emergency number are read from the records the school already
   keeps, so a child who moves section in July does not carry a card that
   contradicts the register until somebody reissues it.

   The code beneath it changes every couple of minutes. That is the point: a
   screenshot forwarded to somebody else stops working before they reach the
   gate, which a printed card can never do. The screen refetches on its own so
   the number on the phone is the number the gate expects. */

interface IDCard {
  student_id: string
  full_name: string
  admission_no: string
  class_name?: string
  section_name?: string
  roll_no?: number
  date_of_birth?: string
  blood_group?: string
  allergies?: string
  house?: string
  photo_file_id?: string
  guardian_name?: string
  guardian_phone?: string
  school_name: string
  campus_name?: string
  status: string
}

interface Pass {
  serial: string
  code: string
  scan: string
  expires_in_seconds: number
}

export default function StudentIDCard() {
  const t = useT()
  const { children, studentId, chosen, setChosen } = useChildren()
  /* One card, one child. The endpoint resolves it with whichChild
     (portal_school_life.go:1424), which answers for the eldest when no
     student_id is sent — so a guardian of three was shown one child's card,
     and one child's live gate code, with the picker still on "Choose a
     child…". The code on this screen is the one the gate reads; the wrong one
     is worse than none. */
  const ready = readyFor(children, studentId)
  const query = useQuery({
    queryKey: ['student-id-card', studentId],
    queryFn: () =>
      api.get<{ card: IDCard; pass: Pass }>(
        `/api/v1/portal/profile/student-id-card${studentId ? `?student_id=${studentId}` : ''}`,
      ),
    // The gate accepts the neighbouring windows, so refreshing a little inside
    // the window keeps the screen honest without a countdown that races it.
    refetchInterval: 60_000,
    enabled: ready,
  })

  // Drawn from one place: it is the only thing on the screen before the
  // question of whose card this is has been answered.
  const picker = children.length > 1 && (
    <Card>
      <div className="px-5 py-4">
        <Field label={t('portal.student_id_card.field_child')}>
          <Select value={chosen} onChange={setChosen} options={childOptions(children)} />
        </Field>
      </div>
    </Card>
  )

  if (query.isLoading) return <ScreenSkeleton label={t('portal.student_id_card.loading')} />
  if (query.error && !query.data) return <ScreenError error={query.error} />
  if (!ready)
    return (
      <>
        <PageHead
          eyebrow={t('portal.student_id_card.eyebrow')}
          title={t('portal.student_id_card.title')}
          description={t('portal.student_id_card.description')}
        />
        <PageBody width="form">
          {picker}
          <EmptyState
            title={t('portal.student_id_card.choose_title')}
            body={t('portal.student_id_card.choose_body')}
          />
        </PageBody>
      </>
    )

  const card = query.data?.card
  const pass = query.data?.pass
  if (!card || !pass) return <ScreenError error={new Error(t('portal.student_id_card.no_card'))} />

  const klass = [card.class_name, card.section_name].filter(Boolean).join(' ')

  return (
    <>
      <PageHead
        eyebrow={t('portal.student_id_card.eyebrow')}
        title={t('portal.student_id_card.title')}
        description={t('portal.student_id_card.description')}
        actions={<PrintButton label={t('portal.student_id_card.action_print')} />}
      />
      <Freshness query={query} />
      <PageBody width="form">
        {picker}

        <Card className="overflow-hidden">
          <div className="border-b bg-muted/40 px-5 py-4">
            <p className="text-[13px] text-muted-foreground">{card.school_name}</p>
            {card.campus_name && (
              <p className="text-[12px] text-muted-foreground">{card.campus_name}</p>
            )}
          </div>
          <div className="flex flex-wrap items-start gap-6 px-5 py-5">
            <div className="flex h-28 w-24 shrink-0 items-center justify-center rounded-md border bg-muted text-[12px] text-muted-foreground">
              {card.photo_file_id
                ? t('portal.student_id_card.photo')
                : t('portal.student_id_card.no_photo')}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[20px] font-semibold tracking-[-0.01em]">{card.full_name}</p>
              <p className="text-[14px] text-muted-foreground">
                {klass || t('portal.student_id_card.not_enrolled')}
                {card.roll_no != null && t('portal.student_id_card.roll', { roll: card.roll_no })}
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
                <div>
                  <dt className="text-muted-foreground">{t('portal.student_id_card.admission_no')}</dt>
                  <dd className="font-medium">{card.admission_no}</dd>
                </div>
                {card.date_of_birth && (
                  <div>
                    <dt className="text-muted-foreground">{t('portal.student_id_card.date_of_birth')}</dt>
                    <dd className="font-medium">{formatDate(card.date_of_birth)}</dd>
                  </div>
                )}
                {card.blood_group && (
                  <div>
                    <dt className="text-muted-foreground">{t('portal.student_id_card.blood_group')}</dt>
                    <dd className="font-medium">{card.blood_group}</dd>
                  </div>
                )}
                {card.house && (
                  <div>
                    <dt className="text-muted-foreground">{t('portal.student_id_card.house')}</dt>
                    <dd className="font-medium">{card.house}</dd>
                  </div>
                )}
                {card.guardian_name && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">{t('portal.student_id_card.emergency')}</dt>
                    <dd className="font-medium">
                      {card.guardian_name}
                      {card.guardian_phone && ` · ${card.guardian_phone}`}
                    </dd>
                  </div>
                )}
                {card.allergies && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">{t('portal.student_id_card.allergies')}</dt>
                    <dd className="font-medium text-destructive">{card.allergies}</dd>
                  </div>
                )}
              </dl>
            </div>
            <Badge tone={card.status === 'active' ? 'success' : 'neutral'}>{card.status}</Badge>
          </div>
          <div className="border-t px-5 py-4">
            <p className="text-[13px] text-muted-foreground">
              {t('portal.student_id_card.pass_number', { serial: pass.serial })}
            </p>
            <p className="mt-1 font-mono text-[28px] tracking-[0.2em]">{pass.code}</p>
            <p className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              {t('portal.student_id_card.gate_note')}
            </p>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
