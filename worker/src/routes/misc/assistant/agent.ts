import type { Ctx, Router } from '../../../router'
import { badRequest, HttpError, isUUID, ok, readJSON } from '../../../http'
import { auditStmt } from '../../admin/common'
import { indiaToday } from '../../students/common'
import { assistantFailure, assistantRateLimit, geminiRequest } from '../../teaching/gemini'
import { assistantGrounding, assistantRoles, SYSTEM_PROMPT } from '../assistant'
import { ActionRefusal, refusalText } from './actions'
import { AGENT_ACTIONS, actionByKind, mayPropose, proposeName, type AgentAction, type AgentProposal } from './actions_more'
import { READ_TOOLS, type ToolResult, type ToolSpec } from './tools'
import type { Link } from './read'

/* THE ASSISTANT THAT CAN LOOK THINGS UP AND PREPARE CHANGES.

   POST /assistant/agent takes one message and answers as a stream of JSON
   lines, so the chat can show each lookup as it happens:

     {"t":"conv","conversation_id":...}
     {"t":"tool","id":1,"name":"fee_defaulters","label":"Listing fee defaulters"}
     {"t":"tool_done","id":1,"ok":true,"view":{...},"links":[...]}
     {"t":"action","action":{...card..., "token":...}}
     {"t":"answer","text":"...","links":[...]}
     {"t":"error","message":"...","code":"..."}

   Gemini gets the read tools (tools.ts) and one propose_* function per action
   the person may take (actions_more.ts) as function declarations. Tools run
   as the caller through the Worker's own routes; a proposal only builds the
   card. POST /assistant/confirm is the one path that writes: it checks the
   card's token (signed for this person, this action and exactly these
   arguments, for 30 minutes), re-checks the permission and executes.

   Every tool call, proposal and confirmation is written to the school's
   audit_log with who, which tool and the arguments. */

const MAX_ROUNDS = 5
const MAX_CALLS_PER_ROUND = 6
const TOKEN_TTL_MS = 30 * 60 * 1000

// --- the prompt ---------------------------------------------------------------------------------
const DATA_RULES = `You CAN look up this school's live records, through the tools you are
given, and only through them. Every tool runs as the person asking, so it
answers only with what they are allowed to see: a teacher's own sections, a
parent's own children. When a tool says "not permitted" or "not found", tell
the person plainly that you cannot see that for them; never guess around it,
and never invent a figure, a name or a record. Use a tool whenever the
question is about particular students, classes, attendance, fees, exams,
staff, leave, the timetable, admissions or notices.

The chat already draws each tool's answer as a table next to your reply, so
summarise: the headline number, the few names that matter, what to do next.
Do not repeat the whole table.

To CHANGE anything, call the matching propose_ function. It does not make the
change: it prepares a card the person must confirm. So never say a change is
done; say it is ready to confirm on the card. One change per reply. If a
proposal is refused, say why in one sentence.
`

function agentPrompt(roles: string[]): string {
  let base = SYSTEM_PROMPT
  const i = base.indexOf('You have no access to school records')
  if (i >= 0) {
    const j = base.indexOf('\n\n', i)
    base = base.slice(0, i) + DATA_RULES + (j >= 0 ? base.slice(j) : '')
  } else {
    base += '\n\n' + DATA_RULES
  }
  // The import paragraph tells the model not to emit an action line; with tools there is none to emit.
  return `${base}\n\nToday is ${indiaToday()} (India).\n\n${assistantGrounding(roles)}`
}

// --- declarations -------------------------------------------------------------------------------
type Schema = { type: string; description?: string; enum?: string[]; items?: { type: string }; properties?: Record<string, Schema>; required?: string[] }
function declare(name: string, description: string, params: Record<string, Schema>, required: string[] = []) {
  const d: { name: string; description: string; parameters?: Schema } = { name, description }
  if (Object.keys(params).length) d.parameters = { type: 'OBJECT', properties: params, ...(required.length ? { required } : {}) }
  return d
}
export function declarations(tools: ToolSpec[], actions: AgentAction[]) {
  return [
    ...tools.map((t) => declare(t.name, t.description, t.params, t.required)),
    ...actions.map((a) => declare(proposeName(a.kind), 'PROPOSE (not perform) this change, for the person to confirm: ' + a.description, a.params, a.required)),
  ]
}

// --- confirmation tokens -----------------------------------------------------------------------
async function hmac(c: Ctx, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('assistant-confirm:' + (c.env.PASSWORD_PEPPER ?? '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const signed = (c: Ctx, kind: string, params: unknown, exp: number) =>
  hmac(c, `${c.id.institution?.id ?? ''}|${c.id.userId}|${kind}|${exp}|${JSON.stringify(params)}`)
export async function signProposal(c: Ctx, kind: string, params: unknown): Promise<string> {
  const exp = Date.now() + TOKEN_TTL_MS
  return `${exp}.${await signed(c, kind, params, exp)}`
}
async function checkToken(c: Ctx, kind: string, params: unknown, token: unknown): Promise<void> {
  const [expS, sig] = typeof token === 'string' ? token.split('.') : []
  const exp = Number(expS)
  if (!sig || !Number.isFinite(exp)) throw new HttpError(400, 'this change was not prepared by the assistant; ask for it again', { code: 'no_proposal' })
  if (exp < Date.now()) throw new HttpError(409, 'this card has expired; ask the assistant again for a fresh one', { code: 'proposal_expired' })
  if (sig !== await signed(c, kind, params, exp)) throw new HttpError(400, 'this change is not the one that was shown; ask the assistant again', { code: 'proposal_mismatch' })
}

// --- audit ----------------------------------------------------------------------------------------
async function audit(c: Ctx, action: string, detail: Record<string, unknown>): Promise<void> {
  try { await auditStmt(c, action, 'assistant', null, null, detail).run() } catch (e) { console.error('assistant audit', e) }
}

// --- the conversation, as Gemini contents ---------------------------------------------------------
type Part = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: unknown; thoughtSignature?: string; thought?: boolean }
type Content = { role: 'user' | 'model'; parts: Part[] }
const MAX_THREADS = 500, MAX_TURNS = 12, THREAD_TTL = 2 * 60 * 60 * 1000
const threads = new Map<string, { turns: Content[]; seen: number; user: string }>()
function loadThread(id: string, user: string): Content[] {
  const t = threads.get(id)
  if (!t || t.user !== user || Date.now() - t.seen > THREAD_TTL) return []
  return [...t.turns]
}
function saveThread(id: string, user: string, turns: Content[]): void {
  if (turns.length > MAX_TURNS) turns = turns.slice(turns.length - MAX_TURNS)
  threads.delete(id)
  threads.set(id, { turns, seen: Date.now(), user })
  if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value as string)
}

type Emit = (o: Record<string, unknown>) => void

/** runAgent: the model, its tool calls, and at most one proposal, reported through emit. */
export async function runAgent(c: Ctx, message: string, conversationId: string, emit: Emit): Promise<void> {
  const roles = await assistantRoles(c)
  const tools = READ_TOOLS.filter((t) => t.offer(c))
  const actions = AGENT_ACTIONS.filter((a) => mayPropose(c, a))
  const history = loadThread(conversationId, c.id.userId)
  const contents: Content[] = [...history, { role: 'user', parts: [{ text: message }] }]
  const system = agentPrompt(roles)
  const decls = declarations(tools, actions)
  const links: Link[] = []
  let proposed = false
  let text = ''
  let seq = 0

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const payload: Record<string, unknown> = {
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: 2048, temperature: 0.2 },
    }
    // The last round has no tools, so it must answer in words.
    if (decls.length && round < MAX_ROUNDS - 1) {
      payload.tools = [{ functionDeclarations: decls }]
      payload.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
    }
    const out = await geminiRequest(c, payload, 60_000) as { candidates?: { content?: { parts?: Part[] } }[] }
    const parts = out.candidates?.[0]?.content?.parts ?? []
    const calls = parts.filter((p) => p.functionCall)
    if (calls.length === 0) {
      text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim()
      break
    }
    contents.push({ role: 'model', parts })
    const responses: Part[] = []
    for (const call of calls.slice(0, MAX_CALLS_PER_ROUND)) {
      const name = call.functionCall!.name
      const args = call.functionCall!.args && typeof call.functionCall!.args === 'object' ? call.functionCall!.args : {}
      let result: unknown
      if (name.startsWith('propose_')) {
        result = await propose(c, name, args, proposed, emit, ++seq)
        if ((result as { proposed?: boolean }).proposed) proposed = true
      } else {
        const tool = tools.find((t) => t.name === name)
        const id = ++seq
        await audit(c, 'assistant.tool', { tool: name, params: args })
        if (!tool) {
          result = { error: 'no such tool, or not available to this person' }
        } else {
          emit({ t: 'tool', id, name, label: tool.label })
          let r: ToolResult
          try { r = await tool.run(c, args) } catch (e) {
            if (!(e instanceof HttpError)) console.error('assistant tool', name, e)
            r = { data: { error: 'the lookup failed' }, error: 'the lookup failed' }
          }
          emit({ t: 'tool_done', id, name, ok: !r.error, ...(r.view ? { view: r.view } : {}), ...(r.links ? { links: r.links } : {}), ...(r.error ? { error: r.error } : {}) })
          for (const l of r.links ?? []) if (!links.some((x) => x.to === l.to)) links.push(l)
          result = r.data
        }
      }
      responses.push({ functionResponse: { name, response: { result } } })
    }
    for (const call of calls.slice(MAX_CALLS_PER_ROUND)) {
      responses.push({ functionResponse: { name: call.functionCall!.name, response: { result: { error: 'too many lookups at once; ask again' } } } })
    }
    contents.push({ role: 'user', parts: responses })
  }

  if (text === '') text = proposed ? 'Ready: check the card and press Confirm to make the change.' : 'I could not answer that one. Try asking it a different way.'
  emit({ t: 'answer', text, links: links.slice(0, 6) })
  saveThread(conversationId, c.id.userId, [...history, { role: 'user', parts: [{ text: message }] }, { role: 'model', parts: [{ text }] }])
}

async function propose(c: Ctx, fn: string, args: Record<string, unknown>, already: boolean, emit: Emit, id: number): Promise<Record<string, unknown>> {
  const action = AGENT_ACTIONS.find((a) => proposeName(a.kind) === fn)
  await audit(c, 'assistant.propose', { tool: fn, params: args })
  if (!action || !mayPropose(c, action)) return { error: 'this person may not make that change' }
  if (already) return { error: 'one change at a time: the first one is already on a card' }
  emit({ t: 'tool', id, name: fn, label: 'Preparing the change' })
  let p: AgentProposal
  try {
    p = await action.preview(c, args)
  } catch (e) {
    if (!(e instanceof ActionRefusal) && !(e instanceof HttpError)) console.error('assistant preview', e)
    const msg = refusalText(e)
    emit({ t: 'tool_done', id, name: fn, ok: false, error: msg })
    return { error: msg }
  }
  const token = await signProposal(c, p.kind, p.params)
  emit({ t: 'tool_done', id, name: fn, ok: true })
  emit({ t: 'action', action: { ...p, token } })
  return { proposed: true, summary: p.summary, note: 'Shown to the person as a card. NOTHING has changed until they press Confirm.' }
}

// --- routes ---------------------------------------------------------------------------------------
async function agentRoute(c: Ctx): Promise<Response> {
  await assistantRateLimit(c)
  if (!c.id.institution) throw new HttpError(400, 'the assistant needs a school in scope', { code: 'no_institution' })
  const req = await readJSON<{ message?: string; conversation_id?: string }>(c.req)
  const message = (req.message ?? '').trim().slice(0, 4000)
  if (message === '') throw badRequest('message is required')
  const conversationId = isUUID(req.conversation_id) ? req.conversation_id : crypto.randomUUID()

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const w = writable.getWriter()
  const enc = new TextEncoder()
  let chain: Promise<void> = Promise.resolve()
  const emit: Emit = (o) => { chain = chain.then(() => w.write(enc.encode(JSON.stringify(o) + '\n'))).catch(() => {}) }
  emit({ t: 'conv', conversation_id: conversationId })
  const work = (async () => {
    try {
      await runAgent(c, message, conversationId, emit)
    } catch (e) {
      const h = e instanceof HttpError ? e : assistantFailure(e)
      emit({ t: 'error', message: h.message, code: h.extra.code ?? 'assistant_failed', status: h.status })
    } finally {
      await chain
      await w.close().catch(() => {})
    }
  })()
  void work
  return new Response(readable, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}

async function confirmRoute(c: Ctx): Promise<Response> {
  await assistantRateLimit(c)
  const req = await readJSON<{ kind?: string; params?: Record<string, unknown>; token?: string }>(c.req)
  const action = actionByKind(req.kind ?? '')
  if (!action) throw badRequest('that action is not one the assistant can take')
  if (!mayPropose(c, action)) throw new HttpError(403, 'missing permission: ' + action.perms.join(' or '), { code: 'forbidden' })
  const params = req.params && typeof req.params === 'object' ? req.params : {}
  await checkToken(c, action.kind, params, req.token)
  let msg: string
  try {
    msg = await action.execute(c, params)
  } catch (e) {
    await audit(c, 'assistant.confirm.failed', { kind: action.kind, params, error: refusalText(e) })
    if (!(e instanceof ActionRefusal) && !(e instanceof HttpError)) { console.error('assistant confirm', e); throw e }
    throw new HttpError(422, e.message, { code: 'action_failed' })
  }
  await audit(c, 'assistant.confirm', { kind: action.kind, params, result: msg })
  return ok({ ok: true, message: msg })
}

export function registerAgent(r: Router): void {
  r.post('/assistant/agent', 'auth', agentRoute)
  r.post('/assistant/confirm', 'auth', confirmRoute)
}
