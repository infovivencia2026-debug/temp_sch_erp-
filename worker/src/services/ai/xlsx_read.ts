/* A small .xlsx reader for the Worker, the counterpart of services/xlsx.ts:
   the ZIP central directory, stored or deflated entries (DecompressionStream
   'deflate-raw', built into workerd and Node), the shared-strings table and
   the first worksheet. Enough for the sheets schools actually send; formulas
   are read as their cached values, and a date cell comes back as its Excel
   serial number (the smart importer's normaliser turns serials into dates). */

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

export const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([data]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Every entry of a ZIP, by name (lazily inflated). */
export function unzip(b: Uint8Array): Map<string, () => Promise<Uint8Array>> {
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('not a readable .xlsx (no zip directory)')
  const count = u16(b, eocd + 10)
  let p = u32(b, eocd + 16)
  const out = new Map<string, () => Promise<Uint8Array>>()
  const dec = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('not a readable .xlsx (bad zip directory)')
    const method = u16(b, p + 10), csize = u32(b, p + 20), nameLen = u16(b, p + 28), extra = u16(b, p + 30), comment = u16(b, p + 32)
    const local = u32(b, p + 42)
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extra + comment
    out.set(name, async () => {
      const start = local + 30 + u16(b, local + 26) + u16(b, local + 28)
      const raw = b.subarray(start, start + csize)
      if (method === 0) return raw
      if (method === 8) return inflateRaw(raw)
      throw new Error('unsupported compression in .xlsx')
    })
  }
  return out
}

const unesc = (s: string) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-fA-F]+));/g, (_m, e: string, d?: string, h?: string) =>
  d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16)) : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[e])

/** Text of every <t> inside a fragment (rich text runs joined). */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join('')

export function colIndex(ref: string): number {
  let n = 0
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64)
  return n - 1
}

/** The first worksheet as rows of strings (ragged rows padded to the widest). */
export async function readXLSX(bytes: Uint8Array): Promise<{ sheet: string; rows: string[][] }> {
  const zip = unzip(bytes)
  const dec = new TextDecoder()
  const read = async (n: string) => { const f = zip.get(n); return f ? dec.decode(await f()) : null }
  const shared: string[] = []
  const ss = await read('xl/sharedStrings.xml')
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]))

  // The first sheet in workbook order, through its relationship id.
  let sheetPath = 'xl/worksheets/sheet1.xml', sheetName = 'Sheet1'
  const wb = await read('xl/workbook.xml'), rels = await read('xl/_rels/workbook.xml.rels')
  const first = wb?.match(/<sheet\b[^>]*>/)
  if (first) {
    sheetName = unesc(first[0].match(/name="([^"]*)"/)?.[1] ?? sheetName)
    const rid = first[0].match(/r:id="([^"]*)"/)?.[1]
    const target = rid && rels ? [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`Id="${rid}"`))?.match(/Target="([^"]*)"/)?.[1] : undefined
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '')
  }
  const xml = await read(sheetPath)
  if (xml === null) throw new Error('the workbook has no readable first sheet')

  const rows: string[][] = []
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rAttr = rm[1].match(/\br="(\d+)"/)
    const rowIdx = rAttr ? Number(rAttr[1]) - 1 : rows.length
    const row: string[] = []
    let next = 0
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] ?? ''
      const ref = attrs.match(/\br="([A-Z]+\d*)"/)?.[1]
      const ci = ref ? colIndex(ref) : next
      next = ci + 1
      const t = attrs.match(/\bt="([^"]*)"/)?.[1] ?? 'n'
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      let val = ''
      if (t === 's') val = v !== undefined ? shared[Number(v)] ?? '' : ''
      else if (t === 'inlineStr') val = textOf(body)
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE'
      else val = v !== undefined ? unesc(v) : ''
      row[ci] = val
    }
    while (rows.length < rowIdx) rows.push([])
    rows[rowIdx] = Array.from(row, (x) => x ?? '')
  }
  const width = Math.max(0, ...rows.map((r) => r.length))
  return { sheet: sheetName, rows: rows.map((r) => { const o = r.slice(); while (o.length < width) o.push(''); return o }) }
}
