import { useQuery } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, Badge, Select, Field,
  Loading, ErrorState, PrintButton,
} from '@/components/ui'
import { formatDate } from '@/lib/utils'
import { useChildren, childOptions } from './use-children'

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
  const { children, studentId, chosen, setChosen } = useChildren()
  const query = useQuery({
    queryKey: ['student-id-card', studentId],
    queryFn: () =>
      api.get<{ card: IDCard; pass: Pass }>(
        `/api/v1/portal/profile/student-id-card${studentId ? `?student_id=${studentId}` : ''}`,
      ),
    // The gate accepts the neighbouring windows, so refreshing a little inside
    // the window keeps the screen honest without a countdown that races it.
    refetchInterval: 60_000,
  })

  if (query.isLoading) return <Loading label="Building the card…" />
  if (query.error) return <ErrorState error={query.error} />

  const card = query.data?.card
  const pass = query.data?.pass
  if (!card || !pass) return <ErrorState error={new Error('No card returned')} />

  const klass = [card.class_name, card.section_name].filter(Boolean).join(' ')

  return (
    <>
      <PageHead
        eyebrow="Profile"
        title="Student ID card"
        description="Your child's identity card, with a code that refreshes itself."
        actions={<PrintButton label="Print card" />}
      />
      <PageBody width="form">
        {children.length > 1 && (
          <Card>
            <div className="px-5 py-4">
              <Field label="Child">
                <Select value={chosen} onChange={setChosen} options={childOptions(children)} />
              </Field>
            </div>
          </Card>
        )}

        <Card className="overflow-hidden">
          <div className="border-b bg-muted/40 px-5 py-4">
            <p className="text-[13px] text-muted-foreground">{card.school_name}</p>
            {card.campus_name && (
              <p className="text-[12px] text-muted-foreground">{card.campus_name}</p>
            )}
          </div>
          <div className="flex flex-wrap items-start gap-6 px-5 py-5">
            <div className="flex h-28 w-24 shrink-0 items-center justify-center rounded-md border bg-muted text-[12px] text-muted-foreground">
              {card.photo_file_id ? 'Photo' : 'No photo'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[20px] font-semibold tracking-[-0.01em]">{card.full_name}</p>
              <p className="text-[14px] text-muted-foreground">
                {klass || 'Not enrolled'}
                {card.roll_no != null && ` · Roll ${card.roll_no}`}
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
                <div>
                  <dt className="text-muted-foreground">Admission no.</dt>
                  <dd className="font-medium">{card.admission_no}</dd>
                </div>
                {card.date_of_birth && (
                  <div>
                    <dt className="text-muted-foreground">Date of birth</dt>
                    <dd className="font-medium">{formatDate(card.date_of_birth)}</dd>
                  </div>
                )}
                {card.blood_group && (
                  <div>
                    <dt className="text-muted-foreground">Blood group</dt>
                    <dd className="font-medium">{card.blood_group}</dd>
                  </div>
                )}
                {card.house && (
                  <div>
                    <dt className="text-muted-foreground">House</dt>
                    <dd className="font-medium">{card.house}</dd>
                  </div>
                )}
                {card.guardian_name && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">In an emergency</dt>
                    <dd className="font-medium">
                      {card.guardian_name}
                      {card.guardian_phone && ` · ${card.guardian_phone}`}
                    </dd>
                  </div>
                )}
                {card.allergies && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Allergies</dt>
                    <dd className="font-medium text-destructive">{card.allergies}</dd>
                  </div>
                )}
              </dl>
            </div>
            <Badge tone={card.status === 'active' ? 'success' : 'neutral'}>{card.status}</Badge>
          </div>
          <div className="border-t px-5 py-4">
            <p className="text-[13px] text-muted-foreground">Card number {pass.serial}</p>
            <p className="mt-1 font-mono text-[28px] tracking-[0.2em]">{pass.code}</p>
            <p className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Refreshes about every two minutes. Show this screen, not a photograph of it.
            </p>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
