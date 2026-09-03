import { lazy, Suspense, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Mail, MessageSquare, Phone } from 'lucide-react'
import { PageHead, PageBody, Card, Loading } from '@/components/ui'
import { cn } from '@/lib/utils'

const EmailServer = lazy(() => import('../super_admin/EmailServer'))
const SmsVendor = lazy(() => import('../communication/SmsVendor'))
const WhatsAppApi = lazy(() => import('../super_admin/WhatsAppApi'))

/* EDUCLOUD'S OWN CHANNELS.

   A school on the lower packs, or one that chose "send through EduCloud" on a
   higher one, sends every SMS and WhatsApp message through the seller's
   account and pays with credits. The dispatcher already swaps in the
   platform's provider set for that route (messaging.go, RouteEduCloud) -- but
   the seller had exactly one screen, the password-reset mail server, so the
   SMS and WhatsApp rows it swaps to never existed and every such message
   failed with "platform channel not set up yet".

   Same three panels the school sees, same handlers: a platform account's
   institution is NULL and /admin/messaging/providers reads and writes the
   platform's rows for it. Nothing new on the server; what was missing was a
   door. */

const TABS = [
  {
    id: 'email',
    label: 'Email',
    icon: Mail,
    blurb: 'The mail server every school’s password-reset links leave through, and email for schools that send through EduCloud.',
  },
  {
    id: 'sms',
    label: 'SMS',
    icon: MessageSquare,
    blurb: 'The vendor account behind every SMS a school sends on credits. The DLT header and templates are EduCloud’s, not the school’s.',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: Phone,
    blurb: 'The WhatsApp Business Cloud account behind credit-metered WhatsApp. Templates a school maps must be approved under this account.',
  },
] as const

const TAB_FOR: Record<string, string> = {
  password_reset_delivery: 'email',
  educloud_channels: 'sms',
}

export default function EduCloudChannels() {
  const { featureSlug } = useParams()
  const [tab, setTab] = useState<string | null>(null)
  const active = tab ?? TAB_FOR[featureSlug ?? ''] ?? 'email'
  const current = TABS.find((t) => t.id === active) ?? TABS[0]

  return (
    <>
      <PageHead
        eyebrow="Delivery"
        title="EduCloud channels"
        description="The seller’s own email, SMS and WhatsApp accounts. Every school that sends through EduCloud, and every password reset, leaves by these. A channel not set up here is a channel those schools cannot send on."
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
          <p className="px-4 py-3 text-[13.5px] text-muted-foreground">{current.blurb}</p>
        </Card>

        <Suspense fallback={<Loading label="Opening the channel…" />}>
          {active === 'email' && <EmailServer platform />}
          {active === 'sms' && <SmsVendor />}
          {active === 'whatsapp' && <WhatsAppApi />}
        </Suspense>
      </PageBody>
    </>
  )
}
