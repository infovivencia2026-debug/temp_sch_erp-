import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api } from '@/lib/api'
import type { ConnectBroadcastBody, ConnectCampaign, ConnectSendTemplate } from '@shared/api/feature_yajur_connect'
import { Badge, Button, Card, EmptyState, ErrorState, Field, FormNotice, Input, Loading } from '@/components/ui'
import FilePicker from '@/components/FilePicker'
import { CheckBeforeSending, MERGE_FIELDS, SchoolName, TEST_WHO, fieldLabel, fill, missing } from './YajurConnectSend'

/* DAILY WORKBOOKS (owner-approved design, "Connect in our ERP - preview.html" #wb):
   one card per class section. The teacher adds today's workbook photos to the
   section's card and presses Review & Send there; the same Check before
   sending dialog as every other send opens, and only "Send now" queues a
   campaign. WhatsApp takes one header picture per message, so n photos are
   n campaigns to that section's parents, and the dialog says so.
   Photos live in this component's state only; nothing is stored until sent. */

const WORKBOOK = /workbook|homework|diary/i
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const dayLabel = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })

type Photo = { url: string; name: string }
type Section = { id: string; label: string }

/** The template's non-merge fields, filled from what this screen knows: the day and the section. Anything else stays empty and blocks sending. */
function workbookValues(t: ConnectSendTemplate, date: string, section: string): Record<string, string> {
  const v: Record<string, string> = {}
  for (const f of t.fields) {
    if (MERGE_FIELDS.includes(f)) continue
    if (/date|day/i.test(f)) v[f] = dayLabel(date)
    else if (/class|section|grade/i.test(f)) v[f] = section
  }
  return v
}

export default function ConnectWorkbooks() {
  const [date, setDate] = useState(today)
  const templates = useQuery({ queryKey: ['connect', 'send-templates'], queryFn: () => api.call('GET /comms/yajur-connect/send/templates'), staleTime: 60_000 })
  const audiences = useQuery({ queryKey: ['connect', 'audiences'], queryFn: () => api.call('GET /comms/yajur-connect/send/audiences'), staleTime: 300_000 })
  const campaigns = useQuery({ queryKey: ['connect', 'campaigns'], queryFn: () => api.call('GET /comms/yajur-connect/campaigns'), refetchInterval: 30_000 })
  const list = templates.data?.items ?? []
  // The school's workbook template: named for it, with a picture header first.
  const t = useMemo(() => {
    const hits = list.filter((x) => WORKBOOK.test(x.code) || WORKBOOK.test(x.name))
    return hits.find((x) => x.has_image_header) ?? hits[0]
  }, [list])
  const sections = useMemo<Section[]>(() => (audiences.data?.classes ?? []).flatMap((c) => c.sections.map((s) => ({ id: s.id, label: `${c.name} ${s.name}` }))), [audiences.data])
  const todayYmd = today()
  const sentToday = useMemo(() => {
    const out: Record<string, ConnectCampaign[]> = {}
    for (const c of campaigns.data?.items ?? []) {
      if (!c.name.startsWith('Workbook ') || c.audience.scope !== 'sections') continue
      const d = new Date(c.created_at)
      if (`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` !== todayYmd) continue
      for (const id of c.audience.ids) (out[id] ??= []).push(c)
    }
    return out
  }, [campaigns.data, todayYmd])

  if (templates.isLoading || audiences.isLoading) return <Loading />
  if (templates.error) return <ErrorState error={templates.error} />
  if (audiences.error) return <ErrorState error={audiences.error} />

  return (
    <SchoolName.Provider value={templates.data?.school_name ?? ''}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[22px] font-bold leading-tight">Send class workbooks</h2>
            <p className="text-[14px] text-muted-foreground">The right photo, the right class. Add today's workbook pages to each section; its parents get only theirs.</p>
          </div>
          <div className="w-full sm:w-56">
            <Field label="Workbook date"><Input type="date" value={date} onChange={setDate} max={todayYmd} /></Field>
          </div>
        </div>

        {!t ? (
          <p className="rounded-lg bg-warning/15 p-3 text-[14px] text-warning">No approved workbook template yet. Add one under Message templates.</p>
        ) : !t.has_image_header ? (
          <p className="rounded-lg bg-warning/15 p-3 text-[14px] text-warning">The template "{t.name}" is not approved with a picture header, so a photo cannot go with it. Add one under Message templates.</p>
        ) : (
          <p className="text-[14px] text-muted-foreground">Template: <span className="font-medium text-foreground">{t.name}</span>. Each photo goes as its own message.</p>
        )}

        {sections.length === 0 ? (
          <EmptyState title="No class sections." body="Sections come from Academics. Add them there first." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {sections.map((s) => (
              <SectionCard key={s.id} section={s} date={date} template={t && t.has_image_header ? t : undefined} sent={sentToday[s.id] ?? []} />
            ))}
          </div>
        )}
      </div>
    </SchoolName.Provider>
  )
}

function SectionCard({ section, date, template: t, sent }: { section: Section; date: string; template?: ConnectSendTemplate; sent: ConnectCampaign[] }) {
  const qc = useQueryClient()
  const [photos, setPhotos] = useState<Photo[]>([])
  const [checking, setChecking] = useState(false)
  const [done, setDone] = useState('')
  const busy = useRef(false)
  const values = t ? workbookValues(t, date, section.label) : {}
  const unfilled = t ? t.fields.filter((f) => !MERGE_FIELDS.includes(f) && !(values[f] ?? '').trim()) : []
  const body = (photo: Photo, n: number): ConnectBroadcastBody => ({
    name: `Workbook ${section.label} ${dayLabel(date)}${photos.length > 1 ? ` (${n} of ${photos.length})` : ''}`,
    template_code: t?.code ?? '',
    values,
    header_image_url: photo.url,
    audience: { scope: 'sections', ids: [section.id], relation: 'both' },
  })
  const ready = !!t && photos.length > 0 && !missing(t, values)
  const preview = useQuery({
    queryKey: ['connect', 'preview', 'workbook', section.id, date, t?.code ?? ''],
    queryFn: () => api.call('POST /comms/yajur-connect/send/preview', { body: body(photos[0], 1) }),
    enabled: ready,
  })
  const p = preview.data
  const canGo = ready && !preview.isFetching && !preview.error && !!p && p.count > 0
  const queue = useMutation({
    mutationFn: async (list: Photo[]) => {
      let total = 0
      for (let i = 0; i < list.length; i++) {
        const c = await api.call('POST /comms/yajur-connect/campaigns', { body: body(list[i], i + 1) })
        total = c.recipient_count
      }
      return { total, messages: list.length }
    },
    onSuccess: (r) => {
      setPhotos([])
      setDone(`Sending ${r.messages === 1 ? 'the workbook' : `${r.messages} photos`} to ${r.total} ${r.total === 1 ? 'parent' : 'parents'}. Follow it under Campaigns.`)
      qc.invalidateQueries({ queryKey: ['connect', 'campaigns'] })
    },
  })
  const confirm = () => {
    if (busy.current || queue.isPending || !ready || !p || p.count === 0) return
    busy.current = true
    queue.mutate(photos, { onSettled: () => { busy.current = false; setChecking(false) } })
  }
  const leftOutParts = [
    photos.length > 1 ? `${photos.length} photos = ${photos.length} messages to each parent.` : '',
    p && (p.opted_out > 0 || p.no_phone > 0) ? `Left out: ${p.opted_out} opted out, ${p.no_phone} without a readable number.` : '',
  ].filter(Boolean)

  return (
    <Card>
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 truncate text-[16px] font-semibold">{section.label}</div>
          {sent.map((c) => <Badge key={c.id} tone="success">{`Sent ${timeLabel(c.created_at)} · ${c.recipient_count}`}</Badge>)}
        </div>
        <div className="text-[14px] text-muted-foreground">
          {photos.length === 0 ? 'No photos yet' : `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}`}
          {ready && p && !preview.isFetching && !preview.error ? ` · ${p.count} ${p.count === 1 ? 'parent' : 'parents'}` : ''}
        </div>
        {photos.length > 0 && (
          <ul className="grid grid-cols-3 gap-2">
            {photos.map((ph, i) => (
              <li key={ph.url} className="relative">
                <img src={ph.url} alt={ph.name} loading="lazy" decoding="async" className="aspect-square w-full rounded-md border object-cover" />
                <button type="button" aria-label={`Remove ${ph.name}`} onClick={() => setPhotos(photos.filter((_, j) => j !== i))}
                  className="absolute right-1 top-1 grid size-8 place-items-center rounded-full bg-background/90 text-foreground shadow-sm hover:bg-background">
                  <X className="size-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {t && (
          <FilePicker value={null} onChange={(f) => { if (f) { setPhotos((old) => [...old, { url: f.url, name: f.name }]); setDone('') } }}
            endpoint="/api/v1/comms/yajur-connect/send/image" accept="image/jpeg,image/png" label={photos.length === 0 ? 'Add photos' : 'Add another'} />
        )}
        {t && unfilled.length > 0 && (
          <p className="text-[13px] text-warning">The template needs {unfilled.map(fieldLabel).join(', ')}, which this screen cannot fill. Use Send a notice for it.</p>
        )}
        {ready && preview.error && <ErrorState error={preview.error} />}
        {ready && !preview.error && !preview.isFetching && p && p.count === 0 && <p className="text-[13px] text-muted-foreground">Nobody in this section can receive it.</p>}
        <FormNotice error={queue.error} ok={done || undefined} />
        <Button className="w-full" disabled={!canGo || queue.isPending} onClick={() => { if (canGo && !busy.current) setChecking(true) }}>
          Review &amp; Send
        </Button>
      </div>
      {checking && t && p && (
        <CheckBeforeSending onClose={() => { if (!busy.current) setChecking(false) }} pending={queue.isPending}
          action={photos.length > 1 ? `Send ${photos.length} messages to ${p.count}` : `Send now to ${p.count}`}
          onSend={confirm}
          text={p.sample || fill(t, values, TEST_WHO)} sampleTo={p.sample_to || undefined} count={p.count} audience={p.audience_label}
          when="Now" template={t.name || t.code} image={photos[0]?.url}
          leftOut={leftOutParts.length > 0 ? leftOutParts.join(' ') : undefined} />
      )}
    </Card>
  )
}
