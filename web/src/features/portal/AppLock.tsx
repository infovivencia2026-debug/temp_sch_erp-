import { useState } from 'react'
import { Fingerprint, ShieldCheck } from 'lucide-react'
import { PageHead, PageBody, Card, CardHeader, Checkbox, EmptyState } from '@/components/ui'

/* Lock the app behind the phone's own fingerprint or face.

   Nothing here touches the server. The lock belongs to the handset: the
   Android app keeps the setting, and when the app comes back to the front
   after being away it asks the phone to confirm the owner before the portal is
   shown again. The check is the phone's — the same one that unlocks it — and
   this product never sees a fingerprint or a face.

   In a browser there is no app to lock, and the screen says so instead of
   showing a switch that would do nothing. */

interface LockBridge {
  setAppLock(on: boolean): void
  appLockEnabled(): boolean
  biometricsAvailable?(): boolean
}

function bridge(): LockBridge | null {
  const b = window.ErpShell
  if (!b?.setAppLock || !b.appLockEnabled) return null
  return b as LockBridge
}

export default function AppLock() {
  const shell = bridge()
  const [on, setOn] = useState<boolean>(() => {
    try {
      return shell?.appLockEnabled() ?? false
    } catch {
      return false
    }
  })
  const available = (() => {
    try {
      return shell?.biometricsAvailable?.() ?? true
    } catch {
      return true
    }
  })()

  const toggle = (v: boolean) => {
    if (!shell) return
    try {
      shell.setAppLock(v)
      setOn(v)
    } catch {
      /* The bridge refused; the switch stays where it was, which is the truth. */
    }
  }

  return (
    <>
      <PageHead eyebrow="Profile" title="App lock" />
      <PageBody width="form">
        {!shell ? (
          <EmptyState
            title="Only in the app"
            body="The lock uses your phone's fingerprint or face. Open this from the school's Android app to turn it on."
          />
        ) : !available ? (
          <EmptyState
            title="No fingerprint or face set up"
            body="Add one in your phone's settings first, then come back here."
          />
        ) : (
          <Card>
            <CardHeader title="Ask before showing the app" />
            <div className="space-y-4 px-5 py-4">
              <Checkbox
                checked={on}
                onChange={toggle}
                label="Ask for my fingerprint or face"
                hint="Whenever the app comes back to the front after a minute away."
              />
              <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
                {on ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> : <Fingerprint className="mt-0.5 h-4 w-4 shrink-0" />}
                {on
                  ? 'On. The phone checks it is you; the school never sees the fingerprint.'
                  : 'Off. Anyone holding the unlocked phone can open the app.'}
              </p>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
