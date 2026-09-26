import type { Env } from '../env'
import { forgot, reset, showForgot, showReset } from './reset'
import { showApps, showBuy, showSignup, startSignup, submitBuy } from './buy'
import { loginMFA } from './mfa'

/** The public HTML pages the Go server rendered from internal/templates, or null. */
export async function handlePages(env: Env, req: Request, url: URL): Promise<Response | null> {
  const m = req.method
  switch (url.pathname) {
    case '/forgot': return m === 'GET' ? showForgot() : m === 'POST' ? forgot(env, req) : null
    case '/reset': return m === 'GET' ? showReset(env, url) : m === 'POST' ? reset(env, req) : null
    case '/buy': return m === 'GET' ? showBuy(env, url) : m === 'POST' ? submitBuy(env, req) : null
    case '/signup': return m === 'GET' ? showSignup(env, url) : m === 'POST' ? startSignup(env, req) : null
    case '/apps': return m === 'GET' ? showApps() : null
    case '/login/mfa': return m === 'POST' ? loginMFA(env, req) : null
  }
  return null
}
