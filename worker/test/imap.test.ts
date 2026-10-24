/* The IMAP reader and parsers of src/services/imap.ts, without a socket:
   bytes are fed in chunks split at awkward places. Run: npm run test:unit. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImapReader, parseFetch, parseList, parseSearch, parseUidValidity, quoted, sentFolder, tokens } from '../src/services/imap'

const enc = new TextEncoder()

/** A reader over `s`, handed out `size` bytes at a time. */
function reader(s: string | Uint8Array, size = 3): ImapReader {
  const all = typeof s === 'string' ? enc.encode(s) : s
  let at = 0
  return new ImapReader(async () => {
    if (at >= all.length) return null
    const c = all.slice(at, at + size)
    at += size
    return c
  })
}

test('lines split across chunks, CRLF split too', async () => {
  const r = reader('* OK ready\r\na1 OK done\r\n', 1)
  assert.equal((await r.response()).text, '* OK ready')
  assert.equal((await r.response()).text, 'a1 OK done')
  await assert.rejects(r.line(), /closed/)
})

test('a {n} literal is read as raw bytes, CRLF and 8-bit inside included', async () => {
  const body = new Uint8Array([...enc.encode('Subject: x\r\n\r\nline one\r\n'), 0xe9, 0xff, ...enc.encode(')\r\n')])
  const head = enc.encode(`* 3 FETCH (UID 41 FLAGS (\\Seen \\Answered) BODY[] {${body.length}}\r\n`)
  const tail = enc.encode(')\r\na4 OK fetched\r\n')
  const all = new Uint8Array(head.length + body.length + tail.length)
  all.set(head, 0); all.set(body, head.length); all.set(tail, head.length + body.length)
  for (const size of [1, 7, 4096]) {
    const r = reader(all, size)
    const res = await r.response()
    assert.equal(res.literals.length, 1)
    assert.deepEqual([...res.literals[0]], [...body])
    const m = parseFetch(res)!
    assert.equal(m.uid, 41)
    assert.deepEqual(m.flags, ['\\Seen', '\\Answered'])
    assert.deepEqual([...m.body], [...body])
    assert.equal((await r.response()).text, 'a4 OK fetched')
  }
})

test('FETCH items in another order, and a zero-length literal', async () => {
  const r = reader('* 1 FETCH (BODY[] {0}\r\n UID 7 FLAGS ())\r\n')
  const m = parseFetch(await r.response())!
  assert.equal(m.uid, 7)
  assert.equal(m.body.length, 0)
  assert.deepEqual(m.flags, [])
})

test('LIST: flags, delimiter, quoted and literal names', async () => {
  const r = reader('* LIST (\\HasNoChildren \\Sent) "." "INBOX.Sent"\r\n* LIST (\\HasNoChildren) "/" {10}\r\nSent Items\r\n* LIST (\\Noselect) NIL Archive\r\n')
  const a = parseList(await r.response())!, b = parseList(await r.response())!, c = parseList(await r.response())!
  assert.deepEqual(a, { flags: ['\\HasNoChildren', '\\Sent'], delimiter: '.', name: 'INBOX.Sent' })
  assert.equal(b.name, 'Sent Items')
  assert.equal(c.delimiter, null)
  assert.equal(c.name, 'Archive')
})

test('the Sent folder: \\Sent flag first, else a usual name', () => {
  const box = (name: string, ...flags: string[]) => ({ flags, delimiter: '.', name })
  assert.equal(sentFolder([box('INBOX'), box('Sent'), box('Outbox', '\\Sent')]), 'Outbox')
  assert.equal(sentFolder([box('INBOX'), box('INBOX.Sent')]), 'INBOX.Sent')
  assert.equal(sentFolder([box('INBOX'), box('Sent Items')]), 'Sent Items')
  assert.equal(sentFolder([box('INBOX'), box('Drafts')]), null)
})

test('SEARCH and UIDVALIDITY', () => {
  assert.deepEqual(parseSearch({ text: '* SEARCH 2 10 11', literals: [] }), [2, 10, 11])
  assert.deepEqual(parseSearch({ text: '* SEARCH', literals: [] }), [])
  assert.equal(parseSearch({ text: '* 4 EXISTS', literals: [] }), null)
  assert.equal(parseUidValidity({ text: '* OK [UIDVALIDITY 1700000001] UIDs valid', literals: [] }), 1700000001)
})

test('quoted strings escape quotes and backslashes; non-ASCII goes as a literal', () => {
  assert.equal(quoted('pa"ss\\word'), '"pa\\"ss\\\\word"')
  assert.equal(quoted('pässword'), null)
  const t = tokens({ text: '* X "a \\"b\\" c" NIL (x y)', literals: [] })
  assert.deepEqual(t, ['*', 'X', 'a "b" c', null, ['x', 'y']])
})
