import { useEffect, useState } from 'react'
import { Button, Dialog } from '@/components/ui'
import { aimShared, onShared, peekShared, takeShared, type Shared } from '@/lib/shell'
import { useSession } from '@/lib/session'

/* FILES SHARED INTO THE APP FROM ANOTHER APP.

   A teacher picks photos in the phone's gallery and shares them to the app
   (Android share sheet, iOS Share Extension). The shell hands them to the page
   (lib/shell.ts); this asks where they go and opens that screen, which takes
   them. Only destinations that can take a shared file are offered. */
export default function ShareInbox() {
  const [s, setS] = useState<Shared | null>(() => peekShared())
  const session = useSession()
  useEffect(() => onShared(() => setS(peekShared())), [])
  if (!s || s.target) return null

  const media = s.files.filter((f) => /^(image|video)\//.test(f.type))
  const canStatus = media.length > 0 && !!session?.permissions?.some((p) => p === '*' || p.startsWith('status.'))
  const n = s.files.length
  const go = (path: string) => {
    aimShared('status')
    window.history.pushState({}, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  return (
    <Dialog
      onClose={() => takeShared()}
      title={`${n} ${n === 1 ? 'file' : 'files'} shared to this app`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => takeShared()}>Cancel</Button>
          {canStatus && <Button onClick={() => go('/go/communication/class_status')}>Post as Class Status</Button>}
        </>
      }
    >
      <p className="text-[13px] text-muted-foreground">
        {canStatus
          ? 'Post the photo or video to your class as a status.'
          : 'This account has no screen that takes shared files. Open the screen you want and attach the file there.'}
      </p>
      <ul className="mt-3 space-y-1 text-[13px]">
        {s.files.map((f, i) => <li key={i} className="truncate">{f.name}</li>)}
      </ul>
    </Dialog>
  )
}
