import { dial } from './dial'

/* A small IMAP4rev1 client (RFC 3501) over cloudflare:sockets with implicit
   TLS, enough to copy a mailbox once: LOGIN, LIST, SELECT, UID SEARCH ALL,
   UID FETCH (UID FLAGS BODY.PEEK[]) one message at a time, LOGOUT.

   The reader works on bytes, not text: a {n} literal is n raw bytes, and a
   message body is any 8-bit content. Error messages carry the server's reply
   to a command, never the command itself, so a password is never in one. */

export interface ImapResponse { text: string; literals: Uint8Array[] }
export type ImapToken = string | Uint8Array | null | ImapToken[]
export interface ImapMailbox { flags: string[]; delimiter: string | null; name: string }
export interface ImapMessage { uid: number; flags: string[]; body: Uint8Array }

/** A refusal from the server (NO / BAD), as opposed to a broken connection. */
export class ImapRefused extends Error {}

const CR = 13, LF = 10
const dec = new TextDecoder()
const enc = new TextEncoder()

/** Reads lines and literals from a byte source that may split anywhere. */
export class ImapReader {
  private buf = new Uint8Array(0)
  constructor(private next: () => Promise<Uint8Array | null>) {}

  private async fill(): Promise<void> {
    const chunk = await this.next()
    if (!chunk) throw new Error('imap: connection closed by server')
    const b = new Uint8Array(this.buf.length + chunk.length)
    b.set(this.buf, 0); b.set(chunk, this.buf.length)
    this.buf = b
  }

  async line(): Promise<string> {
    let from = 0
    for (;;) {
      for (let i = from; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === CR && this.buf[i + 1] === LF) {
          const s = dec.decode(this.buf.subarray(0, i))
          this.buf = this.buf.slice(i + 2)
          return s
        }
      }
      from = Math.max(0, this.buf.length - 1)
      await this.fill()
    }
  }

  async bytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.fill()
    const out = this.buf.slice(0, n)
    this.buf = this.buf.slice(n)
    return out
  }

  /** One whole response: its lines joined, each {n} literal read and kept in order. */
  async response(): Promise<ImapResponse> {
    let text = ''
    const literals: Uint8Array[] = []
    for (;;) {
      const l = await this.line()
      text += l
      const m = /\{(\d+)\+?\}$/.exec(l)
      if (!m) return { text, literals }
      literals.push(await this.bytes(Number(m[1])))
    }
  }
}

/** The tokens of a response: atoms and quoted strings as strings, NIL as null,
    (lists) as arrays, {n} literals as their bytes. */
export function tokens(r: ImapResponse): ImapToken[] {
  const s = r.text
  let i = 0, lit = 0
  const stack: ImapToken[][] = [[]]
  const push = (t: ImapToken) => stack[stack.length - 1].push(t)
  while (i < s.length) {
    const ch = s[i]
    if (ch === ' ') { i++; continue }
    if (ch === '(') { const l: ImapToken[] = []; push(l); stack.push(l); i++; continue }
    if (ch === ')') { if (stack.length > 1) stack.pop(); i++; continue }
    if (ch === '"') {
      let out = ''
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) i++
        out += s[i++]
      }
      i++
      push(out)
      continue
    }
    const lm = /^\{(\d+)\+?\}/.exec(s.slice(i))
    if (lm) { push(r.literals[lit++] ?? new Uint8Array(0)); i += lm[0].length; continue }
    let j = i
    while (j < s.length && s[j] !== ' ' && s[j] !== '(' && s[j] !== ')') {
      if (s[j] === '[') { const k = s.indexOf(']', j); j = k < 0 ? s.length : k + 1 } else j++
    }
    const atom = s.slice(i, j)
    push(atom.toUpperCase() === 'NIL' ? null : atom)
    i = j
  }
  return stack[0]
}

const str = (t: ImapToken | undefined): string => (typeof t === 'string' ? t : t instanceof Uint8Array ? dec.decode(t) : '')

/** "* LIST (\HasNoChildren \Sent) "." "INBOX.Sent"" */
export function parseList(r: ImapResponse): ImapMailbox | null {
  const t = tokens(r)
  if (t[0] !== '*' || str(t[1]).toUpperCase() !== 'LIST' || !Array.isArray(t[2])) return null
  return { flags: t[2].map(str), delimiter: t[3] === null ? null : str(t[3]), name: str(t[4]) }
}

/** "* SEARCH 4 9 12" (or "* SEARCH" for none). */
export function parseSearch(r: ImapResponse): number[] | null {
  const m = /^\* SEARCH(?: (.*))?$/i.exec(r.text)
  if (!m) return null
  return (m[1] ?? '').split(' ').map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

export function parseUidValidity(r: ImapResponse): number | null {
  const m = /\[UIDVALIDITY (\d+)\]/i.exec(r.text)
  return m ? Number(m[1]) : null
}

/** "* 5 FETCH (UID 34 FLAGS (\Seen) BODY[] {n}...)", items in any order. */
export function parseFetch(r: ImapResponse): ImapMessage | null {
  const t = tokens(r)
  if (t[0] !== '*' || str(t[2]).toUpperCase() !== 'FETCH' || !Array.isArray(t[3])) return null
  const items = t[3]
  let uid = 0, flags: string[] = [], body: Uint8Array | null = null
  for (let i = 0; i + 1 < items.length; i += 2) {
    const k = str(items[i]).toUpperCase(), v = items[i + 1]
    if (k === 'UID') uid = Number(str(v))
    else if (k === 'FLAGS' && Array.isArray(v)) flags = v.map(str)
    else if (k.startsWith('BODY[')) body = v instanceof Uint8Array ? v : enc.encode(str(v))
  }
  return uid > 0 && body ? { uid, flags, body } : null
}

/** The Sent folder: the one flagged \Sent, else a usual name. */
export function sentFolder(boxes: ImapMailbox[]): string | null {
  const flagged = boxes.find((b) => b.flags.some((f) => f.toLowerCase() === '\\sent'))
  if (flagged) return flagged.name
  for (const want of ['sent', 'inbox.sent', 'inbox/sent', 'sent items', 'sent messages', 'inbox.sent items', 'inbox.sent messages']) {
    const b = boxes.find((x) => x.name.toLowerCase() === want)
    if (b) return b.name
  }
  return null
}

/** A string argument: quoted when plain ASCII, else null (send it as a literal). */
export function quoted(s: string): string | null {
  if (!/^[\x20-\x7e]*$/.test(s)) return null
  return '"' + s.replace(/(["\\])/g, '\\$1') + '"'
}

export interface ImapServer { host: string; port: number }

export class Imap {
  private n = 0
  private constructor(private sock: Socket, private r: ImapReader, private w: WritableStreamDefaultWriter<Uint8Array>) {}

  /** Connects with implicit TLS and reads the greeting. */
  static async open(server: ImapServer, timeoutMs = 30_000): Promise<Imap> {
    const sock = dial({ hostname: server.host, port: server.port }, { secureTransport: 'on', allowHalfOpen: false })
    const reader = sock.readable.getReader()
    const next = async () => {
      let timer: number | undefined
      const late = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`imap ${server.host}:${server.port}: no answer in ${timeoutMs / 1000}s`)), timeoutMs) })
      try {
        const { value, done } = await Promise.race([reader.read(), late])
        return done ? null : value
      } finally { if (timer !== undefined) clearTimeout(timer) }
    }
    const c = new Imap(sock, new ImapReader(next), sock.writable.getWriter())
    try {
      const hello = await c.r.response()
      if (!/^\* (OK|PREAUTH)\b/i.test(hello.text)) throw new Error('imap: the server did not greet: ' + hello.text.slice(0, 200))
    } catch (e) { await c.close(); throw e }
    return c
  }

  /** Sends one command, made of text and string arguments (each quoted or a
      literal), and returns its untagged responses. */
  async command(parts: (string | { arg: string })[], what: string): Promise<ImapResponse[]> {
    const tag = 'a' + (++this.n)
    let line = tag
    for (const p of parts) {
      if (typeof p === 'string') { line += ' ' + p; continue }
      const q = quoted(p.arg)
      if (q !== null) { line += ' ' + q; continue }
      const bytes = enc.encode(p.arg)
      await this.w.write(enc.encode(`${line} {${bytes.length}}\r\n`))
      const go = await this.r.response()
      if (!go.text.startsWith('+')) throw new ImapRefused(`${what}: ${go.text.replace(/^\S+\s*/, '').slice(0, 300)}`)
      await this.w.write(bytes)
      line = ''
    }
    await this.w.write(enc.encode(line + '\r\n'))
    const out: ImapResponse[] = []
    for (;;) {
      const res = await this.r.response()
      if (res.text.startsWith(tag + ' ')) {
        const m = /^\S+ (OK|NO|BAD)\b ?(.*)$/i.exec(res.text)
        if (m && m[1].toUpperCase() === 'OK') return out
        throw new ImapRefused(`${what}: ${(m?.[2] ?? res.text).slice(0, 300)}`)
      }
      out.push(res)
    }
  }

  async login(user: string, password: string): Promise<void> {
    if (/[\r\n\0]/.test(user + password)) throw new ImapRefused('login: the name or password has a line break in it')
    await this.command(['LOGIN', { arg: user }, { arg: password }], 'login')
  }

  async list(): Promise<ImapMailbox[]> {
    return (await this.command(['LIST "" "*"'], 'list')).map(parseList).filter((x): x is ImapMailbox => x !== null)
  }

  async select(name: string): Promise<{ uidvalidity: number }> {
    const res = await this.command(['EXAMINE', { arg: name }], `open ${name}`)
    let uidvalidity = 0
    for (const r of res) uidvalidity = parseUidValidity(r) ?? uidvalidity
    return { uidvalidity }
  }

  async uids(): Promise<number[]> {
    const out: number[] = []
    for (const r of await this.command(['UID SEARCH ALL'], 'search')) out.push(...(parseSearch(r) ?? []))
    return out.sort((a, b) => a - b)
  }

  async fetch(uid: number): Promise<ImapMessage | null> {
    for (const r of await this.command([`UID FETCH ${uid} (UID FLAGS BODY.PEEK[])`], 'fetch')) {
      const m = parseFetch(r)
      if (m && m.uid === uid) return m
    }
    return null
  }

  async logout(): Promise<void> {
    try { await this.command(['LOGOUT'], 'logout') } catch { /* the server may hang up first */ }
    await this.close()
  }

  async close(): Promise<void> {
    try { await this.sock.close() } catch { /* closed */ }
  }
}
