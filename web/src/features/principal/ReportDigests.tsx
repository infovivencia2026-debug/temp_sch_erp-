import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Panel, Checkbox, Button,
  Badge, Stat, ErrorState, Loading, EmptyState,
} from '@/components/ui'

/* A small section header. CardHeader in the design system no longer draws its
   description, and these sentences are the point — so the heading is drawn
   here where the subtitle stays visible. */
function SectionHead({ title, note }: { title: string; note: string }) {
  return (
    <div className="border-b pb-3">
      <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h3>
      <p className="mt-1 text-[13px] text-muted-foreground">{note}</p>
    </div>
  )
}

/* Scheduled report digests: the settings screen.
 *
 * Disable what is not necessary. Every report is on by default; a school turns
 * off the ones it does not want and chooses the channels for the rest. The
 * recipient list is shown, not edited here — a digest goes to whoever holds
 * board_member or institution_admin, resolved on the server every run, so this
 * screen only reports who that currently is. */

const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'in_app', label: 'In-app' },
]

type Channel = 'email' | 'sms' | 'whatsapp' | 'in_app'

interface ReportCfg {
  enabled: boolean
  channels: Channel[]
}

interface ReportMeta {
  key: string
  label: string
}

interface Recipient {
  user_id: string
  name: string
  role: string
}

interface Settings {
  config: Record<string, ReportCfg>
  daily_enabled: boolean
  weekly_enabled: boolean
  reports: ReportMeta[]
  recipients: Recipient[]
  recipient_count: number
}

export default function ReportDigests() {
  const qc = useQueryClient()
  const settings = useQuery({
    queryKey: ['report-digest-settings'],
    queryFn: () => api.get<Settings>('/api/v1/reports/digest/settings'),
  })

  const [config, setConfig] = useState<Record<string, ReportCfg>>({})
  const [daily, setDaily] = useState(true)
  const [weekly, setWeekly] = useState(true)
  const [saved, setSaved] = useState('')

  // Seed the editable draft from the server once it arrives. A report the
  // server does not mention is drawn as off with no channels.
  useEffect(() => {
    if (!settings.data) return
    const next: Record<string, ReportCfg> = {}
    for (const r of settings.data.reports) {
      const c = settings.data.config[r.key]
      next[r.key] = c
        ? { enabled: !!c.enabled, channels: (c.channels || []) as Channel[] }
        : { enabled: false, channels: [] }
    }
    setConfig(next)
    setDaily(settings.data.daily_enabled)
    setWeekly(settings.data.weekly_enabled)
  }, [settings.data])

  const save = useMutation({
    mutationFn: () =>
      api.put<Settings>('/api/v1/reports/digest/settings', {
        config,
        daily_enabled: daily,
        weekly_enabled: weekly,
      }),
    onSuccess: (data) => {
      qc.setQueryData(['report-digest-settings'], data)
      setSaved('Saved')
    },
  })

  if (settings.isLoading) return <Loading />
  if (settings.error) return <ErrorState error={settings.error} />

  const reports = settings.data?.reports ?? []
  const recipients = settings.data?.recipients ?? []

  function toggleReport(key: string, on: boolean) {
    setSaved('')
    setConfig((c) => ({ ...c, [key]: { ...c[key], enabled: on } }))
  }

  function toggleChannel(key: string, ch: Channel, on: boolean) {
    setSaved('')
    setConfig((c) => {
      const cur = c[key] || { enabled: false, channels: [] }
      const channels = on
        ? Array.from(new Set([...cur.channels, ch]))
        : cur.channels.filter((x) => x !== ch)
      return { ...c, [key]: { ...cur, channels } }
    })
  }

  // A report switched on with no channel would silently never send; the server
  // refuses it, so the screen flags it before the save is attempted.
  const invalid = reports.filter(
    (r) => config[r.key]?.enabled && (config[r.key]?.channels.length ?? 0) === 0,
  )

  return (
    <>
      <PageHead
        eyebrow="Reports"
        title="Scheduled digests"
        actions={
          <Button
            pending={save.isPending}
            disabled={invalid.length > 0}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        }
      />
      <PageBody>
        <Panel className="p-4 sm:p-5">
          <SectionHead
            title="When they go out"
            note="The daily digest is sent at 07:00; the weekly on Monday at 07:00, for the week just closed."
          />
          <div className="mt-3 space-y-2">
            <Checkbox
              checked={daily}
              onChange={(v) => {
                setSaved('')
                setDaily(v)
              }}
              label="Send the daily digest"
            />
            <Checkbox
              checked={weekly}
              onChange={(v) => {
                setSaved('')
                setWeekly(v)
              }}
              label="Send the weekly digest"
            />
          </div>
        </Panel>

        <Panel className="p-4 sm:p-5">
          <SectionHead
            title="Reports"
            note="Turn off what is not necessary, and choose the channels for the rest."
          />
          <div className="mt-3 space-y-4">
            {reports.map((r) => {
              const c = config[r.key] || { enabled: false, channels: [] }
              const noChannel = c.enabled && c.channels.length === 0
              return (
                <div
                  key={r.key}
                  className="rounded-[10px] border bg-card p-3 sm:p-4"
                >
                  <Checkbox
                    checked={c.enabled}
                    onChange={(v) => toggleReport(r.key, v)}
                    label={r.label}
                  />
                  {c.enabled && (
                    <div className="mt-3 pl-6">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        {CHANNELS.map((ch) => (
                          <Checkbox
                            key={ch.key}
                            checked={c.channels.includes(ch.key)}
                            onChange={(v) => toggleChannel(r.key, ch.key, v)}
                            label={ch.label}
                          />
                        ))}
                      </div>
                      {noChannel && (
                        <p className="mt-2 text-[12px] text-destructive">
                          Choose at least one channel, or switch this report off.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </Panel>

        <Panel className="p-4 sm:p-5">
          <SectionHead
            title="Who receives it"
            note="Board members and institution admins. This list is resolved for every run, so a new board member is added automatically."
          />
          <div className="mt-3">
            <Stat label="Recipients" value={String(settings.data?.recipient_count ?? 0)} />
          </div>
          <div className="mt-3">
            {recipients.length === 0 ? (
              <EmptyState
                title="No recipients yet"
                body="No one currently holds board member or institution admin, so a digest would reach nobody."
              />
            ) : (
              <ul className="space-y-2">
                {recipients.map((rec) => (
                  <li
                    key={rec.user_id}
                    className="flex items-center justify-between border-b pb-2 text-[13px] last:border-0"
                  >
                    <span>{rec.name}</span>
                    <Badge>
                      {rec.role === 'board_member' ? 'Board member' : 'Institution admin'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>

        {save.error && <ErrorState error={save.error} />}
        {saved && !save.isPending && (
          <p className="text-[13px] text-muted-foreground">{saved}</p>
        )}
      </PageBody>
    </>
  )
}
