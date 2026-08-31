import { useMemo } from 'react'
import { cn } from '@/lib/utils'

/* A REAL MAP, WITH THE STREETS ON IT.

   Every plot in this product drew coordinates on an empty ground and said so
   in words, because there was no basemap behind the product and a bare white
   rectangle implies a city that is not drawn. That is the right call when
   there is nothing to draw. It is the wrong answer to "where is the bus":
   a parent knows their own street, not a pair of decimal degrees, and two dots
   on grey tell them the bus is near the stop without telling them whether it
   has turned into their road yet.

   So this draws OpenStreetMap's own raster tiles, and nothing else changes.

   ---------------------------------------------------------------------------
   NO LIBRARY, AND THAT IS NOT MINIMALISM FOR ITS OWN SAKE

   Leaflet is 42kB and brings a stylesheet, a lifecycle to tear down, and its
   own idea of the DOM. A slippy map that does not pan is roughly forty lines
   of arithmetic that has not changed since 2005: project to Web Mercator,
   floor to a tile grid, lay the tiles out as images. Fewer moving parts than
   the wrapper would have been.

   ---------------------------------------------------------------------------
   WHAT THE READER SHOULD KNOW

   The tiles come from openstreetmap.org, so the browser showing this map asks
   a third party for the squares of the world it is looking at. That is a real
   disclosure and the reason the attribution below is not decoration: OSM's
   terms require it, and a parent is entitled to know their map came from
   somewhere else. Nothing about the child, the bus or the school is sent -- a
   tile request carries a zoom and two integers -- but the area being watched
   is implied by which tiles are asked for.

   A school with no internet route to OSM gets grey squares and the markers
   still land in the right places, which is the same information the old plot
   gave.
*/

const TILE = 256

export interface MapPoint {
  lat: number
  lon: number
  kind: 'bus' | 'stop' | 'passed' | 'ahead'
  label?: string
}

/** Web Mercator, in tile units at a given zoom. */
function project(lat: number, lon: number, zoom: number) {
  const n = 2 ** zoom
  const x = ((lon + 180) / 360) * n
  const rad = (lat * Math.PI) / 180
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  return { x, y }
}

/** The closest zoom that still fits every point in the box, capped at street
 *  level: past 17 the tiles are mostly white and the bus looks lost. */
function fitZoom(points: MapPoint[], w: number, h: number) {
  if (points.length < 2) return 15
  const lats = points.map((p) => p.lat)
  const lons = points.map((p) => p.lon)
  for (let z = 17; z >= 3; z--) {
    const a = project(Math.max(...lats), Math.min(...lons), z)
    const b = project(Math.min(...lats), Math.max(...lons), z)
    // A tenth of a tile of margin, so a marker on the edge is not half cut off.
    if ((b.x - a.x + 0.4) * TILE <= w && (b.y - a.y + 0.4) * TILE <= h) return z
  }
  return 3
}

export function TileMap({
  points,
  height = 260,
  className,
  ariaLabel,
}: {
  points: MapPoint[]
  height?: number
  className?: string
  ariaLabel?: string
}) {
  const width = 640 // the viewBox width; the element itself is fluid

  const view = useMemo(() => {
    const usable = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    if (usable.length === 0) return null
    const zoom = fitZoom(usable, width, height)
    const centreLat = (Math.min(...usable.map((p) => p.lat)) + Math.max(...usable.map((p) => p.lat))) / 2
    const centreLon = (Math.min(...usable.map((p) => p.lon)) + Math.max(...usable.map((p) => p.lon))) / 2
    const c = project(centreLat, centreLon, zoom)

    // Pixel of the top-left corner of the viewport, in world pixels.
    const originX = c.x * TILE - width / 2
    const originY = c.y * TILE - height / 2

    const first = { x: Math.floor(originX / TILE), y: Math.floor(originY / TILE) }
    const last = {
      x: Math.floor((originX + width) / TILE),
      y: Math.floor((originY + height) / TILE),
    }
    const n = 2 ** zoom
    const tiles: { key: string; x: number; y: number; left: number; top: number }[] = []
    for (let tx = first.x; tx <= last.x; tx++) {
      for (let ty = first.y; ty <= last.y; ty++) {
        // Wrap in x so a view crossing the date line still tiles; y has no
        // wrap, and a tile above the pole simply does not exist.
        if (ty < 0 || ty >= n) continue
        const wrapped = ((tx % n) + n) % n
        tiles.push({
          key: `${tx},${ty}`,
          x: wrapped,
          y: ty,
          left: tx * TILE - originX,
          top: ty * TILE - originY,
        })
      }
    }

    const place = (p: MapPoint) => {
      const q = project(p.lat, p.lon, zoom)
      return { x: q.x * TILE - originX, y: q.y * TILE - originY }
    }
    return { tiles, place, zoom }
  }, [points, height])

  if (!view) return null

  const stops = points.filter((p) => p.kind !== 'bus')
  const bus = points.find((p) => p.kind === 'bus')
  const path = stops.map((p) => view.place(p))

  return (
    <figure className={cn('m-0', className)}>
      <div
        className="relative overflow-hidden rounded-[8px] border bg-muted"
        style={{ height }}
        role="img"
        aria-label={ariaLabel ?? 'Map of the bus and its stops'}
      >
        {view.tiles.map((t) => (
          <img
            key={t.key}
            // The standard OSM tile URL. No subdomain rotation: HTTP/2 makes
            // it pointless and OSM asks people not to shard any more.
            src={`https://tile.openstreetmap.org/${view.zoom}/${t.x}/${t.y}.png`}
            alt=""
            aria-hidden
            width={TILE}
            height={TILE}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="absolute select-none"
            style={{ left: t.left, top: t.top }}
          />
        ))}

        {/* The markers ride above the tiles in one SVG, so the line between
            stops is drawn once rather than as a stack of positioned divs. */}
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          {path.length > 1 && (
            <polyline
              points={path.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke="rgba(17,24,39,0.55)"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {stops.map((p, i) => {
            const q = path[i]
            const passed = p.kind === 'passed'
            return (
              <circle
                key={`${p.lat},${p.lon},${i}`}
                cx={q.x}
                cy={q.y}
                r={5}
                fill={passed ? 'rgba(17,24,39,0.85)' : '#ffffff'}
                stroke="rgba(17,24,39,0.85)"
                strokeWidth={2}
              />
            )
          })}
          {bus &&
            (() => {
              const q = view.place(bus)
              return (
                <g>
                  {/* A halo, so the bus is findable on a busy tile without
                      being a bigger dot than the stops it sits between. */}
                  <circle cx={q.x} cy={q.y} r={11} fill="rgba(37,99,235,0.22)" />
                  <circle cx={q.x} cy={q.y} r={6} fill="#2563eb" stroke="#ffffff" strokeWidth={2} />
                </g>
              )
            })()}
        </svg>
      </div>

      {/* Required by OSM's tile usage policy, and fair on its own terms. */}
      <figcaption className="mt-1 text-[11px] text-muted-foreground">
        Map tiles from{' '}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer noopener"
          className="underline"
        >
          OpenStreetMap
        </a>
        . Loading them asks openstreetmap.org for this area.
      </figcaption>
    </figure>
  )
}
