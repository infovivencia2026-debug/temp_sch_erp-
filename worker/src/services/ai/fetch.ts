import type { Env } from '../../env'

/** A fetch to a Google AI host (Gemini, Vertex, text-to-speech).

    Goes through the AI_RELAY service binding when the Worker has one, because
    Google refuses Gemini calls from the region the main Worker is pinned to
    (worker/ai-relay/index.ts says why). Without the binding -- tests, local
    dev -- it is a plain fetch. */
export function aiFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const relay = env.AI_RELAY
  if (!relay) return fetch(url, init)
  const headers = new Headers(init.headers)
  headers.set('x-relay-target', url)
  return relay.fetch('https://relay.internal/', { ...init, headers })
}
