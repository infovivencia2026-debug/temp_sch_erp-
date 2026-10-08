/* A Code 128 barcode as inline SVG, for ID cards and library labels.

   Code set B only (printable ASCII), which is what an admission number or
   an employee code is. The widths table is the standard one: 107 symbols,
   each six bar-and-space widths over eleven modules, and the stop pattern
   over thirteen. The checksum is the weighted sum modulo 103. No library:
   the whole thing is forty lines and prints at any size. */

const WIDTHS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]
const START_B = 104
const STOP = 106

/** The bars of `text` as [x, width] pairs in module units, and the total width. */
export function code128(text: string): { bars: [number, number][]; width: number } {
  const clean = [...text].filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c <= 126 }).join('') || ' '
  const codes = [START_B, ...[...clean].map((ch) => ch.charCodeAt(0) - 32)]
  let sum = START_B
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i
  codes.push(sum % 103, STOP)
  const bars: [number, number][] = []
  let x = 0
  for (const code of codes) {
    const w = WIDTHS[code]
    for (let i = 0; i < w.length; i++) {
      const n = Number(w[i])
      if (i % 2 === 0) bars.push([x, n])
      x += n
    }
  }
  return { bars, width: x }
}

export function Barcode({ value, height = 28, className, label = true }: { value: string; height?: number; className?: string; label?: boolean }) {
  const { bars, width } = code128(value)
  const quiet = 10
  const total = width + quiet * 2
  return (
    <svg className={className} viewBox={`0 0 ${total} ${height + (label ? 10 : 0)}`} width="100%" height={height + (label ? 10 : 0)}
      preserveAspectRatio="xMidYMid meet" role="img" aria-label={`Barcode ${value}`} shapeRendering="crispEdges">
      <rect x="0" y="0" width={total} height={height + (label ? 10 : 0)} fill="#fff" />
      {bars.map(([x, w], i) => <rect key={i} x={x + quiet} y="0" width={w} height={height} fill="#000" />)}
      {label && <text x={total / 2} y={height + 8} textAnchor="middle" fontSize="8" fontFamily="ui-monospace, monospace" fill="#000">{value}</text>}
    </svg>
  )
}
