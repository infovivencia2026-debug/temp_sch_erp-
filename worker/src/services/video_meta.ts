/* The length of an uploaded video, read from the file itself.

   MP4 and MOV (QuickTime) files are a tree of boxes ("atoms"): 4-byte big-endian
   size, 4-byte type, then the payload; size 1 means a 64-bit size follows, size
   0 means "to the end of the file". The movie header is moov > mvhd:
     version 0: ... timescale u32 at +12, duration u32 at +16
     version 1: ... timescale u32 at +20, duration u64 at +24
   and duration / timescale is the length in seconds. The moov box sits at the
   front of a "fast start" file and at the back of most phone recordings, so the
   whole buffer is walked, not just the first bytes. WebM (Matroska/EBML) has no
   such fixed header and is not parsed. Anything unreadable gives null and the
   caller falls back to what the client said. */

const fourcc = (b: DataView, at: number) => String.fromCharCode(b.getUint8(at), b.getUint8(at + 1), b.getUint8(at + 2), b.getUint8(at + 3))

/** Walks the boxes in [from, to), looking for `type` at this level; returns [payloadStart, payloadEnd] or null. */
function findBox(b: DataView, from: number, to: number, type: string): [number, number] | null {
  let at = from
  while (at + 8 <= to) {
    let size = b.getUint32(at)
    const kind = fourcc(b, at + 4)
    let head = 8
    if (size === 1) {
      if (at + 16 > to) return null
      const hi = b.getUint32(at + 8), lo = b.getUint32(at + 12)
      size = hi * 0x1_0000_0000 + lo
      head = 16
    } else if (size === 0) size = to - at
    if (size < head) return null // corrupt: would loop forever
    if (kind === type) return [at + head, Math.min(at + size, to)]
    at += size
  }
  return null
}

/** Seconds of an MP4/MOV, or null when the buffer is not one, or has no readable movie header. */
export function mp4DurationSeconds(buf: ArrayBuffer): number | null {
  if (buf.byteLength < 16) return null
  const b = new DataView(buf)
  // An ISO BMFF file opens with ftyp (or, in old QuickTime files, wide/mdat/moov).
  const first = fourcc(b, 4)
  if (!['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(first)) return null
  const moov = findBox(b, 0, buf.byteLength, 'moov')
  if (!moov) return null
  const mvhd = findBox(b, moov[0], moov[1], 'mvhd')
  if (!mvhd) return null
  const [p, end] = mvhd
  const version = b.getUint8(p)
  let timescale: number, duration: number
  if (version === 1) {
    if (p + 32 > end) return null
    timescale = b.getUint32(p + 20)
    duration = b.getUint32(p + 24) * 0x1_0000_0000 + b.getUint32(p + 28)
  } else {
    if (p + 20 > end) return null
    timescale = b.getUint32(p + 12)
    duration = b.getUint32(p + 16)
  }
  if (!timescale || !Number.isFinite(duration)) return null
  return duration / timescale
}

/** What the file says about its own length, by content type; null where the format is not parsed (WebM) or the file is unreadable. */
export function videoDurationSeconds(contentType: string, buf: ArrayBuffer): number | null {
  const ct = contentType.split(';')[0].trim().toLowerCase()
  if (ct === 'video/mp4' || ct === 'video/quicktime') return mp4DurationSeconds(buf)
  return null
}

/** Test helper: a minimal MP4 (ftyp + moov/mvhd + empty mdat) that claims `seconds` long. */
export function tinyMp4(seconds: number, version: 0 | 1 = 0): Uint8Array {
  const timescale = 1000
  const box = (type: string, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(8 + payload.length)
    new DataView(out.buffer).setUint32(0, out.length)
    out.set([...type].map((c) => c.charCodeAt(0)), 4)
    out.set(payload, 8)
    return out
  }
  const mvhdBody = new Uint8Array(version === 1 ? 108 : 96)
  const dv = new DataView(mvhdBody.buffer)
  dv.setUint8(0, version)
  if (version === 1) { dv.setUint32(20, timescale); dv.setUint32(24, 0); dv.setUint32(28, Math.round(seconds * timescale)) }
  else { dv.setUint32(12, timescale); dv.setUint32(16, Math.round(seconds * timescale)) }
  const ftyp = box('ftyp', new Uint8Array([...'isom'].map((c) => c.charCodeAt(0)).concat([0, 0, 2, 0], [...'isomiso2mp41'].map((c) => c.charCodeAt(0)))))
  const moov = box('moov', box('mvhd', mvhdBody))
  const mdat = box('mdat', new Uint8Array([1, 2, 3, 4]))
  const all = new Uint8Array(ftyp.length + mdat.length + moov.length)
  all.set(ftyp, 0); all.set(mdat, ftyp.length); all.set(moov, ftyp.length + mdat.length) // moov last, as phones write it
  return all
}
