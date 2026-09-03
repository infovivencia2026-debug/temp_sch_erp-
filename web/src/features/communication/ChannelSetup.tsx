import { lazy, Suspense, useState } from 'react'
import { useParams } from 'react-router-dom'
import { FileText, Gauge, Mail, MessageSquare, Phone } from 'lucide-react'
import { PageHead, PageBody, Card, Loading } from '@/components/ui'
import { cn } from '@/lib/utils'

/* The school's own senders, on the school's own screen.

   Email, SMS and WhatsApp were configurable and only from the platform
   workspace — every one of the four integration features in the catalogue was
   keyed super_admin.*. A principal holding institution.integrations.write, the
   permission that the save endpoint actually checks, had the right to
   configure their school's mail server and nowhere to do it. The answer to
   "where do I set this up" was a screen they could not reach, which is a worse
   answer than "nowhere".

   Nothing new is built here. The three panels are the same components the
   platform workspace uses, and the endpoints behind them were always
   tenant-scoped: a principal saving an SMTP host was always going to save
   their own school's. What was missing was a door.

   Three tabs rather than three screens, because they are one decision. A
   school choosing how to reach a family weighs cost against reach against
   whether the parent will actually read it, and that comparison is impossible
   across three menu entries. */

const EmailServer = lazy(() => import('../super_admin/EmailServer'))
const WhatsAppApi = lazy(() => import('../super_admin/WhatsAppApi'))
const MessageTemplates = lazy(() => import('./MessageTemplates'))
const SmsVendor = lazy(() => import('./SmsVendor'))
const MessageCredits = lazy(() => import('./MessageCredits'))

/* THE OFFICE HANDSET, ARCHIVED RATHER THAN DELETED.
 *
 * SmsGateway.tsx sends the school's SMS through an Android phone in a drawer.
 * It works, it is paired to a real device, and it is not what this product
 * offers a school any more: sending now goes through the school's own vendor
 * account, which does not depend on a handset staying charged, in signal and
 * in the building.
 *
 * Nothing is removed. The screen, its hooks, its keys and the Android app all
 * remain in the tree and on the server, so a school already paired keeps
 * sending and switching the tab back on is this one constant. It is off
 * because offering two ways to send SMS means every support conversation
 * starts by working out which one a school is using.
 *
 * If this is still false a year from now, that is the moment to decide whether
 * to delete it — not before. */
const HANDSET_GATEWAY_OFFERED = false
const SmsGateway = lazy(() => import('./SmsGateway'))

const TABS = [
  {
    id: 'email',
    label: 'Email',
    icon: Mail,
    blurb: 'The mail server a circular, a receipt and an admission decision leave through.',
  },
  {
    id: 'sms',
    label: 'SMS',
    icon: MessageSquare,
    blurb: 'The vendor account a fee reminder and an absence alert go out on. The school pays the vendor directly.',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: Phone,
    blurb: 'Read more than either, and the strictest: outside a 24-hour window only approved templates send.',
  },
  {
    id: 'credits',
    label: 'Credits',
    icon: Gauge,
    blurb: 'How many messages this school may still send on the paid channels, and where the rest went.',
  },
  {
    id: 'templates',
    label: 'Wording',
    icon: FileText,
    blurb: 'What every message actually says. The product ships defaults; editing one makes it this school\u2019s own, on that channel only.',
  },
] as const

// Which tab a catalogue key lands on, so a menu entry named for one channel
// does not open on another.
const TAB_FOR: Record<string, string> = {
  message_channels: 'email',
  sender_identity: 'email',
}

export default function ChannelSetup() {
  const { featureSlug } = useParams()
  const [tab, setTab] = useState<string | null>(null)
  const active = tab ?? TAB_FOR[featureSlug ?? ''] ?? 'email'
  const current = TABS.find((t) => t.id === active) ?? TABS[0]

  return (
    <>
      <PageHead
        eyebrow="Communication"
        title="Message channels"
        description="How this school reaches families. Set a channel up here and every circular, reminder and receipt uses it — there is no second place these are configured."
      />
      <PageBody>
        <Card>
          <div className="flex flex-wrap gap-1 border-b px-3 pt-3">
            {TABS.map((t) => {
              const Icon = t.icon
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-t-md px-4 py-2 text-[14px] transition-colors',
                    t.id === active
                      ? 'border-b-2 border-primary font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {t.label}
                </button>
              )
            })}
          </div>
          <p className="px-5 py-3 text-[13px] text-muted-foreground">{current.blurb}</p>
        </Card>

        {/* Each panel is the platform workspace's own, unchanged. The save it
            calls was always scoped to the caller's institution, so a principal
            here configures their school and nobody else's. */}
        <Suspense fallback={<Loading label="Opening…" />}>
          {active === 'email' && <EmailServer />}
          {active === 'sms' && (HANDSET_GATEWAY_OFFERED ? <SmsGateway /> : <SmsVendor />)}
          {active === 'credits' && <MessageCredits />}
          {active === 'whatsapp' && <WhatsAppApi />}
          {active === 'templates' && <MessageTemplates />}
        </Suspense>
      </PageBody>
    </>
  )
}
