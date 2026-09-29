/* Fallbacks for older engines, added at build time.

   The mobile apps run in Android WebView (Chrome 80-ish) and some parents
   are on iOS 14. Those engines drop a whole declaration they cannot parse,
   so a tint written with color-mix() or a height in dvh left the element
   with no background, no border or no height at all. For each such
   declaration this writes a plain one in front of it: modern browsers take
   the later, exact value; older ones keep the approximation.

   - color-mix(in <space>, A p%, transparent) -> A when p >= 50, otherwise a
     neutral grey at the same alpha (a tint stays a tint, a line stays a line).
   - color-mix(in <space>, A p%, B) -> whichever colour has the larger share.
   - dvh / svh / lvh -> vh.
   - A selector list that mixes :has() with plain selectors is split in two.
     An engine without :has() drops the WHOLE list, so `.cell-grid, .card:has(
     > .cell-grid)` used to lose the plain half as well. */
function splitArgs(s) {
  const out = []; let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  out.push(cur.trim()); return out
}
function mixFallback(args) {
  const [, a, b = ''] = splitArgs(args)
  const pa = a.match(/^(.*?)\s+([\d.]+)%$/), pb = b.match(/^(.*?)\s+([\d.]+)%$/)
  const ca = pa ? pa[1] : a, cb = pb ? pb[1] : b
  const p = pa ? +pa[2] : pb ? 100 - +pb[2] : 50
  if (/^transparent$/i.test(cb)) return p >= 50 ? ca : `rgba(128, 128, 128, ${(p / 100).toFixed(2)})`
  if (/^transparent$/i.test(ca)) return p <= 50 ? cb : `rgba(128, 128, 128, ${((100 - p) / 100).toFixed(2)})`
  return p >= 50 ? ca : cb
}
function replaceMix(value) {
  let i, guard = 0
  while ((i = value.indexOf('color-mix(')) !== -1 && guard++ < 50) {
    let depth = 0, j = i + 'color-mix'.length
    for (; j < value.length; j++) { if (value[j] === '(') depth++; else if (value[j] === ')') { depth--; if (depth === 0) break } }
    const inner = value.slice(i + 'color-mix('.length, j)
    const fb = mixFallback(inner.includes('color-mix(') ? replaceMix(inner) : inner)
    value = value.slice(0, i) + fb + value.slice(j + 1)
  }
  return value
}
import postcss from 'postcss'
const plugin = () => ({
  postcssPlugin: 'erp-fallbacks',
  Rule(r) {
    if (r.__split || !r.selector.includes(':has(')) return
    r.__split = true
    const parts = postcss.list.comma(r.selector)
    const plain = parts.filter((x) => !x.includes(':has(')), has = parts.filter((x) => x.includes(':has('))
    if (!plain.length || !has.length) return
    const c = r.cloneBefore({ selector: plain.join(',') }); c.__split = true
    r.selector = has.join(','); r.__split = true
  },
  Declaration(d) {
    if (d.prop.startsWith('--') || d.__fb || d.__done) return
    d.__done = true
    const prev = d.prev()
    if (prev && prev.type === 'decl' && prev.prop === d.prop && prev.__fb) return
    let v = d.value
    if (v.includes('color-mix(')) v = replaceMix(v)
    if (/\d(d|s|l)v[hw]\b/.test(v)) v = v.replace(/(\d)(d|s|l)v([hw])\b/g, '$1v$3')
    if (v !== d.value) { const c = d.cloneBefore({ value: v }); c.__fb = true; return }
  },
})
plugin.postcss = true
export default plugin
