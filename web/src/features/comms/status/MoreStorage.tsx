import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, HardDrive, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/* MORE STORAGE (owner, 2026-10-10: "add a button, when clicked a storage
   request; later I'll add a payment gateway"). Until the gateway exists the
   school pays the way it already does and gives the UTR of that payment; the
   request is recorded with it (storage_requests) for the platform to check
   and grant. Only the administration may ask -- the server says who. */

type Storage = {
  used_bytes: number
  quota_bytes: number
  can_request: boolean
  pending: { id: string; extra_gb: number; utr: string | null; created_at: string } | null
}
const SIZES = [5, 20, 50, 100] as const
const gb = (b: number) => (b / 1024 ** 3).toFixed(1)

export function MoreStorageButton({ className }: { className?: string }) {
  const q = useQuery({ queryKey: ['status-storage'], queryFn: () => api.get<Storage>('/api/v1/status/storage') })
  const [open, setOpen] = useState(false)
  if (!q.data?.can_request) return null
  if (q.data.pending) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-[12.5px] font-medium', className)}>
        <Check className="size-3.5" aria-hidden="true" />
        Request for {q.data.pending.extra_gb} GB sent, being checked
      </span>
    )
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={cn('inline-flex min-h-[32px] items-center gap-1.5 rounded-full bg-[#92400e] px-3.5 text-[13px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90 active:opacity-80', className)}>
        <HardDrive className="size-3.5" aria-hidden="true" />
        Get more storage
      </button>
      {open && <RequestSheet storage={q.data} onClose={() => setOpen(false)} />}
    </>
  )
}

function RequestSheet({ storage, onClose }: { storage: Storage; onClose: () => void }) {
  const qc = useQueryClient()
  const [size, setSize] = useState<number>(20)
  const [utr, setUtr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const clean = utr.replace(/\s+/g, '').toUpperCase()
  const utrOk = /^[A-Z0-9]{12,22}$/.test(clean)

  const send = async () => {
    if (!utrOk || busy) return
    setBusy(true); setError('')
    try {
      await api.post('/api/v1/status/storage-request', { extra_gb: size, utr: clean, note })
      setSent(true)
      void qc.invalidateQueries({ queryKey: ['status-storage'] })
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not send the request. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      className="fixed inset-0 z-[400] flex items-end justify-center bg-black/30 p-0 backdrop-blur-[8px] sm:items-center sm:p-5">
      <div role="dialog" aria-modal="true" aria-label="Get more storage"
        className="w-full max-w-[420px] overflow-hidden rounded-t-[24px] bg-card text-foreground shadow-[0_14px_40px_rgba(0,0,0,.18)] sm:rounded-[24px]">
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 className="text-[17px] font-semibold">Get more storage</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            className="grid size-8 place-items-center rounded-full bg-muted text-muted-foreground hover:text-foreground">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {sent ? (
          <div className="px-5 pb-6 pt-3 text-center">
            <div className="mx-auto mb-3 grid size-14 place-items-center rounded-full bg-[#34c759] text-white shadow-[0_0_0_6px_rgba(52,199,89,.12)]">
              <Check className="size-7" strokeWidth={2.5} aria-hidden="true" />
            </div>
            <p className="text-[16px] font-semibold">Request sent</p>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              {size} GB, UTR {clean}. We will check the payment and add the storage; you will see it here once it is added.
            </p>
            <button type="button" onClick={onClose}
              className="mt-5 min-h-[44px] w-full rounded-xl bg-foreground text-[15px] font-semibold text-background">Done</button>
          </div>
        ) : (
          <div className="px-5 pb-5 pt-2">
            {/* How full it is now. */}
            <div className="mb-4">
              <div className="mb-1 flex justify-between text-[12.5px] text-muted-foreground">
                <span>Gallery storage</span>
                <span>{gb(storage.used_bytes)} of {gb(storage.quota_bytes)} GB used</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-[#f59e0b]"
                  style={{ width: `${Math.min(100, (storage.used_bytes / Math.max(1, storage.quota_bytes)) * 100)}%` }} />
              </div>
            </div>

            <p className="mb-2 text-[13px] font-medium">How much extra storage?</p>
            <div className="mb-4 grid grid-cols-4 gap-2" role="radiogroup" aria-label="Extra storage">
              {SIZES.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={size === s} onClick={() => setSize(s)}
                  className={cn('min-h-[44px] rounded-xl border text-[15px] font-semibold transition-colors',
                    size === s ? 'border-[#007aff] bg-[#007aff]/10 text-[#007aff]' : 'border-border hover:bg-muted/60')}>
                  +{s} GB
                </button>
              ))}
            </div>

            <ol className="mb-4 space-y-1 rounded-xl bg-muted/60 px-4 py-3 text-[13px] text-muted-foreground">
              <li><b className="text-foreground">1.</b> Pay for +{size} GB the way you pay your subscription.</li>
              <li><b className="text-foreground">2.</b> Enter the UTR number from that payment below.</li>
              <li><b className="text-foreground">3.</b> We check it and add the storage.</li>
            </ol>

            <label className="mb-1 block text-[13px] font-medium" htmlFor="storage-utr">UTR number</label>
            <input id="storage-utr" value={utr} onChange={(e) => setUtr(e.target.value)} inputMode="text" autoComplete="off"
              placeholder="e.g. 412345678901"
              className="mb-1 min-h-[44px] w-full rounded-xl border bg-background px-3 text-[15px] uppercase tracking-wide outline-none focus:border-[#007aff]" />
            <p className={cn('mb-3 text-[12px]', utr && !utrOk ? 'text-[#dc2626]' : 'text-muted-foreground')}>
              {utr && !utrOk ? 'A UTR is 12 to 22 letters or digits.' : 'UPI and IMPS give a 12-digit UTR; NEFT and RTGS give a longer one.'}
            </p>

            <label className="mb-1 block text-[13px] font-medium" htmlFor="storage-note">Note (optional)</label>
            <input id="storage-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
              placeholder="Anything we should know"
              className="mb-4 min-h-[44px] w-full rounded-xl border bg-background px-3 text-[15px] outline-none focus:border-[#007aff]" />

            {error && <p role="alert" className="mb-3 rounded-lg bg-[#fee2e2] px-3 py-2 text-[13px] text-[#991b1b]">{error}</p>}

            <button type="button" onClick={send} disabled={!utrOk || busy}
              className="min-h-[48px] w-full rounded-xl bg-[#007aff] text-[16px] font-semibold text-white transition-opacity disabled:opacity-40">
              {busy ? 'Sending…' : `Send request for +${size} GB`}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
