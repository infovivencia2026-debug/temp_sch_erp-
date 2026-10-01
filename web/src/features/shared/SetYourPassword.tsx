import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Field, FormNotice, Input } from '@/components/ui'
import { I18nProvider, useT } from '@/lib/i18n'

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
  /* lib/session.tsx renders this screen in place of the whole app, above the
     I18nProvider in App.tsx, so it brings its own: without it useT falls back
     to English and a Telugu family's first screen would ignore their choice.
     The provider reads the same stored locale the app does. */
  return (
    <I18nProvider>
      <SetYourPasswordForm signInName={signInName} />
    </I18nProvider>
  )
}

function SetYourPasswordForm({ signInName }: { signInName?: string }) {
  const t = useT()
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
  /* A child's login is issued on a printed code, not a phone number, and the
     school's rule for children is the original one: no way past. The server
     refuses the skip for a student account too. */
  const roles = qc.getQueryData<{ user?: { roles?: string[] } }>(['session'])?.user?.roles ?? []
  const student = roles.length > 0 && roles.every((r) => r === 'student')
  const skip = useMutation({
    mutationFn: () => api.post('/api/v1/profile/password/skip', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }),
  })

  return (
    <div className="grid h-full place-items-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-[22px] font-semibold">{t('shared.set_your_password.title')}</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">
          {student
            ? t('shared.set_your_password.intro_student')
            : t('shared.set_your_password.intro_parent')}
        </p>

        <div className="mt-6 space-y-4">
          <Field
            label={t('shared.set_your_password.current_label')}
            hint={signInName ? t('shared.set_your_password.current_hint', { name: signInName }) : undefined}
          >
            <Input type="password" value={current} onChange={setCurrent} />
          </Field>
          <Field label={t('shared.set_your_password.new_label')} hint={t('shared.set_your_password.new_hint')}>
            <Input type="password" value={next} onChange={setNext} />
          </Field>
          <Field label={t('shared.set_your_password.again_label')}>
            <Input type="password" value={again} onChange={setAgain} />
          </Field>

          {/* Said before the button is pressed, not after the server refuses:
              these three are knowable here, and a round trip to be told the
              two boxes differ is a round trip nobody needed. */}
          {tooShort && (
            <p className="text-[13px] text-destructive">
              {t('shared.set_your_password.too_short', { n: next.length })}
            </p>
          )}
          {mismatch && (
            <p className="text-[13px] text-destructive">{t('shared.set_your_password.mismatch')}</p>
          )}
          {sameAsCurrent && (
            <p className="text-[13px] text-destructive">
              {t('shared.set_your_password.same_as_current')}
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
            {change.isPending ? t('shared.set_your_password.saving') : t('shared.set_your_password.save')}
          </Button>

          <p className="text-[13px] text-muted-foreground">
            {t('shared.set_your_password.signs_out_others')}
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
          {!student && (
            <Button
              variant="secondary"
              className="w-full"
              disabled={skip.isPending || change.isPending}
              onClick={() => skip.mutate()}
            >
              {skip.isPending ? t('shared.set_your_password.skipping') : t('shared.set_your_password.skip')}
            </Button>
          )}
          {!student && <FormNotice error={skip.error} />}
        </div>

        <a href="/logout" className="mt-6 inline-block text-[13px] text-muted-foreground underline">
          {t('shared.set_your_password.sign_out')}
        </a>
      </div>
    </div>
  )
}
