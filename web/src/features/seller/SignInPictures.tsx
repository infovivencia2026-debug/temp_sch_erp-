import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { buzz } from '@/lib/haptics'
import { Button, Dialog, FormNotice } from '@/components/ui'

interface Slide { id: string; position: number; url: string; created_at: string }
interface Slides { items: Slide[]; max: number }

/* Sign-in pictures: shown as a sliding gallery on the school's public sign-in
   page. Separate from the School Gallery on purpose: that page is public.
   Uploads wait for the server, since the page is public as soon as it is saved. */
export function SignInPictures({ tenantId, onChange }: { tenantId: string; onChange: () => void }) {
  const qc = useQueryClient()
  const base = `/api/v1/seller/tenants/${tenantId}/slides`
  const key = ['seller-slides', tenantId]
  const list = useQuery({ queryKey: key, queryFn: () => api.get<Slides>(base) })
  const file = useRef<HTMLInputElement>(null)
  const [removing, setRemoving] = useState<Slide | null>(null)

  const done = (d: Slides) => { qc.setQueryData(key, d); onChange() }
  const add = useMutation({
    mutationFn: async (f: File) => {
      const data_url = await new Promise<string>((ok, fail) => {
        const r = new FileReader()
        r.onload = () => ok(String(r.result))
        r.onerror = () => fail(r.error)
        r.readAsDataURL(f)
      })
      return api.post<Slides>(base, { data_url })
    },
    onSuccess: done,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.del<Slides>(`${base}/${id}`),
    onSuccess: (d) => { setRemoving(null); done(d) },
  })
  const order = useMutation({ mutationFn: (ids: string[]) => api.put<Slides>(`${base}/order`, { ids }), onSuccess: done })

  const items = list.data?.items ?? []
  const max = list.data?.max ?? 8
  const busy = add.isPending || remove.isPending || order.isPending
  const move = (i: number, by: -1 | 1) => {
    const ids = items.map((s) => s.id)
    ;[ids[i], ids[i + by]] = [ids[i + by], ids[i]]
    order.mutate(ids)
  }

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold">Sign-in pictures</h3>
          <p className="text-[12.5px] text-muted-foreground">
            Shown in turn on the school’s sign-in page. PNG, JPEG or WebP, under 1 MB each. Square pictures look best. {items.length} of {max}
          </p>
        </div>
        <Button variant="secondary" disabled={busy || list.isLoading || items.length >= max} onClick={() => file.current?.click()}>
          <Plus className="h-3.5 w-3.5" /> {add.isPending ? 'Adding…' : 'Add picture'}
        </Button>
        <input
          ref={file}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) add.mutate(f); e.target.value = '' }}
        />
      </div>
      {list.isSuccess && items.length === 0 && (
        <p className="mt-3 text-[13px] text-muted-foreground">No sign-in pictures. The sign-in page shows the school’s logo and name instead.</p>
      )}
      {items.length > 0 && (
        <ol className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {items.map((s, i) => (
            <li key={s.id} className="min-w-0">
              <img src={s.url} alt={`Sign-in picture ${i + 1}`} loading="lazy" decoding="async" className="aspect-square w-full rounded-md border bg-muted object-cover" />
              <div className="mt-1.5 flex items-center justify-between gap-1">
                <Button variant="ghost" size="sm" title="Move earlier" disabled={busy || i === 0} onClick={() => move(i, -1)}>
                  <ArrowLeft className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" title="Remove" tone="danger" disabled={busy} onClick={() => setRemoving(s)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" title="Move later" disabled={busy || i === items.length - 1} onClick={() => move(i, 1)}>
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <FormNotice error={list.error ?? add.error ?? order.error} />
      {removing && (
        <Dialog
          raised
          size="sm"
          onClose={() => setRemoving(null)}
          title="Remove this picture?"
          description="It stops showing on the sign-in page at once."
          footer={<>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button tone="danger" disabled={remove.isPending} onClick={() => { buzz('warn'); remove.mutate(removing.id) }}>
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </>}
        >
          <img src={removing.url} alt="" className="mx-auto aspect-square w-32 rounded-md border object-cover" />
          <FormNotice error={remove.error} />
        </Dialog>
      )}
    </section>
  )
}
