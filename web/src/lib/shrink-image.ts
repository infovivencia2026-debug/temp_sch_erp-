/* A PHONE PHOTOGRAPH IS NOT A DOCUMENT.
 *
 * A modern handset takes a 4MB picture. On a school's connection that is most
 * of a minute of waiting, for something that will be looked at in a bubble
 * 280px wide, on an ID card, or as a thumbnail in a list. Anything over 1600px
 * on its long edge is drawn into a canvas at 1600 and re-encoded as JPEG at
 * 0.82 -- typically 4MB down to under 400KB, and indistinguishable at the size
 * it is ever read.
 *
 * WHAT IS LEFT ALONE, AND WHY. A PDF, a document, a voice note: re-encoding
 * them destroys them. A GIF: it would lose its animation. Anything already
 * small: there is nothing to gain and a re-encode only loses quality. And if
 * the browser cannot do any of it -- no createImageBitmap, no canvas, a codec
 * it will not decode -- the original is returned, so this can make an upload
 * faster but never make one fail.
 *
 * Lives here rather than in the chat, where it started, because "the photo
 * takes a minute to upload" is not a fact about messaging: it is as true of a
 * student photograph, a staff record, a circular's attachment and a document
 * against an admission.
 */
export async function shrinkImage(f: File, max = 1600, quality = 0.82): Promise<File> {
  if (!f.type.startsWith('image/') || f.type === 'image/gif' || f.size < 600_000) return f
  try {
    if (typeof createImageBitmap !== 'function') return f
    const bitmap = await createImageBitmap(f)
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
    // Already small enough in both dimensions and not enormous on disk: the
    // re-encode would cost quality and save nothing worth having.
    if (scale === 1 && f.size < 1_500_000) {
      bitmap.close?.()
      return f
    }
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close?.()
      return f
    }
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality))
    // Bigger than what we started with happens with a small PNG of flat
    // colour; keep whichever is smaller.
    if (!blob || blob.size >= f.size) return f
    return new File([blob], f.name.replace(/\.(png|webp|heic|heif|jpeg|jpg|bmp)$/i, '') + '.jpg', {
      type: 'image/jpeg',
      lastModified: f.lastModified,
    })
  } catch {
    return f
  }
}
