import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type SessionResponse } from './api'

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

  return <SessionContext.Provider value={data}>{children}</SessionContext.Provider>
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
