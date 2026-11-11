/* LATE LIST AS A PICTURE (owner, 2026-11-11): one JPEG for the day with
   everyone who punched in after 8:45 and everyone who has not punched in
   yet, each with S.No, name and time -- ready to share on WhatsApp. Drawn on
   a canvas, so no library is needed. */

interface Row { needs_login?: boolean; employee_code: string; full_name: string; check_in?: string; check_out?: string; status?: string }

const CUTOFF = '08:45'
/* Left off the picture (owner, 2026-11-11): management, not staff on the clock. */
const SKIP = ['sriram reddy', 'sri ram reddy', 'tejaswi', 'vignan']
const skipped = (n: string) => SKIP.some((x) => n.toLowerCase().replace(/\s+/g, ' ').includes(x))
const hm = (t?: string) => (t ?? '').slice(0, 5)

export function lateListJpeg(rows: Row[], onDate: string) {
  const live = rows.filter((r) => !r.needs_login && !skipped(r.full_name))
  const late = live.filter((r) => r.check_in && hm(r.check_in) > CUTOFF).sort((a, b) => hm(a.check_in).localeCompare(hm(b.check_in)))
  const absent = ['absent', 'leave', 'week_off', 'on_duty']
  const none = live.filter((r) => !r.check_in && !r.check_out && !absent.includes(r.status ?? '')).sort((a, b) => a.full_name.localeCompare(b.full_name))

  const W = 900, pad = 40, rowH = 44, headH = 50
  const H = 150 + (headH + 50 + Math.max(late.length, 1) * rowH) + (headH + 50 + Math.max(none.length, 1) * rowH) + 60
  const c = document.createElement('canvas')
  const k = 2
  c.width = W * k; c.height = H * k
  const g = c.getContext('2d')!
  g.scale(k, k)
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H)
  const font = (w: number, s: number) => `${w} ${s}px Inter, Segoe UI, Arial, sans-serif`
  const date = new Date(onDate + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  g.fillStyle = '#101828'; g.font = font(700, 28); g.fillText('Staff late & not punched in', pad, 62)
  g.fillStyle = '#667085'; g.font = font(500, 16); g.fillText(`${date} · after ${CUTOFF} AM`, pad, 92)
  let y = 130

  const section = (title: string, color: string, bg: string, list: Row[], time: (r: Row) => string, empty: string) => {
    g.fillStyle = bg; roundRect(g, pad, y, W - pad * 2, headH, 12); g.fill()
    g.fillStyle = color; g.font = font(700, 18); g.fillText(`${title} (${list.length})`, pad + 18, y + 32)
    y += headH + 10
    g.fillStyle = '#667085'; g.font = font(600, 14)
    g.fillText('S.No', pad + 18, y + 24); g.fillText('Name', pad + 100, y + 24); g.fillText('Time', W - pad - 140, y + 24)
    y += 40
    if (!list.length) { g.fillStyle = '#98a2b3'; g.font = font(500, 16); g.fillText(empty, pad + 18, y + 28); y += rowH }
    list.forEach((r, i) => {
      if (i % 2 === 0) { g.fillStyle = '#f9fafb'; g.fillRect(pad, y, W - pad * 2, rowH) }
      g.fillStyle = '#101828'; g.font = font(500, 17)
      g.fillText(String(i + 1), pad + 18, y + 29)
      g.fillText(fit(g, r.full_name, W - pad * 2 - 280), pad + 100, y + 29)
      g.fillStyle = color; g.font = font(700, 17); g.fillText(time(r), W - pad - 140, y + 29)
      y += rowH
    })
    y += 30
  }
  section('Punched in after 8:45', '#b54708', '#fffaeb', late, (r) => hm(r.check_in), 'Nobody was late.')
  section('Not punched in yet', '#b42318', '#fef3f2', none, () => 'Not in', 'Everyone has punched in.')

  const a = document.createElement('a')
  a.download = `Late list ${onDate}.jpg`
  a.href = c.toDataURL('image/jpeg', 0.92)
  a.click()
}

function fit(g: CanvasRenderingContext2D, s: string, max: number) {
  if (g.measureText(s).width <= max) return s
  while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1)
  return s + '…'
}
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath()
}
