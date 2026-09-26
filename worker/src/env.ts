export interface Env {
  CONTROL: D1Database
  /** Live file bucket (read). */
  FILES: R2Bucket
  /** Where uploads and deletes go (the test bucket until switchover). */
  FILES_WRITE: R2Bucket
  /** Background jobs (src/services/jobs.ts). */
  JOBS: Queue
  /** Live update hubs, one per school (src/services/live.ts). */
  LIVE: DurableObjectNamespace
  CREDENTIAL_KEY?: string
  SESSION_SECRET?: string
  PASSWORD_PEPPER: string
  SESSION_TTL_SECONDS: string
  SESSION_IDLE_SECONDS: string
  COOKIE_SECURE: string
  // TENANT_<slug> bindings, added per school by scripts/provision-school.sh.
  [binding: string]: D1Database | R2Bucket | Queue | DurableObjectNamespace | string | undefined
}

export const now = () => new Date().toISOString()

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}
