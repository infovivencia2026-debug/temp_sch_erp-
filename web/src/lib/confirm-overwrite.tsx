import { createRoot } from 'react-dom/client'
import { Button, Dialog } from '@/components/ui'

/* One question before an identifying code is replaced (owner, 2026-10-14).

   The server refuses a write that would change a non-empty staff code,
   admission number, PAN, reader id and the like with 409 confirm_overwrite and
   the list of {label, from, to} (worker/src/services/overwrite.ts). lib/api.ts
   catches that, asks here once for the whole list, and resends with
   confirm_overwrite: true -- so every form is covered without each one
   carrying its own check. Mounted on its own root because it is called from
   the request layer, outside any screen's tree. */

export interface OverwriteChange { field: string; label: string; from: string; to: string | null }

const line = (c: OverwriteChange) => (c.to
  ? `Replace ${c.label} ${c.from} with ${c.to}?`
  : `Clear ${c.label} ${c.from}?`)

export function confirmOverwrite(changes: OverwriteChange[]): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false)
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let done = false
    const finish = (yes: boolean) => {
      if (done) return
      done = true
      resolve(yes)
      // Unmounted after the click has finished propagating.
      setTimeout(() => { root.unmount(); host.remove() }, 0)
    }
    root.render(
      <Dialog
        onClose={() => finish(false)}
        title={changes.length === 1 ? 'Replace this?' : 'Replace these?'}
        size="sm"
        raised
        footer={
          <>
            <Button variant="secondary" onClick={() => finish(false)}>Cancel</Button>
            <Button onClick={() => finish(true)}>Confirm</Button>
          </>
        }
      >
        <ul className="space-y-1 text-[14px]">
          {changes.map((c) => <li key={c.field}>{line(c)}</li>)}
        </ul>
        <p className="mt-3 text-[13px] text-muted-foreground">
          Other records and registers may use the old value.
        </p>
      </Dialog>,
    )
  })
}
