import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Card, CardHeader, EmbeddedPage, FormNotice, Select } from '@/components/ui'
import FilePicker, { type UploadedFile } from '@/components/FilePicker'
import CertificateTemplates from '@/features/students/CertificateTemplates'

/* CERTIFICATE DESIGNS (owner, 2026-10-07: "let them add the design of the
   certificate"). Per student certificate: the look (classic border, plain
   letterhead, or the school's own printed stationery as the background) and a
   signature image. The wording and signatory are below, in the template editor
   that was already written but on no menu. */

interface Design { style?: string; background_file_id?: string | null; signature_file_id?: string | null }
interface Tmpl { id: string; code: string; name: string; subject_kind: string; is_active: boolean }

const STYLES = [
  { value: 'classic', label: 'Classic border, school name centred' },
  { value: 'letterhead', label: 'Plain letterhead' },
  { value: 'background', label: 'Our own printed design (upload)' },
]

export default function CertificateDesigns() {
  const types = useQuery({
    queryKey: ['certificate-templates'],
    queryFn: () => api.get<{ items: Tmpl[] }>('/api/v1/academics/admin/certificate-templates'),
  })
  const designs = useQuery({
    queryKey: ['certificate-designs'],
    queryFn: () => api.get<{ designs: Record<string, Design> }>('/api/v1/lifecycle/certificate-designs'),
  })
  const list = (types.data?.items ?? []).filter((t) => t.subject_kind !== 'staff' && t.is_active)
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        {list.map((t) => <DesignCard key={t.code} t={t} saved={designs.data?.designs?.[t.code] ?? {}} />)}
      </div>
      <EmbeddedPage.Provider value>
        <CertificateTemplates />
      </EmbeddedPage.Provider>
    </>
  )
}

function DesignCard({ t, saved }: { t: Tmpl; saved: Design }) {
  const qc = useQueryClient()
  const [style, setStyle] = useState(saved.style ?? 'classic')
  const [bg, setBg] = useState<UploadedFile | null>(null)
  const [sig, setSig] = useState<UploadedFile | null>(null)
  const [done, setDone] = useState('')
  const save = useMutation({
    mutationFn: () => api.put('/api/v1/lifecycle/certificate-designs', {
      code: t.code, style,
      background_file_id: bg?.file_id ?? saved.background_file_id ?? null,
      signature_file_id: sig?.file_id ?? saved.signature_file_id ?? null,
    }),
    onSuccess: () => { setDone('Saved. The next print uses it.'); qc.invalidateQueries({ queryKey: ['certificate-designs'] }) },
  })
  const thumb = (id?: string | null) => (id ? `/api/v1/files/${id}?inline=1` : '')
  return (
    <Card>
      <CardHeader title={t.name} description={`Code ${t.code}`}
        action={<Button onClick={() => save.mutate()} disabled={save.isPending || (style === 'background' && !bg && !saved.background_file_id)}>{save.isPending ? 'Saving…' : 'Save design'}</Button>} />
      <div className="space-y-4 p-5">
        {done && <FormNotice ok={done} />}
        {save.error && <FormNotice error={save.error} />}
        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-muted-foreground">Look</span>
          <Select value={style} onChange={(v) => { setStyle(v); setDone('') }} options={STYLES} />
        </div>
        {style === 'background' && (
          <div className="rounded-xl border bg-muted/20 p-4">
            <FilePicker value={bg} onChange={setBg} purpose="certificate_background" label="Upload the certificate background"
              hint="A4 portrait scan or PDF-exported image of your printed certificate (PNG or JPG). The words print on top." />
            {!bg && saved.background_file_id && <img src={thumb(saved.background_file_id)} alt="Current background" className="mt-3 max-h-40 rounded border object-contain" />}
          </div>
        )}
        <div className="rounded-xl border bg-muted/20 p-4">
          <FilePicker value={sig} onChange={setSig} purpose="certificate_signature" label="Upload the signature"
            hint="Optional. The principal's signature on white (PNG). Printed above the signatory's name." />
          {!sig && saved.signature_file_id && <img src={thumb(saved.signature_file_id)} alt="Current signature" className="mt-3 max-h-16 rounded border bg-white object-contain" />}
        </div>
      </div>
    </Card>
  )
}
