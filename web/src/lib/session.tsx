import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type SessionResponse } from './api'
import { setOutboxUser } from './outbox'
import { forgetCachedDataOnUserChange } from './sw-data'
import SetYourPassword from '@/features/shared/SetYourPassword'
import { claimTabs } from './tabs'

const SessionContext = createContext<SessionResponse | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionResponse>('/api/v1/session'),
    // The server answers 200 with {authenticated:false} rather than 401, so a
    // signed-out visitor is a normal result, not a retryable failure.
    retry: false,
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <p className="text-sm text-muted-foreground">Could not reach the server.</p>
          <button
            onClick={() => location.reload()}
            className="mt-3 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!data.authenticated) {
    // Full navigation, not a client route: /login is server-rendered by the Go
    // binary and must mint the cookie itself.
    const next = encodeURIComponent(location.pathname + location.search)
    location.replace(`/login?next=${next}`)
    return null
  }

  // A school that has not paid still signs in -- being shut out of your own
  // attendance register because an invoice is late turns a billing problem
  // into a safeguarding one -- but it gets one screen instead of the app.
  // Rendered here rather than per route so there is no ordering in which a
  // module briefly appears before the notice replaces it.
  if (data.subscription && !data.subscription.active) {
    return <Locked session={data} />
  }

  /* A login issued in bulk starts on the person's own phone number, which is
     on the class list and in every other parent's phone. One screen until they
     replace it — above the app rather than inside it, so there is no route,
     no tab and no back button that reaches anything else. The API refuses the
     same requests regardless; this is the half that explains why. */
  if (data.user?.must_change_password) {
    return <SetYourPassword signInName={data.user.full_name} />
  }

  /* The tab strip belongs to whoever is signed in.

     sessionStorage survives a sign-out — it is scoped to the browser tab, not
     to the login — so without this the next person on a shared front-desk
     machine inherits the last one's eight open screens. Claiming here rather
     than on the sign-out path because sign-out is a full navigation to the Go
     binary's /logout: there is no reliable moment for the SPA to tidy up on
     the way out, and the arrival of a session is the one moment that is
     certain.

     Not an effect: this runs during render, before any child reads the strip,
     so nobody sees the previous person's tabs even for a frame. claimTabs is
     idempotent for the same user, so a re-render costs nothing. */
  if (data.user) claimTabs(data.user.id)
  /* And the outbox follows the same person for the same reason. A queue of
     unsent writes flushed under the next sign-in posts one teacher's register
     as another, to sections they may not even be scoped for. */
  setOutboxUser(data.user?.id)
  forgetCachedDataOnUserChange(data.user?.id)

  return <SessionContext.Provider value={data}>{children}</SessionContext.Provider>
}

/**
 * The locked school.
 *
 * Deliberately not an error page. Nothing has failed and nothing is lost, and
 * saying so is the first thing a head teacher needs to read -- the second is
 * the single action that fixes it.
 */
function Locked({ session }: { session: SessionResponse }) {
  const sub = session.subscription!
  const school = session.institution?.name ?? 'This school'
  const heading =
    sub.code === 'expired' ? 'Your trial has ended'
    : sub.code === 'past_due' ? 'Your subscription is unpaid'
    : sub.code === 'suspended' ? 'This account is suspended'
    : sub.code === 'cancelled' ? 'This subscription was cancelled'
    : `${school} does not have a subscription`

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-lg rounded-xl border bg-card p-8 text-center">
        <h1 className="text-xl font-semibold">{heading}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {sub.reason ?? 'Choose a plan to switch the system on.'}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Your data is safe and nothing has been deleted. Everything is exactly
          where you left it and comes straight back when the subscription is active.
        </p>

        {/* The button only a paying school gets past. It is the largest thing
            on the page because it is the only thing to do on it. */}
        <a
          href="/buy"
          className="mt-7 block rounded-xl bg-primary px-8 py-5 text-lg font-semibold text-primary-foreground"
        >
          {sub.code === 'none' || sub.code === 'expired' ? 'See plans and subscribe' : 'Settle and reactivate'}
        </a>

        <p className="mt-5 text-xs text-muted-foreground">
          Signed in as {session.user?.full_name}
          {sub.plan_name ? ` · last plan: ${sub.plan_name}` : ''}
        </p>
        <a href="/logout" className="mt-2 inline-block text-xs underline text-muted-foreground">
          Sign out
        </a>
      </div>
    </div>
  )
}

export function useSession(): SessionResponse {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}

// Permission checks are advisory in the client: they hide what the user cannot
// do. The server enforces the same keys on every route, so a tampered client
// gains nothing but a 403.
export function useCan() {
  const session = useSession()
  const set = new Set(session.permissions)
  return (perm: string) => session.user?.platform_admin === true || set.has(perm)
}
