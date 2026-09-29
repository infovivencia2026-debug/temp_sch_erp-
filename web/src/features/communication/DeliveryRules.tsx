import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Badge, Button, Card, CardHeader, ErrorState, Field, FormGrid, FormNotice, Input, Loading } from '@/components/ui'
import { CHANNEL_NAMES, HealthWarnings, rupees, stateLabel, type Health } from './delivery-lib'

/* Delivery rules: which channel each kind of message tries first, what waits
   for the evening digest, quiet hours, and the per-family daily cap.

   The ladder is cheapest first. In-app + push costs nothing; WhatsApp costs
   a little; SMS costs most and is the last resort (and the only way for
   one-time codes). A rung that is not live is skipped when sending, and the
   status column says so here rather than letting a school believe it works. */

interface TypeRow {
  key: string; label: string; example: string; urgent: boolean; digestible: boolean
  default_ladder: string[]; default_mode: string; ladder: string[]; mode: 'instant' | 'digest'
}
interface Settings { digest_time: string; quiet_from: string | null; quiet_to: string | null; daily_cap: number; dedup_minutes: number }
interface Rules extends Health { settings: Settings; types: TypeRow[] }

const ALL = ['in_app', 'whatsapp', 'sms', 'email']

export default function DeliveryRules() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['delivery-rules'], queryFn: () => api.get<Rules>('/api/v1/admin/messaging/delivery-rules') })
  const [settings, setSettings] = useState<Settings | null>(null)
  const [types, setTypes] = useState<TypeRow[]>([])
  useEffect(() => { if (q.data) { setSettings(q.data.settings); setTypes(q.data.types) } }, [q.data])
  const save = useMutation({
    mutationFn: () => api.put<Rules>('/api/v1/admin/messaging/delivery-rules', {
      settings, types: types.map((t) => ({ key: t.key, ladder: t.ladder, mode: t.mode })),
    }),
    onSuccess: (d) => { qc.setQueryData(['delivery-rules'], d); qc.invalidateQueries({ queryKey: ['messaging-health'] }) },
  })

  if (q.isPending) return <Loading label="Reading delivery rules…" />
  if (q.error || !q.data || !settings) return <ErrorState error={q.error} />
  const live = Object.fromEntries(q.data.channels.map((c) => [c.channel, c]))

  const setType = (key: string, f: (t: TypeRow) => TypeRow) => setTypes((ts) => ts.map((t) => (t.key === key ? f(t) : t)))
  const move = (t: TypeRow, i: number, d: number) => {
    const l = [...t.ladder]
    const j = i + d
    if (j < 0 || j >= l.length) return
    ;[l[i], l[j]] = [l[j], l[i]]
    setType(t.key, (x) => ({ ...x, ladder: l }))
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Channel status" description="A channel is Live only when its provider is set up and, where it is paid, has credit." />
        <div className="space-y-4 p-5">
          <HealthWarnings warnings={q.data.warnings} />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {q.data.channels.map((c) => (
              <div key={c.channel} className="rounded-lg border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium">{c.label}</span>
                  <Badge tone={c.live ? 'success' : c.state === 'no_credit' ? 'danger' : 'warning'}>{stateLabel(c)}</Badge>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {c.cost_paise ? `about ${rupees(c.cost_paise)} a message` : 'free'}
                  {c.credits !== null ? ` · ${c.credits} credits` : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="No spam" description="Applies to everything that is not urgent. Absence alerts, emergencies, fees due today and the bus always go at once." />
        <div className="p-5">
          <FormGrid>
            <Field label="Daily digest at" hint="Notices, homework and marks set to 'Digest' go as one message at this time (IST).">
              <Input type="time" value={settings.digest_time} onChange={(v) => setSettings({ ...settings, digest_time: v })} />
            </Field>
            <Field label="Quiet hours from" hint="Non-urgent messages wait until quiet hours end. Leave both empty for none.">
              <Input type="time" value={settings.quiet_from ?? ''} onChange={(v) => setSettings({ ...settings, quiet_from: v || null })} />
            </Field>
            <Field label="Quiet hours until">
              <Input type="time" value={settings.quiet_to ?? ''} onChange={(v) => setSettings({ ...settings, quiet_to: v || null })} />
            </Field>
            <Field label="Most messages per family per day" hint="Anything over this waits for the next digest. 0 means no cap.">
              <Input type="number" value={String(settings.daily_cap)} onChange={(v) => setSettings({ ...settings, daily_cap: Number(v) || 0 })} />
            </Field>
            <Field label="Same alert again only after (minutes)" hint="The same message to the same person inside this window is dropped.">
              <Input type="number" value={String(settings.dedup_minutes)} onChange={(v) => setSettings({ ...settings, dedup_minutes: Number(v) || 0 })} />
            </Field>
          </FormGrid>
        </div>
      </Card>

      <Card>
        <CardHeader title="Channel ladder per message" description="Tried in order, cheapest first. The next channel is used only when the one before cannot reach the person or fails." />
        <div className="divide-y">
          {types.map((t) => (
            <div key={t.key} className="flex flex-wrap items-start gap-4 px-5 py-4">
              <div className="min-w-[200px] flex-1">
                <div className="flex items-center gap-2 text-[14px] font-medium">
                  {t.label} {t.urgent && <Badge tone="danger">Urgent</Badge>}
                </div>
                <p className="text-[12px] text-muted-foreground">For example: {t.example}</p>
              </div>
              <ol className="flex flex-wrap items-center gap-1.5">
                {t.ladder.map((ch, i) => (
                  <li key={ch} className="flex items-center gap-1 rounded-md border px-2 py-1 text-[12px]">
                    <span>{i + 1}. {CHANNEL_NAMES[ch] ?? ch}</span>
                    {ch !== 'in_app' && live[ch] && !live[ch].live && <Badge tone="warning">{stateLabel(live[ch])}</Badge>}
                    <button type="button" aria-label="Earlier" onClick={() => move(t, i, -1)} className="text-muted-foreground"><ArrowUp className="h-3 w-3" /></button>
                    <button type="button" aria-label="Later" onClick={() => move(t, i, 1)} className="text-muted-foreground"><ArrowDown className="h-3 w-3" /></button>
                    {t.ladder.length > 1 && (
                      <button type="button" aria-label="Remove" onClick={() => setType(t.key, (x) => ({ ...x, ladder: x.ladder.filter((c) => c !== ch) }))} className="text-muted-foreground"><X className="h-3 w-3" /></button>
                    )}
                  </li>
                ))}
                {ALL.filter((c) => !t.ladder.includes(c)).map((c) => (
                  <li key={c}>
                    <button type="button" className="rounded-md border border-dashed px-2 py-1 text-[12px] text-muted-foreground"
                      onClick={() => setType(t.key, (x) => ({ ...x, ladder: [...x.ladder, c] }))}>+ {CHANNEL_NAMES[c]}</button>
                  </li>
                ))}
              </ol>
              {t.digestible && (
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={t.mode === 'digest'} onChange={(e) => setType(t.key, (x) => ({ ...x, mode: e.target.checked ? 'digest' : 'instant' }))} />
                  Daily digest
                </label>
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-5 py-4">
          <FormNotice error={save.error} ok={save.isSuccess ? 'Saved.' : undefined} />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setTypes(types.map((t) => ({ ...t, ladder: t.default_ladder, mode: t.default_mode as 'instant' | 'digest' })))}>Use defaults</Button>
            <Button pending={save.isPending} onClick={() => save.mutate()}>Save rules</Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
