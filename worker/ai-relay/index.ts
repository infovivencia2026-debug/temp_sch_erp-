/* THE GEMINI RELAY.

   The main Worker is pinned to aws:ap-east-1 (Hong Kong) to sit next to the
   D1 databases, and Google's Gemini API answers every call from there with
   400 FAILED_PRECONDITION "User location is not supported for the API use"
   (measured 2026-10-07; the same key works from India). Moving the whole
   Worker would put a D1 round trip on every page, so only the Google AI
   calls leave through this small Worker, pinned to aws:ap-south-1 (Mumbai).

   Reachable only through the main Worker's service binding: no workers.dev
   route, no custom domain. It forwards to the three Google AI hosts and
   nothing else, so it cannot be used as an open proxy even by the binding. */

const ALLOWED = new Set([
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'texttospeech.googleapis.com',
])

export default {
  async fetch(req: Request): Promise<Response> {
    const target = req.headers.get('x-relay-target')
    let url: URL
    try { url = new URL(target ?? '') } catch { return new Response('bad target', { status: 400 }) }
    if (url.protocol !== 'https:' || !ALLOWED.has(url.hostname)) return new Response('target not allowed', { status: 403 })
    const headers = new Headers(req.headers)
    for (const h of ['x-relay-target', 'host', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'x-forwarded-for', 'x-real-ip']) headers.delete(h)
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body
    return fetch(url.toString(), { method: req.method, headers, body })
  },
}
