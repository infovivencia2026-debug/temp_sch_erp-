import { badRequest, errorResponse } from '../http'

/** An HTML response with the headers the Go handler set. */
export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
}
export const NO_STORE = { 'cache-control': 'no-store' }

export async function formOf(req: Request): Promise<FormData | null> {
  return req.formData().catch(() => null)
}
export const field = (f: FormData, k: string) => { const v = f.get(k); return typeof v === 'string' ? v : '' }

/** Go's httpx.BadRequest for an unreadable form. */
export const badForm = () => errorResponse(badRequest('could not read the form'))

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
