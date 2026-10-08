import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { PageHead, PageBody, Card, CardHeader, Input, Button, Checkbox, Field, FormGrid, Loading, ErrorState, FormNotice, Badge } from '@/components/ui'

/* THE THINGS THE SCHOOL DECIDES ONCE.

   The pieces have been in the product for a while, each on its own screen:
   the fee reminder schedule under Unpaid fees, the digest under Scheduled
   digests, quiet hours under Message Channels. A principal setting a school
   up wants them on one page as sentences with a switch: "Remind families
   five days before a fee is due", "Send the office the day's figures at
   6 pm". This screen is that page; each rule still saves through its own
   endpoint. */

interface Reminder { days_before: number; channels: string[]; active: boolean; repeat_days: number; max_attempts: number }
interface Digest { config: Record<string, { enabled: boolean; channels: string[] }>; daily_enabled: boolean; weekly_enabled: boolean; reports: { key: string; label: string }[]; recipient_count: number }
interface Messaging { settings: { digest_time?: string; quiet_from?: string | null; quiet_to?: string | null; daily_cap?: number | null } }

export default function Rules() {
  const qc = useQueryClient()
  const reminder = useQuery({ queryKey: ['rules', 'reminder'], queryFn: () => api.get<Reminder>('/api/v1/fees/reminders/schedule') })
  const digest = useQuery({ queryKey: ['rules', 'digest'], queryFn: () => api.get<Digest>('/api/v1/reports/digest/settings') })
  const messaging = useQuery({ queryKey: ['rules', 'messaging'], queryFn: () => api.get<Messaging>('/api/v1/admin/messaging/delivery-rules') })

  const [rem, setRem] = useState<Reminder | null>(null)
  const [dig, setDig] = useState<{ daily: boolean; weekly: boolean } | null>(null)
  const [msg, setMsg] = useState<{ quiet_from: string; quiet_to: string; daily_cap: string } | null>(null)
  const r = rem ?? reminder.data ?? null
  const dg = dig ?? (digest.data ? { daily: digest.data.daily_enabled, weekly: digest.data.weekly_enabled } : null)
  const ms = msg ?? (messaging.data ? { quiet_from: messaging.data.settings.quiet_from ?? '', quiet_to: messaging.data.settings.quiet_to ?? '', daily_cap: messaging.data.settings.daily_cap == null ? '' : String(messaging.data.settings.daily_cap) } : null)

  const saveReminder = useMutation({ mutationFn: (v: Reminder) => api.put('/api/v1/fees/reminders/schedule', v), onSuccess: () => { setRem(null); qc.invalidateQueries({ queryKey: ['rules', 'reminder'] }) } })
  const saveDigest = useMutation({
    mutationFn: (v: { daily: boolean; weekly: boolean }) => api.put('/api/v1/reports/digest/settings', { config: digest.data?.config ?? {}, daily_enabled: v.daily, weekly_enabled: v.weekly }),
    onSuccess: () => { setDig(null); qc.invalidateQueries({ queryKey: ['rules', 'digest'] }) },
  })
  const saveMessaging = useMutation({
    mutationFn: (v: { quiet_from: string; quiet_to: string; daily_cap: string }) => api.put('/api/v1/admin/messaging/delivery-rules', { settings: { quiet_from: v.quiet_from || null, quiet_to: v.quiet_to || null, daily_cap: v.daily_cap === '' ? null : Number(v.daily_cap) } }),
    onSuccess: () => { setMsg(null); qc.invalidateQueries({ queryKey: ['rules', 'messaging'] }) },
  })

  const loading = reminder.isLoading || digest.isLoading || messaging.isLoading
  return (
    <>
      <PageHead eyebrow="Getting started" title="Rules" />
      <PageBody>
        {loading ? <Loading /> : (
          <div className="space-y-4">
            <Card>
              <CardHeader title="Remind families before a fee is due" action={r ? <Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'On' : 'Off'}</Badge> : undefined} />
              {reminder.error ? <div className="px-5 pb-5"><ErrorState error={reminder.error} /></div> : r && (
                <div className="space-y-3 px-5 pb-5">
                  <Checkbox checked={r.active} onChange={(v) => setRem({ ...r, active: v })} label="Send a reminder on its own, without anyone pressing Send" />
                  <FormGrid>
                    <Field label="Days before the due date"><Input type="number" value={String(r.days_before)} onChange={(v) => setRem({ ...r, days_before: Number(v || 0) })} /></Field>
                    <Field label="Repeat every (days)" hint="0 means once."><Input type="number" value={String(r.repeat_days)} onChange={(v) => setRem({ ...r, repeat_days: Number(v || 0) })} /></Field>
                    <Field label="At most (times)"><Input type="number" value={String(r.max_attempts)} onChange={(v) => setRem({ ...r, max_attempts: Number(v || 0) })} /></Field>
                  </FormGrid>
                  <div className="flex flex-wrap gap-4">
                    {['sms', 'whatsapp', 'email'].map((ch) => (
                      <Checkbox key={ch} checked={r.channels.includes(ch)} onChange={(v) => setRem({ ...r, channels: v ? [...r.channels, ch] : r.channels.filter((x) => x !== ch) })} label={ch === 'sms' ? 'SMS' : ch === 'whatsapp' ? 'WhatsApp' : 'Email'} />
                    ))}
                  </div>
                  <p className="text-[12.5px] text-muted-foreground">The app alert always goes. These cost money per message.</p>
                  <FormNotice error={saveReminder.error} />
                  <Button disabled={!rem || saveReminder.isPending} onClick={() => saveReminder.mutate(r)}>Save</Button>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader title="Send the office the day's figures" description={digest.data ? `${digest.data.recipient_count} ${digest.data.recipient_count === 1 ? 'person receives' : 'people receive'} it: the principal, the board and whoever holds the reports right.` : undefined}
                action={dg ? <Badge tone={dg.daily || dg.weekly ? 'success' : 'neutral'}>{dg.daily || dg.weekly ? 'On' : 'Off'}</Badge> : undefined} />
              {digest.error ? <div className="px-5 pb-5"><ErrorState error={digest.error} /></div> : dg && (
                <div className="space-y-3 px-5 pb-5">
                  <Checkbox checked={dg.daily} onChange={(v) => setDig({ ...dg, daily: v })} label="Every evening: attendance, fees collected and dues, admissions, staff attendance and leave" />
                  <Checkbox checked={dg.weekly} onChange={(v) => setDig({ ...dg, weekly: v })} label="Every week: the same, for the week" />
                  <p className="text-[12.5px] text-muted-foreground">Which reports and on which channels is chosen under Reports, Scheduled digests.</p>
                  <FormNotice error={saveDigest.error} />
                  <Button disabled={!dig || saveDigest.isPending} onClick={() => saveDigest.mutate(dg)}>Save</Button>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader title="Do not message families at night" action={ms ? <Badge tone={ms.quiet_from && ms.quiet_to ? 'success' : 'neutral'}>{ms.quiet_from && ms.quiet_to ? 'On' : 'Off'}</Badge> : undefined} />
              {messaging.error ? <div className="px-5 pb-5"><ErrorState error={messaging.error} /></div> : ms && (
                <div className="space-y-3 px-5 pb-5">
                  <FormGrid>
                    <Field label="Quiet from" hint="Blank on both means no quiet hours."><Input type="time" value={ms.quiet_from} onChange={(v) => setMsg({ ...ms, quiet_from: v })} /></Field>
                    <Field label="Quiet to"><Input type="time" value={ms.quiet_to} onChange={(v) => setMsg({ ...ms, quiet_to: v })} /></Field>
                    <Field label="At most, per family, per day" hint="Messages beyond this wait for the digest."><Input type="number" value={ms.daily_cap} onChange={(v) => setMsg({ ...ms, daily_cap: v })} placeholder="No cap" /></Field>
                  </FormGrid>
                  <p className="text-[12.5px] text-muted-foreground">An urgent message, a bus alert or an absence, goes through quiet hours anyway.</p>
                  <FormNotice error={saveMessaging.error} />
                  <Button disabled={!msg || saveMessaging.isPending} onClick={() => saveMessaging.mutate(ms)}>Save</Button>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader title="Always on, nothing to set" />
              <ul className="space-y-2 px-5 pb-5 text-[13.5px] text-muted-foreground">
                <li>A parent is told the same morning when their child is marked absent.</li>
                <li>A receipt reaches the family the moment a fee is taken.</li>
                <li>The class teacher sees a child's leave in the register the day it is approved.</li>
                <li>Staff documents and vehicle papers that are about to lapse show on the HR and transport homes.</li>
              </ul>
            </Card>
          </div>
        )}
      </PageBody>
    </>
  )
}
