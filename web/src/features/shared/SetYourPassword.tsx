import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Field, FormNotice, Input } from '@/components/ui'

/* The first thing a family sees, and the only thing until it is done.

   Logins are issued in bulk against the list the school already has: the
   sign-in name is the person's mobile number, and so is the first password.
   That is the only pair that works at four hundred families — a generated code
   has to be printed, carried home and typed correctly by somebody who has
   never seen this system, and half of them are lost by the second week.

   The cost of that choice is that the password is on the class list, in every
   other parent's phone, and on the admission form. So it buys exactly one
   thing: this screen. The API enforces the same rule, and refuses everything
   else while it stands — a screen is not a gate.

   No cancel, no skip, and no navigation: there is nothing else to do here, and
   an escape route is the difference between a rule and a suggestion. */
export default function SetYourPassword({ signInName }: { signInName?: string }) {
  const qc = useQueryClient()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')

  const tooShort = next.length > 0 && next.length < 12
  const mismatch = again.length > 0 && again !== next
  const sameAsCurrent = next.length > 0 && next === current

  const change = useMutation({
    mutationFn: () =>
      api.post('/api/v1/profile/password', { current_password: current, new_password: next }),
    // The session carries the flag, so re-reading it is what dismisses this
    // screen. Nothing here navigates: the app appears underneath.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }),
  })
  const skip = useMutation({
    mutationFn: () => api.post('/api/v1/profile/password/skip', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }),
  })

  return (
    <div className="grid h-full place-items-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-[22px] font-semibold">Set your own password</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">
          The school gave you your phone number as a temporary password. Anyone holding the
          class list knows it, so choose one only you know before you go any further.
        </p>

        <div className="mt-6 space-y-4">
          <Field
            label="The password the school gave you"
            hint={signInName ? `The same one you just signed in with as ${signInName}.` : undefined}
          >
            <Input type="password" value={current} onChange={setCurrent} />
          </Field>
          <Field label="Your new password" hint="At least 12 characters.">
            <Input type="password" value={next} onChange={setNext} />
          </Field>
          <Field label="Type it again">
            <Input type="password" value={again} onChange={setAgain} />
          </Field>

          {/* Said before the button is pressed, not after the server refuses:
              these three are knowable here, and a round trip to be told the
              two boxes differ is a round trip nobody needed. */}
          {tooShort && (
            <p className="text-[13px] text-destructive">
              That is {next.length} characters. It needs at least 12.
            </p>
          )}
          {mismatch && (
            <p className="text-[13px] text-destructive">The two new passwords do not match.</p>
          )}
          {sameAsCurrent && (
            <p className="text-[13px] text-destructive">
              That is the password the school gave you. Choose a different one.
            </p>
          )}

          <FormNotice error={change.error} />

          <Button
            className="w-full"
            disabled={
              change.isPending ||
              current.length === 0 ||
              next.length < 12 ||
              next !== again ||
              sameAsCurrent
            }
            onClick={() => change.mutate()}
          >
            {change.isPending ? 'Saving…' : 'Save and continue'}
          </Button>

          <p className="text-[13px] text-muted-foreground">
            Every other device signed in as you is signed out when you do this.
          </p>

          {/* THE WAY PAST, ADDED ON THE SCHOOL'S INSTRUCTION.

              This screen was written with no skip on purpose, and the note
              above the component still says why. The school running it has
              decided otherwise: a parent handed a login and then told they
              cannot see their child's fees until they have invented a
              twelve-character password is a parent who puts the phone down.
              So the change stays offered, the risk is stated in one line,
              and the parent may go on with the number they were given. The
              server clears the flag on this call and refuses nothing after
              it; the screen goes away by the same session re-read as a
              successful change. */}
          <Button
            variant="secondary"
            className="w-full"
            disabled={skip.isPending || change.isPending}
            onClick={() => skip.mutate()}
          >
            {skip.isPending ? 'One moment…' : 'Skip for now, keep the password I was given'}
          </Button>
          <FormNotice error={skip.error} />
        </div>

        <a href="/logout" className="mt-6 inline-block text-[13px] text-muted-foreground underline">
          Sign out instead
        </a>
      </div>
    </div>
  )
}
