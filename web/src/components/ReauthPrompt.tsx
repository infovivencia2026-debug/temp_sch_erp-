import { useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { Button, Input } from '@/components/ui'
import { useOpenState } from '@/lib/motion'

/* The password again, before money moves.

   A fee collection, a wallet top-up or a payroll run on a session whose
   password was typed more than fifteen minutes ago is refused by the server
   with code reauth_required. api.ts turns that refusal into a window event;
   this listens for it and asks for the password. On success the person
   presses the button they pressed before -- the request is not replayed
   here, because a payment is exactly the thing that must not be sent twice
   by a helper that lost track of what it was sending. */
export default function ReauthPrompt() {
  const [open, setOpen] = useOpenState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const on = () => {
      setDone(false)
      setError(null)
      setOpen(true)
    }
    window.addEventListener('erp:reauth', on)
    return () => window.removeEventListener('erp:reauth', on)
  }, [])

  if (!open) return null

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/v1/session/reauth', { password })
      setPassword('')
      setDone(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not confirm. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
    >
      <div className="w-full max-w-[26rem] rounded-xl border bg-background p-5 shadow-xl">
        {done ? (
          <>
            <p id="reauth-title" className="text-[16px] font-semibold">Confirmed</p>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              Your password is confirmed for the next fifteen minutes. Press the button again to complete
              what you were doing.
            </p>
            <div className="mt-4 flex justify-end">
              <Button onClick={() => setOpen(false)}>Back to the screen</Button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void confirm()
            }}
          >
            <p id="reauth-title" className="text-[16px] font-semibold">Confirm your password</p>
            <p className="mt-1 text-[13.5px] text-muted-foreground">
              This action moves money and your sign-in is older than fifteen minutes. Type your password
              to continue.
            </p>
            <label className="mt-4 block">
              <span className="text-[13px] text-muted-foreground">Password</span>
              <Input type="password" value={password} onChange={setPassword} className="mt-1 w-full" />
            </label>
            {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!password || busy}>
                {busy ? 'Checking…' : 'Confirm'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
