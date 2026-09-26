import { connect } from 'cloudflare:sockets'
import type { Outbound } from './messaging'

/* smtpProvider.Send and rfc822 of internal/api/messaging.go over
   cloudflare:sockets. security: "tls" (implicit TLS, usually 465),
   "starttls" (usually 587), anything else plain. AUTH PLAIN when a username
   is set, exactly as net/smtp's PlainAuth. Cloudflare blocks outbound port 25,
   so a school pointing at :25 gets a connection error in message_log. */

export interface SMTPSettings {
  host: string; port: number; username: string; password: string
  fromAddress: string; fromName: string; security: string
}

const headerSafe = (v: string) => v.replace(/[\r\n]/g, ' ')

function dotStuffed(body: string): string {
  return body.replace(/\r\n/g, '\n').split('\n').map((l) => (l.startsWith('.') ? '.' + l : l) + '\r\n').join('')
}

/** RFC1123Z in India time: "Mon, 02 Jan 2006 15:04:05 +0530". */
function dateIST(): string {
  const d = new Date(Date.now() + 330 * 60_000)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${mons[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0530`
}

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export function rfc822(cfg: SMTPSettings, m: Outbound): string {
  let from = cfg.fromAddress
  if (cfg.fromName.trim()) from = `${headerSafe(cfg.fromName.trim())} <${cfg.fromAddress}>`
  let b = `From: ${from}\r\nTo: ${headerSafe(m.to)}\r\nSubject: ${headerSafe(m.subject)}\r\nDate: ${dateIST()}\r\nMIME-Version: 1.0\r\n`
  const atts = m.attachments ?? []
  if (atts.length === 0) return b + 'Content-Type: text/plain; charset=UTF-8\r\n\r\n' + dotStuffed(m.body)
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('')
  const boundary = 'erp-boundary-' + hex
  b += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`
  b += `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n` + dotStuffed(m.body)
  for (const a of atts) {
    const ct = a.content_type.trim() || 'application/octet-stream'
    b += `\r\n--${boundary}\r\nContent-Type: ${headerSafe(ct)}\r\nContent-Transfer-Encoding: base64\r\n`
    b += `Content-Disposition: attachment; filename=${JSON.stringify(headerSafe(a.filename))}\r\n\r\n`
    const enc = b64(a.data)
    for (let i = 0; i < enc.length; i += 76) b += enc.slice(i, i + 76) + '\r\n'
  }
  return b + `--${boundary}--\r\n`
}

class Conn {
  private buf = ''
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private dec = new TextDecoder()
  private enc = new TextEncoder()
  constructor(public sock: Socket) {
    this.reader = sock.readable.getReader()
    this.writer = sock.writable.getWriter()
  }
  release() { this.reader.releaseLock(); this.writer.releaseLock() }
  async write(s: string) { await this.writer.write(this.enc.encode(s)) }
  /** One reply, multi-line aware: [code, text]. */
  async reply(): Promise<[number, string]> {
    const lines: string[] = []
    for (;;) {
      let i: number
      while ((i = this.buf.indexOf('\r\n')) < 0) {
        const { value, done } = await this.reader.read()
        if (done) throw new Error('smtp: connection closed by server')
        this.buf += this.dec.decode(value, { stream: true })
      }
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 2)
      lines.push(line.slice(4))
      if (line.length < 4 || line[3] !== '-') return [Number(line.slice(0, 3)), lines.join('\n')]
    }
  }
  async cmd(s: string, want: number[], what: string): Promise<string> {
    await this.write(s + '\r\n')
    const [code, text] = await this.reply()
    if (!want.includes(code)) throw new Error(`${what}: ${code} ${text}`)
    return text
  }
}

export async function sendSMTP(cfg: SMTPSettings, m: Outbound): Promise<void> {
  const sec = cfg.security.trim().toLowerCase()
  const sock = connect({ hostname: cfg.host, port: cfg.port },
    { secureTransport: sec === 'tls' ? 'on' : sec === 'starttls' ? 'starttls' : 'off', allowHalfOpen: false })
  let timer: number | undefined
  const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`dial ${cfg.host}:${cfg.port}: i/o timeout`)), 30_000) })
  const run = async () => {
    let c = new Conn(sock)
    const [code, text] = await c.reply()
    if (code !== 220) throw new Error(`${code} ${text}`)
    await c.cmd('EHLO localhost', [250], 'ehlo')
    if (sec === 'starttls') {
      await c.cmd('STARTTLS', [220], 'starttls')
      c.release()
      c = new Conn(sock.startTls({ expectedServerHostname: cfg.host }))
      await c.cmd('EHLO localhost', [250], 'ehlo')
    }
    if (cfg.username !== '') {
      const plain = b64(new TextEncoder().encode(`\u0000${cfg.username}\u0000${cfg.password}`))
      await c.cmd('AUTH PLAIN ' + plain, [235], 'auth')
    }
    await c.cmd(`MAIL FROM:<${cfg.fromAddress}>`, [250], 'from')
    await c.cmd(`RCPT TO:<${m.to}>`, [250, 251], `rcpt ${m.to}`)
    await c.cmd('DATA', [354], 'data')
    await c.write(rfc822(cfg, m) + '.\r\n')
    const [dc, dt] = await c.reply()
    if (dc !== 250) throw new Error(`${dc} ${dt}`)
    try { await c.cmd('QUIT', [221], 'quit') } catch { /* as Go: _ = c.Quit() */ }
  }
  try {
    await Promise.race([run(), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try { await sock.close() } catch { /* closed */ }
  }
}
