/* QR code PNGs, the port of fees.UPIQRPNG (Go: skip2/go-qrcode).

   Same shape as the Go image: error correction M, a 4-module quiet zone,
   whole-pixel modules centred in a size x size square (the leftover pixels
   become extra white margin, as go-qrcode does), size clamped to 120..1024.
   The encoder is qrcode-generator (pure JS); the PNG is an 8-bit greyscale
   image deflated with CompressionStream('deflate'), which is the zlib
   format PNG wants, so no zlib port ships in the bundle. */
import qrcode from 'qrcode-generator'

const QUIET = 4

/** qrPNG renders text as a QR PNG, size pixels square. */
export async function qrPNG(text: string, size: number): Promise<Uint8Array> {
  size = Math.min(1024, Math.max(120, Math.floor(size) || 0))
  // qrcode-generator's byte mode keeps the low 8 bits of each UTF-16 unit;
  // hand it the UTF-8 bytes one per char so a Telugu payee name survives.
  const utf8 = new TextEncoder().encode(text)
  let bin = ''
  for (const b of utf8) bin += String.fromCharCode(b)
  const q = qrcode(0, 'M')
  q.addData(bin, 'Byte')
  q.make()
  const n = q.getModuleCount()
  const real = n + 2 * QUIET
  if (size < real) size = real
  const ppm = Math.floor(size / real)
  const off = Math.floor((size - real * ppm) / 2) + QUIET * ppm
  // Raw scanlines: filter byte 0, then one grey byte per pixel.
  const stride = size + 1
  const raw = new Uint8Array(stride * size).fill(255)
  for (let y = 0; y < size; y++) raw[y * stride] = 0
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!q.isDark(r, c)) continue
      for (let dy = 0; dy < ppm; dy++) {
        const row = (off + r * ppm + dy) * stride + 1 + off + c * ppm
        raw.fill(0, row, row + ppm)
      }
    }
  }
  const idat = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer())
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, size); dv.setUint32(4, size)
  ihdr[8] = 8; ihdr[9] = 0 // 8-bit greyscale; compression, filter, interlace 0
  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))])
}

/** qrDataURL is qrPNG as the data: URL the Go handlers returned. */
export async function qrDataURL(text: string, size: number): Promise<string> {
  const png = await qrPNG(text, size)
  let s = ''
  for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode(...png.subarray(i, i + 0x8000))
  return 'data:image/png;base64,' + btoa(s)
}

let crcTable: Uint32Array | null = null
function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[i] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
