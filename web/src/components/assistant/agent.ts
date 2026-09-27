/* The assistant's tool-calling path: POST /api/v1/assistant/agent answers as
   a stream of JSON lines (worker/src/routes/misc/assistant/agent.ts), one per
   step, so the chat can show each lookup as it runs. Kept apart from
   AssistantTab so the tab only has to hand it a message and draw what comes
   back. */

export interface Link { label: string; to: string }

/** A tool's answer, already capped and shaped by the server for a compact table. */
export interface ToolView {
  title: string
  columns: string[]
  rows: (string | number)[][]
  row_links?: (string | null)[]
  total?: number
  stats?: { label: string; value: string | number }[]
}

/** One lookup, as the chat shows it: "Looking up…" until done, then its table. */
export interface ToolStep {
  id: number
  name: string
  label: string
  state: 'running' | 'done' | 'failed'
  view?: ToolView
  links?: Link[]
  error?: string
}

/** A change the assistant prepared; nothing is written until Confirm. */
export interface AgentCard {
  kind: string
  title: string
  summary: string
  before?: string
  after?: string
  sensitive: boolean
  params: Record<string, unknown>
  token: string
  changes?: { label: string; before?: string; after: string }[]
  counts?: { label: string; value: string | number }[]
  state?: 'idle' | 'busy' | 'done' | 'cancelled' | 'error'
  result?: string
}

export type AgentEvent =
  | { t: 'conv'; conversation_id: string }
  | { t: 'tool'; id: number; name: string; label: string }
  | { t: 'tool_done'; id: number; name: string; ok: boolean; view?: ToolView; links?: Link[]; error?: string }
  | { t: 'action'; action: AgentCard }
  | { t: 'answer'; text: string; links?: Link[] }
  | { t: 'error'; message: string; code?: string }

export const AGENT_URL = '/api/v1/assistant/agent'

/** The server's sentence from a JSON refusal, whichever shape it came in. */
export function errorText(body: unknown, fallback: string): string {
  const e = (body as { error?: unknown } | null)?.error
  if (typeof e === 'string') return e
  if (e && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message
  return fallback
}

/** Send one message; onEvent is called per line as it arrives. Resolves when the stream ends. */
export async function streamAgent(message: string, conversationId: string | null, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(AGENT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ message, conversation_id: conversationId }),
    signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null)
    throw new Error(errorText(body, `The assistant returned ${res.status}.`))
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) { try { onEvent(JSON.parse(line) as AgentEvent) } catch { /* a torn line is skipped, not fatal */ } }
    }
    if (done) break
  }
  if (buf.trim()) { try { onEvent(JSON.parse(buf) as AgentEvent) } catch { /* ignore */ } }
}

/** Confirm a prepared change: the one request that writes. */
export async function confirmCard(card: AgentCard): Promise<string> {
  const res = await fetch('/api/v1/assistant/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ kind: card.kind, params: card.params, token: card.token }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(errorText(data, 'The change could not be made.'))
  return String((data as { message?: string } | null)?.message ?? 'Done.')
}

/* HANDING A QUESTION TO THE ASSISTANT FROM ANYWHERE.

   The command search (Cmd-K) finds screens and people; a question in words
   ("who hasn't paid fees in class 8?") is the assistant's. The palette
   dispatches this event and the assistant tab, which is mounted once in the
   shell, opens and asks it. An event rather than a context so neither
   component has to know where the other sits. */
export const ASK_EVENT = 'erp:assistant-ask'
export function askAssistant(question: string): void {
  window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { question } }))
}

/** Whether what was typed into the search reads as a question rather than a name or a screen. */
export function looksLikeQuestion(q: string): boolean {
  const s = q.trim().toLowerCase()
  if (s.length < 8) return false
  if (s.endsWith('?')) return true
  const words = s.split(/\s+/)
  if (words.length < 3) return false
  return /^(who|what|which|how|when|where|why|show|list|is|are|did|does|do|has|have|can|tell|give|find|mark|send|remind|approve|reject|set|schedule|create|compare|top)\b/.test(s)
}
