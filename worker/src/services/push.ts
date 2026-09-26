import type { Env } from '../env'

/* internal/push/fcm.go on the Worker. The service account JSON comes from the
   Worker secret FCM_SERVICE_ACCOUNT (the whole JSON as a string) instead of a
   file. The OAuth access token is an RS256 JWT signed with WebCrypto and
   exchanged at the token URI; it is cached per isolate until a minute before
   it expires. Unset secret: push is off, as the Go worker was without
   FCM_SERVICE_ACCOUNT_FILE. */

export interface PushMessage { title: string; body: string; link: string; kind: string; id: string }

interface SA { project_id: string; client_email: string; private_key: string; token_uri: string }

let cached: { raw: string; sa: SA; key: CryptoKey } | null = null
let access: { token: string; expires: number } | null = null

export const pushConfigured = (env: Env) => typeof env.FCM_SERVICE_ACCOUNT === 'string' && env.FCM_SERVICE_ACCOUNT.trim() !== ''

const b64url = (bytes: Uint8Array) => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function account(env: Env): Promise<{ sa: SA; key: CryptoKey }> {
  const raw = String(env.FCM_SERVICE_ACCOUNT ?? '')
  if (cached && cached.raw === raw) return cached
  let sa: SA
  try { sa = JSON.parse(raw) as SA } catch (e) { throw new Error('push: service account is not JSON: ' + (e as Error).message) }
  if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error('push: service account lacks project_id, client_email or private_key')
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  if (!pem) throw new Error('push: private_key is not PEM')
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0))
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  } catch (e) { throw new Error('push: private key: ' + (e as Error).message) }
  sa.token_uri ||= 'https://oauth2.googleapis.com/token'
  cached = { raw, sa, key }
  access = null
  return cached
}

async function accessToken(env: Env): Promise<{ token: string; project: string }> {
  const { sa, key } = await account(env)
  if (access && access.expires - Date.now() > 60_000) return { token: access.token, project: sa.project_id }
  const now = Math.floor(Date.now() / 1000)
  const enc = new TextEncoder()
  const header = b64url(enc.encode('{"alg":"RS256","typ":"JWT"}'))
  const payload = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.token_uri, iat: now, exp: now + 3600,
  })))
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(header + '.' + payload)))
  const jwt = header + '.' + payload + '.' + b64url(sig)
  const res = await fetch(sa.token_uri, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  })
  let out: { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  try { out = await res.json() } catch (e) { throw new Error('push: token response: ' + (e as Error).message) }
  if (!out.access_token) throw new Error(`push: no access token: ${out.error ?? ''} ${out.error_description ?? ''}`)
  access = { token: out.access_token, expires: now * 1000 + (out.expires_in ?? 0) * 1000 }
  return { token: access.token, project: sa.project_id }
}

/** One push. 'unregistered' when the token is dead (Go: ErrUnregistered); throws on other failures. */
export async function sendPush(env: Env, token: string, m: PushMessage): Promise<'ok' | 'unregistered'> {
  const a = await accessToken(env)
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project}/messages:send`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token, data: { title: m.title, body: m.body, link: m.link, kind: m.kind, id: m.id }, android: { priority: 'high' } } }),
  })
  if (res.status >= 200 && res.status < 300) return 'ok'
  const text = (await res.text()).slice(0, 4096)
  if (res.status === 404 || text.includes('UNREGISTERED')) return 'unregistered'
  throw new Error(`push: fcm ${res.status}: ${text.trim()}`)
}
