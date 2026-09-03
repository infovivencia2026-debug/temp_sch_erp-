import { Card, CardHeader, Button, FormNotice, Badge, SkeletonForm } from '@/components/ui'
import {
  useRouting, useSetRoute, useCredits,
} from '@/features/super_admin/messaging-lib'
import { ChannelMeter } from './MessageCredits'

/* WHOSE ACCOUNT THIS CHANNEL LEAVES BY, AND WHAT THAT COSTS.

   The same control on all three channels, because it is the same decision and
   a school should not have to learn it three times. Email is here too: a school
   may well want its circulars and receipts leaving from its own mail server —
   its own domain, its own reputation — while letting SMS go through us.

   THE CREDITS LIVE HERE RATHER THAN ON A TAB OF THEIR OWN. A balance is not a
   thing in its own right; it is what one route costs. On a tab by itself it
   asked somebody to hold two screens in their head to answer one question, and
   it showed a meter for channels that were not on our account at all. Under the
   toggle that put them on our account, it is the next sentence of the same
   thought.

   Nothing is shown for a channel routed to its own vendor: there is no meter
   unless somebody sets a ceiling, and an empty credits panel beside a working
   channel reads as something broken.

   Email never shows one at all. An SMTP send is a connection, not a billed
   unit, and a school unable to send a fee receipt for want of a credit would be
   absurd. */
export default function ChannelRoute({
  channel,
  name,
  children,
}: {
  channel: string
  name: string
  /* The panel that configures the school's OWN account, rendered only when
     that is the route in force.
     
     Left out entirely on our route rather than disabled, because those panels
     describe a different arrangement and say so at length. On the EDU CLOUD
     route the SMS panel was still reporting "the paired phone has never
     reported in" — the archived handset gateway's reason, about a device this
     school does not use, under a heading saying messages go through us. A
     form nobody should fill in is worse than absent: it is read as the thing
     that is broken. */
  children?: React.ReactNode
}) {
  const routing = useRouting()
  const credits = useCredits()
  const setRoute = useSetRoute(channel)

  if (routing.isLoading) return <SkeletonForm fields={2} label="Reading how this is sent…" />

  const route = routing.data?.items.find((r) => r.channel === channel)
  const onOwn = route?.route === 'own'
  const mayChoose = route?.may_choose ?? false
  const credit = credits.data?.items.find((c) => c.channel === channel)

  return (
    <>
      <Card>
        <CardHeader
          title={`How ${name} is sent`}
          action={<Badge tone={onOwn ? 'info' : 'neutral'}>{onOwn ? 'Own account' : 'EDU CLOUD'}</Badge>}
        />
        <div className="px-5 pb-5">
          {mayChoose ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant={!onOwn ? 'primary' : 'secondary'}
                size="sm"
                disabled={setRoute.isPending}
                onClick={() => setRoute.mutate({ route: 'edu_cloud' })}
              >
                Send through EDU CLOUD
              </Button>
              <Button
                variant={onOwn ? 'primary' : 'secondary'}
                size="sm"
                disabled={setRoute.isPending}
                onClick={() => setRoute.mutate({ route: 'own' })}
              >
                Use our own account
              </Button>
            </div>
          ) : null}

          <p className={mayChoose ? 'mt-3 text-[13px] text-muted-foreground' : 'text-[13px] text-muted-foreground'}>
            {onOwn ? (
              <>
                Sending on this school&rsquo;s own account. It holds the credentials
                {channel === 'sms' ? ' and the DLT registration' : ''} and pays that provider
                directly.
              </>
            ) : channel === 'email' ? (
              <>
                Sending through EDU CLOUD&rsquo;s mail server. There is nothing to configure
                below, and email costs nothing per message.
              </>
            ) : (
              <>
                Sending through EDU CLOUD. We hold the vendor account
                {channel === 'sms' ? ' and the DLT registration' : ''}, there is nothing to
                configure below, and each message comes out of the credits underneath.
              </>
            )}
          </p>

          {!mayChoose && (
            <p className="mt-2 text-[13px] text-muted-foreground">
              The Complete pack lets a school use its <strong>own</strong> account for this
              instead.
            </p>
          )}

          <FormNotice error={setRoute.error} />
        </div>
      </Card>

      {/* The cost of the route that has one, immediately under the choice that
          selected it. */}
      {!onOwn && credit && channel !== 'email' && <ChannelMeter credit={credit} />}

      {onOwn && children}
    </>
  )
}
