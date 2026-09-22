import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, { type LngLatBoundsLike, type Map as MLMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Protocol } from 'pmtiles'
import { layers, namedFlavor } from '@protomaps/basemaps'
import { Maximize2, Minimize2, Crosshair, ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/lib/theme'

/* The street map the fleet screens never had.

   Until now every transport screen drew a bare coordinate plot and said so in
   words, because there was no basemap behind this product: a bus was a dot at
   a scale bar's distance from another dot, and answering "which road is it
   on" meant knowing the route by heart. That is the whole question a parent
   and a transport office ask, so the plot could not answer either of them.

   WHAT THIS KEEPS. The plot got the important thing right and it is carried
   over unchanged: a stale fix must never read as a moving bus. State is drawn
   in shape as well as colour — a stale marker is hollow, dashed, and labelled
   with its own age — so it survives a colour-blind reader, a black and white
   printout, and the projector in the transport office. Callers pass the state
   they already computed with drift applied; this component does not decide
   freshness and cannot disagree with the table beside it.

   WHERE THE TILES COME FROM. The map we host ourselves.

   OpenFreeMap served this before: OpenStreetMap without an account, a key or
   a quota, and somebody else's server with no promise attached, which saw
   the viewport and so roughly where the school and its buses are. The
   replacement is one file: a PMTiles archive of the region (Andhra Pradesh
   and Telangana, cut from the daily Protomaps build of OpenStreetMap by
   scripts/refresh-tiles.sh), served as a static file with range requests
   from the ERP's own nginx under /tiles/, with the fonts and sprites the
   style needs beside it. No third party sees where the buses are, nothing
   can be revoked, and the hosting cost is a 200MB file on a disk that has
   room for it. On a host with no disk (Cloud Run) the same file and assets
   sit in the R2 bucket under tiles/, and the R2 public host goes in
   VITE_TILES_BASE at build time (web/.env.production), e.g.
   https://<R2_PUBLIC_HOST>/tiles; unset, TILES_BASE stays the nginx path
   /tiles. Nothing else in this file knows which of the two it is.

   It went to the iPhone parent app first, gated on the shell's bridge, and
   was watched there: the archive, the sprites and the fonts all answered
   with range support from the box. The gate is gone and every client, the
   office's screens, the Android parent app and the browser, draws the same
   map from the same file. The tiles-failed notice below still says so when
   the file is not being served, which is now the only way this can fail.

   The style is built in code from the Protomaps basemap layers rather than
   fetched as JSON, because the layer list has to name this origin's tile
   source and asset paths, and a style file with those baked in would be one
   more thing to regenerate on every deploy. */
const TILES_BASE = (
  (import.meta as { env?: Record<string, string> }).env?.VITE_TILES_BASE || '/tiles'
).replace(/\/+$/, '')
// Glyph and sprite URLs must be absolute for MapLibre. A relative base is
// this origin's; an R2 host is already absolute and must not be prefixed.
const TILES_ORIGIN = /^https?:\/\//i.test(TILES_BASE) ? '' : window.location.origin
const TILES_ARCHIVE = `${TILES_BASE}/south-india.pmtiles`

let pmtilesRegistered = false
/* The Protomaps flavours this product draws. 'light' is the office's full
   colour street map. The two guidance flavours are the same tiles with the
   colour taken out -- grey roads on a pale ground, or on a near-black one --
   so that the one thing drawn in colour, the route, is the thing the eye
   goes to. That is the whole idea of the navigation treatment: restrained
   map detail and a single accent. */
export type MapFlavor = 'light' | 'grayscale' | 'black'

export function selfHostedStyle(flavor: MapFlavor = 'light'): maplibregl.StyleSpecification {
  if (!pmtilesRegistered) {
    // One protocol handler per page; MapLibre keeps it globally.
    maplibregl.addProtocol('pmtiles', new Protocol().tile)
    pmtilesRegistered = true
  }
  return {
    version: 8,
    glyphs: `${TILES_ORIGIN}${TILES_BASE}/assets/fonts/{fontstack}/{range}.pbf`,
    // The basemaps-assets bundle ships both sprite sets and
    // scripts/refresh-tiles.sh unpacks both; a dark ground needs the dark
    // icons or every landmark glyph is a black dot on black.
    sprite: `${TILES_ORIGIN}${TILES_BASE}/assets/sprites/v4/${flavor === 'black' ? 'dark' : 'light'}`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${TILES_ARCHIVE}`,
        attribution:
          '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layers('protomaps', namedFlavor(flavor), { lang: 'en' }),
  }
}

/* THE NAVIGATION TREATMENT.

   `tone="guidance"` is the owner's navigation design brought to the map: a
   quiet grey basemap in the viewer's theme, the run drawn through its stops
   as one teal line with a soft glow, stops as small rings, the parent's own
   stop filled in the accent. Everything else on the map is a shade of grey.
   The default tone is the office's full-colour map, unchanged. */
export type MapTone = 'default' | 'guidance'

const GUIDANCE = {
  light: { accent: '#18bca6', ring: '#14171b', panel: '#f8f9fb', ink: '#14171b', halo: '#f8f9fb' },
  dark: { accent: '#16d1bb', ring: '#f5f7fa', panel: '#121315', ink: '#f5f7fa', halo: '#121315' },
} as const

export interface MapVehicle {
  id: string
  /** The registration, drawn under the marker — what the office says out loud. */
  label: string
  latitude: number
  longitude: number
  heading_deg?: number
  state: 'running' | 'stale' | 'idle'
  /** Age, or anything else worth a second line. Drawn only when stale. */
  note?: string
}

export interface MapStop {
  id: string
  name: string
  latitude: number
  longitude: number
  geofence_m?: number
  /** The stop the viewer cares about: the parent's own, drawn larger and in colour. */
  mine?: boolean
}

export interface MapLink {
  from: { latitude: number; longitude: number }
  to: { latitude: number; longitude: number }
  /** Drawn along the line — the straight-line distance, usually. */
  label?: string
}

interface Props {
  vehicles: MapVehicle[]
  stops?: MapStop[]
  /* The straight line between a bus and the stop it is coming to, with the
     distance on it. The parent screen is answering one question — how far —
     and the number has to sit on the thing it measures, not in a legend. */
  link?: MapLink | null
  /* Each run, as a line through its stops in order ([lng, lat] pairs). Not the
     road — the road is not known — but the shape of the journey, drawn in the
     accent so the eye follows it. One line for a parent's bus, one per route
     for the office. Only drawn in the guidance tone. */
  routes?: [number, number][][]
  tone?: MapTone
  /** Lifts one marker above the rest; wired to a hovered table row. */
  focusId?: string | null
  onFocus?: (id: string | null) => void
  className?: string
  /** What to say when there is nothing with coordinates to draw. */
  empty?: React.ReactNode
  /** How long a marker takes to travel from its last fix to a new one. 0 jumps. */
  glideMs?: number
}

/* THE CREDIT IS ONE TAP AWAY, NOT ACROSS THE MAP.

   MapLibre's compact attribution opens itself on any map narrower than 640px,
   which is every phone, so "Protomaps © OpenStreetMap" sat in a white bar
   across the bottom of the parent's map on top of the stops. The data is
   OpenStreetMap's and its licence asks that the credit be reachable, not
   that it be permanently on screen: the control stays, folded to its ⓘ
   button, and a tap opens it. Removing the control altogether would put
   every school on this installation in breach of the map's licence. */
export function collapseAttribution(m: maplibregl.Map) {
  m.getContainer()
    .querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show')
    .forEach((el) => el.classList.remove('maplibregl-compact-show'))
}

/** Metres between two points, close enough for a bus on a road. */
function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 110574
  const dLon = (lon2 - lon1) * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180))
  return Math.hypot(dLat, dLon)
}

/** Direction of travel from one point to the next, degrees clockwise from north. */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad)
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad)
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360
}

/* A circle on the ground, as a polygon.

   A geofence is a radius in metres and has to stay that radius through every
   zoom. Drawn as a fixed pixel circle it would swell to cover the district as
   the office zoomed out, which is the map telling a lie about where a bus
   counts as arrived. */
function circleOnGround(lat: number, lon: number, metres: number, steps = 48) {
  const ring: [number, number][] = []
  const dLat = metres / 110574
  const dLon = metres / (111320 * Math.cos((lat * Math.PI) / 180) || 1)
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)])
  }
  return ring
}

const STATE_INK: Record<MapVehicle['state'], string> = {
  running: 'text-success',
  stale: 'text-destructive',
  idle: 'text-muted-foreground',
}
/* In the guidance tone a moving bus is the theme's own ink -- a dark arrow on
   the pale map, a light one on the dark map, the way the design draws its
   heading marker -- because the accent is spent on the route and a green
   arrow on a teal line is two colours saying one thing. Stale keeps its red:
   that is a warning, and warnings do not defer to a colour scheme. */
const GUIDANCE_INK: Record<MapVehicle['state'], string> = {
  running: 'text-foreground',
  stale: 'text-destructive',
  idle: 'text-muted-foreground',
}

/* The label is a server-stored vehicle registration and goes into innerHTML, so
   it is escaped first: a registration typed as `<img src=x onerror=…>` would
   otherwise run when the marker paints — on the parent portal's bus map too. */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}
function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

/** Paint the marker into an element, so a poll updates a bus in place rather
 *  than replacing the node under maplibre and making every marker blink. The
 *  DOM is deliberate: it inherits the theme's own semantic tokens, rather than
 *  hex picked against a white page. */
function paintMarker(el: HTMLElement, v: MapVehicle, focused: boolean, tone: MapTone = 'default'): HTMLElement {
  const stale = v.state === 'stale'
  el.className = cn(
    'flex flex-col items-center leading-none pointer-events-auto',
    (tone === 'guidance' ? GUIDANCE_INK : STATE_INK)[v.state],
  )
  el.style.opacity = focused ? '1' : '0.9'
  el.style.zIndex = focused ? '3' : stale ? '2' : '1'
  el.innerHTML = `
    <svg width="34" height="34" viewBox="-17 -17 34 34" aria-hidden="true">
      <circle r="13" fill="${stale ? 'none' : 'currentColor'}" fill-opacity="0.14"
              stroke="currentColor" stroke-width="${stale ? 2 : 1}"
              ${stale ? 'stroke-dasharray="4 3"' : ''} />
      <path d="M 0 -8 L 5.5 7 L 0 3.5 L -5.5 7 Z"
            transform="rotate(${v.heading_deg ?? 0})"
            fill="${stale ? 'none' : 'currentColor'}" stroke="currentColor"
            stroke-width="1.5" ${stale ? 'stroke-dasharray="3 2"' : ''} />
    </svg>
    <span class="rounded bg-background/85 px-1 text-[11px] font-semibold">${escapeHtml(v.label)}</span>
    ${v.note && stale ? `<span class="rounded bg-background/85 px-1 text-[10px]">${escapeHtml(v.note)}</span>` : ''}
  `
  el.setAttribute('aria-label', `${v.label}${v.note ? ` · ${v.note}` : ''}`)
  return el
}

export function FleetMap({
  vehicles,
  stops = [],
  link,
  routes,
  tone = 'default',
  focusId,
  onFocus,
  glideMs = 1200,
  className,
  empty,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null)
  const map = useRef<MLMap | null>(null)
  /* The guidance map follows the theme; the office map is always the light
     street map, because a full-colour basemap has no honest dark half. */
  const { resolved } = useTheme()
  const dark = tone === 'guidance' && resolved === 'dark'
  const flavor: MapFlavor = tone === 'guidance' ? (dark ? 'black' : 'grayscale') : 'light'
  const g = GUIDANCE[dark ? 'dark' : 'light']
  const markers = useRef<Map<string, maplibregl.Marker>>(new Map())
  // In-flight glides by vehicle, so a new fix cancels the animation to the old one.
  const glides = useRef<Map<string, number>>(new Map())
  // The last direction each bus was drawn facing, kept while it sits still.
  const lastHeading = useRef<Map<string, number>>(new Map())
  const [ready, setReady] = useState(false)
  const [tilesFailed, setTilesFailed] = useState(false)
  /* Filling the screen is a state of this component, not the browser's.

     The Fullscreen API is the obvious answer and the wrong one here: the parent
     app is a WebView, where requestFullscreen is refused or silently ignored
     depending on the handset, and a control that works on the office desktop
     and does nothing on a driver's phone is worse than no control. Growing the
     wrapper to cover the viewport needs no permission and behaves identically
     everywhere. */
  const [expanded, setExpanded] = useState(false)
  /* Fit once. Refitting on every poll would wrench the view out from under
     an office that had panned to the bus it was actually watching. */
  const fitted = useRef(false)

  const points = useMemo(
    () => [
      ...vehicles.map((v) => [v.longitude, v.latitude] as [number, number]),
      ...stops.map((s) => [s.longitude, s.latitude] as [number, number]),
      ...(link
        ? ([
            [link.from.longitude, link.from.latitude],
            [link.to.longitude, link.to.latitude],
          ] as [number, number][])
        : []),
      ...(routes ?? []).flat(),
    ],
    [vehicles, stops, link, routes],
  )

  useEffect(() => {
    if (!host.current || map.current) return
    const m = new maplibregl.Map({
      container: host.current,
      style: selfHostedStyle(flavor),
      center: [78.9629, 20.5937],
      zoom: 3,
      // The office reads this map; it does not present it. Rotation only
      // makes north ambiguous on a screen somebody is navigating by.
      pitchWithRotate: false,
      dragRotate: false,
      attributionControl: { compact: true },
    })
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    /* The scale bar the old plot carried. It is the thing that turns "the bus
       is a thumb's width from the stop" into a distance, and a map without one
       invites the reader to guess. */
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left')
    m.touchZoomRotate.disableRotation()
    m.on('load', () => {
      setReady(true)
      collapseAttribution(m)
    })
    /* A tile host with no SLA will eventually not answer. Say so: a grey
       square with markers floating on it reads as open countryside. */
    m.on('error', (e) => {
      if (String(e?.error?.message ?? '').match(/style|tile|fetch|load/i)) setTilesFailed(true)
    })
    map.current = m
    return () => {
      m.remove()
      map.current = null
      setReady(false)
    }
    // The flavour at creation only; a later theme change is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* THE MAP CHANGES WITH THE THEME, AND KEEPS WHAT IS ON IT.

     setStyle throws away every source and layer this component added, so a
     theme flip would leave a bare basemap with the markers floating on it.
     Rather than teach each effect to re-add its own layers, `ready` is
     dropped and raised again once the new style has loaded, which runs every
     effect below exactly as it ran on first load; each one already adds its
     source when the source is missing. The DOM markers survive setStyle on
     their own. Only the guidance tone does this -- the office map never
     changes flavour. */
  const firstFlavor = useRef(flavor)
  useEffect(() => {
    const m = map.current
    if (!m || tone !== 'guidance' || firstFlavor.current === flavor) return
    firstFlavor.current = flavor
    setReady(false)
    m.once('style.load', () => {
      collapseAttribution(m)
      setReady(true)
    })
    m.setStyle(selfHostedStyle(flavor))
  }, [flavor, tone])

  // Stops: one source, redrawn when the set changes. Geofences underneath the
  // stop dots so a dot is never hidden by its own catchment.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const fences = {
      type: 'FeatureCollection' as const,
      features: stops
        .filter((s) => s.geofence_m)
        .map((s) => ({
          type: 'Feature' as const,
          properties: {},
          geometry: {
            type: 'Polygon' as const,
            coordinates: [circleOnGround(s.latitude, s.longitude, s.geofence_m!)],
          },
        })),
    }
    const dots = {
      type: 'FeatureCollection' as const,
      features: stops.map((s) => ({
        type: 'Feature' as const,
        properties: { name: s.name, mine: !!s.mine },
        geometry: { type: 'Point' as const, coordinates: [s.longitude, s.latitude] },
      })),
    }
    for (const [id, data] of [
      ['fleet-fences', fences],
      ['fleet-stops', dots],
    ] as const) {
      const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(data)
      else m.addSource(id, { type: 'geojson', data })
    }
    if (!m.getLayer('fleet-fences-fill')) {
      const guidance = tone === 'guidance'
      m.addLayer({
        id: 'fleet-fences-fill',
        type: 'fill',
        source: 'fleet-fences',
        paint: guidance
          // The catchment as a soft accent wash, the way the design rings its
          // destination: it is the one place on the map the parent is
          // waiting for the bus to enter.
          ? { 'fill-color': g.accent, 'fill-opacity': 0.10 }
          : { 'fill-color': '#64748b', 'fill-opacity': 0.12 },
      })
      m.addLayer({
        id: 'fleet-stops-dot',
        type: 'circle',
        source: 'fleet-stops',
        paint: guidance
          /* Rings, as on the timeline beside the map: a hollow stop is one the
             bus has yet to make, and the parent's own is filled with the
             accent so the two drawings agree about which stop matters. */
          ? {
              'circle-radius': ['case', ['get', 'mine'], 7, 4.5],
              'circle-color': ['case', ['get', 'mine'], g.accent, g.panel],
              'circle-stroke-width': ['case', ['get', 'mine'], 2, 1.25],
              'circle-stroke-color': ['case', ['get', 'mine'], g.panel, g.ring],
              'circle-stroke-opacity': ['case', ['get', 'mine'], 1, 0.55],
            }
          : {
              // The parent's own stop among the route's others: bigger, green,
              // solid. The rest stay the small grey landmarks they always were.
              'circle-radius': ['case', ['get', 'mine'], 7, 4],
              'circle-color': ['case', ['get', 'mine'], '#15803d', '#0f172a'],
              'circle-opacity': ['case', ['get', 'mine'], 1, 0.65],
              'circle-stroke-width': ['case', ['get', 'mine'], 2.5, 1.5],
              'circle-stroke-color': '#ffffff',
            },
      })
      m.addLayer({
        id: 'fleet-stops-label',
        type: 'symbol',
        source: 'fleet-stops',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          // The stop names are the landmarks. Letting them collide into
          // nothing at low zoom leaves the office with unlabelled dots.
          'text-optional': true,
        },
        paint: {
          'text-color': guidance ? g.ink : '#0f172a',
          'text-halo-color': guidance ? g.halo : '#ffffff',
          'text-halo-width': 1.4,
          // Quieter on the guidance map: the names are there when looked for
          // and do not compete with the route.
          'text-opacity': guidance ? 0.72 : 1,
        },
      })
    }
  }, [stops, ready, tone, g])

  /* The run itself, in the accent, under the stops and over the streets.

     Two layers: a wide translucent one for the glow the design gives its
     route, and the line on top. Sources are added once and updated after,
     like everything else here; the layers are inserted beneath the stop dots
     so a ring is never hidden by the line passing through it. */
  useEffect(() => {
    const m = map.current
    if (!m || !ready || tone !== 'guidance') return
    const data = {
      type: 'FeatureCollection' as const,
      features: (routes ?? [])
        .filter((r) => r.length >= 2)
        .map((r) => ({
          type: 'Feature' as const,
          properties: {},
          geometry: { type: 'LineString' as const, coordinates: r },
        })),
    }
    const src = m.getSource('fleet-route') as maplibregl.GeoJSONSource | undefined
    if (src) {
      src.setData(data)
      return
    }
    m.addSource('fleet-route', { type: 'geojson', data })
    const before = m.getLayer('fleet-stops-dot') ? 'fleet-stops-dot' : undefined
    m.addLayer(
      {
        id: 'fleet-route-glow',
        type: 'line',
        source: 'fleet-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': g.accent, 'line-width': 14, 'line-opacity': 0.14, 'line-blur': 6 },
      },
      before,
    )
    m.addLayer(
      {
        id: 'fleet-route-line',
        type: 'line',
        source: 'fleet-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': g.accent, 'line-width': 4 },
      },
      before,
    )
  }, [routes, ready, tone, g])

  // The bus-to-stop line, redrawn as the bus moves.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const data = {
      type: 'FeatureCollection' as const,
      features: link
        ? [
            {
              type: 'Feature' as const,
              properties: { label: link.label ?? '' },
              geometry: {
                type: 'LineString' as const,
                coordinates: [
                  [link.from.longitude, link.from.latitude],
                  [link.to.longitude, link.to.latitude],
                ],
              },
            },
          ]
        : [],
    }
    const src = m.getSource('fleet-link') as maplibregl.GeoJSONSource | undefined
    if (src) {
      src.setData(data)
      return
    }
    m.addSource('fleet-link', { type: 'geojson', data })
    const guidance = tone === 'guidance'
    m.addLayer({
      id: 'fleet-link-line',
      type: 'line',
      source: 'fleet-link',
      paint: {
        'line-color': guidance ? g.ink : '#475569',
        'line-width': guidance ? 1.25 : 2,
        'line-opacity': guidance ? 0.5 : 1,
        // Dashed, because it is a straight line across the map and not a
        // route: the bus has turns and traffic between here and there.
        'line-dasharray': [2, 2],
      },
    })
    m.addLayer({
      id: 'fleet-link-label',
      type: 'symbol',
      source: 'fleet-link',
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 12,
        'symbol-placement': 'line-center',
        'text-offset': [0, -0.9],
      },
      paint: {
        'text-color': guidance ? g.ink : '#1e293b',
        'text-halo-color': guidance ? g.halo : '#ffffff',
        'text-halo-width': 1.6,
      },
    })
  }, [link, ready, tone, g])

  // Vehicles: markers are created and moved rather than torn down each poll,
  // so a bus does not blink out of existence every fifteen seconds.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const seen = new Set<string>()
    for (const v of vehicles) {
      seen.add(v.id)
      const focused = focusId === v.id
      const existing = markers.current.get(v.id)
      if (existing) {
        /* THE BUS IS SEEN MOVING, NOT APPEARING.

           setLngLat put the marker at the new fix in one frame, so every
           poll the bus teleported a few hundred metres and sat still: a
           parent watching for a minute saw four jumps and no travel. The
           marker now glides from where it was to where it is over most of
           the poll interval, so it is in motion for as long as it takes the
           next fix to arrive. The arrow turns to the direction of travel:
           the phone's own heading when it reported one, otherwise the
           bearing from the last fix to this, which is what a bus on a road
           is doing whatever its compass says. A move under a few metres is
           GPS noise on a stationary bus and neither glides nor turns. */
        const from = existing.getLngLat()
        const moved = metres(from.lat, from.lng, v.latitude, v.longitude)
        const heading =
          v.heading_deg ?? (moved >= 4 ? bearing(from.lat, from.lng, v.latitude, v.longitude) : lastHeading.current.get(v.id))
        if (heading != null) lastHeading.current.set(v.id, heading)
        paintMarker(existing.getElement(), { ...v, heading_deg: heading }, focused, tone)
        const prior = glides.current.get(v.id)
        if (prior) cancelAnimationFrame(prior)
        if (moved < 4 || glideMs <= 0) {
          existing.setLngLat([v.longitude, v.latitude])
        } else {
          const start = performance.now()
          const fromLng = from.lng
          const fromLat = from.lat
          const step = (now: number) => {
            const t = Math.min(1, (now - start) / glideMs)
            // Ease out: fast off the last fix, settling onto the new one.
            const k = 1 - (1 - t) * (1 - t)
            existing.setLngLat([fromLng + (v.longitude - fromLng) * k, fromLat + (v.latitude - fromLat) * k])
            if (t < 1) glides.current.set(v.id, requestAnimationFrame(step))
            else glides.current.delete(v.id)
          }
          glides.current.set(v.id, requestAnimationFrame(step))
        }
      } else {
        const el = paintMarker(document.createElement('div'), v, focused, tone)
        el.addEventListener('mouseenter', () => onFocus?.(v.id))
        el.addEventListener('mouseleave', () => onFocus?.(null))
        markers.current.set(
          v.id,
          new maplibregl.Marker({ element: el }).setLngLat([v.longitude, v.latitude]).addTo(m),
        )
        if (v.heading_deg != null) lastHeading.current.set(v.id, v.heading_deg)
      }
    }
    for (const [id, marker] of markers.current) {
      if (!seen.has(id)) {
        const prior = glides.current.get(id)
        if (prior) cancelAnimationFrame(prior)
        glides.current.delete(id)
        lastHeading.current.delete(id)
        marker.remove()
        markers.current.delete(id)
      }
    }
  }, [vehicles, focusId, onFocus, ready, glideMs, tone])

  /* Frame everything drawn. Called once on load, and again whenever somebody
     asks for it.

     A single bus has no extent of its own, so it gets a sensible zoom rather
     than the maximum one. `animate` is the difference between the two callers:
     the first fit should already be in place when the map appears, while a
     press of Recentre wants to be seen moving, or it is indistinguishable from
     a button that did nothing. */
  const frame = useCallback((animate: boolean) => {
    const m = map.current
    if (!m || points.length === 0) return
    const bounds = points.reduce(
      (b, p) => b.extend(p),
      new maplibregl.LngLatBounds(points[0], points[0]),
    )
    m.fitBounds(bounds as LngLatBoundsLike, {
      padding: 56,
      maxZoom: points.length === 1 ? 15 : 16,
      duration: animate ? 500 : 0,
    })
  }, [points])

  // The first fit, once.
  useEffect(() => {
    if (!map.current || !ready || fitted.current || points.length === 0) return
    frame(false)
    fitted.current = true
  }, [points, ready, frame])

  /* The canvas is sized in pixels at creation and does not notice its box
     changing. Without this the map keeps the small screen's dimensions after
     it is expanded and renders into a corner of the space it was given. */
  useEffect(() => {
    const m = map.current
    if (!m) return
    const id = window.setTimeout(() => m.resize(), 60)
    return () => window.clearTimeout(id)
  }, [expanded])

  // Escape leaves the expanded map, because every other overlay in this
  // product does and a map that traps the key reads as frozen.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  /* THE WAY BACK ON A PHONE. The full-screen map had one exit: the same
     small button that opened it, bottom right, which on a phone is under the
     thumb that is dragging the map. And the phone's own Back — the swipe from
     the edge in the iPhone app, the button on Android — left the whole
     screen, because the map had not told history it was a place. Expanding
     pushes an entry, Back pops it and the map folds; leaving by the button
     pops the entry itself so history does not keep a ghost page. */
  useEffect(() => {
    if (!expanded) return
    let popped = false
    const onPop = () => { popped = true; setExpanded(false) }
    window.history.pushState({ mapExpanded: true }, '')
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (!popped && window.history.state?.mapExpanded) window.history.back()
    }
  }, [expanded])

  if (points.length === 0 && empty) return <>{empty}</>

  return (
    <div
      className={cn(
        'relative overflow-hidden',
        // The guidance map sits inside a panel that draws its own edge; a
        // second border a pixel inside the first reads as a seam.
        tone === 'guidance' ? 'border-0' : 'border',
        expanded
          ? 'fixed inset-0 z-[80] h-[100dvh] w-screen rounded-none'
          : cn(tone === 'guidance' ? 'rounded-none' : 'rounded-[8px]', className),
      )}
    >
      <div ref={host} className="h-full w-full" />

      {expanded && (
        /* Top left, where every phone screen puts its way back, and clear of
           the clock: the expanded map is fixed to the viewport, so the body's
           padding for the notch does not reach it and the inset is applied
           here. Says "Back" rather than showing an icon, because a person who
           cannot find the exit is not in the mood to decode one. */
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="absolute left-3 z-10 flex h-10 items-center gap-1.5 rounded-full border
                     bg-background/90 pl-2.5 pr-3.5 text-[14px] font-medium text-foreground
                     shadow-md backdrop-blur transition-colors hover:bg-background active:scale-95"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
        >
          <ChevronLeft className="size-4" />
          Back
        </button>
      )}

      {/* THE TWO THINGS A MAP IS ASKED FOR AND DID NOT HAVE.

          Recentre, because the map framed itself once on load and never again:
          a parent who pinched to see which turning the bus had taken had no way
          back to the bus except reloading the screen. On a phone that is one
          gesture away from happening every single time.

          And room, because this map is often 200px tall in a card on a phone,
          which is enough to say a bus exists and not enough to say where. Both
          sit bottom-right, clear of the zoom control at the top and of the
          scale bar at bottom-left, and both are 40px targets -- the size of a
          fingertip, not of a mouse pointer. */}
      <div
        className="absolute right-3 z-10 flex flex-col gap-2"
        /* Above the home indicator when the map is the whole screen. */
        style={{ bottom: expanded ? 'calc(env(safe-area-inset-bottom, 0px) + 12px)' : 12 }}
      >
        <button
          type="button"
          onClick={() => frame(true)}
          aria-label="Recentre the map"
          title="Recentre"
          className="grid size-10 place-items-center rounded-full border bg-background/90
                     text-foreground shadow-md backdrop-blur transition-colors
                     hover:bg-background active:scale-95"
        >
          <Crosshair className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Leave full screen' : 'Show the map full screen'}
          title={expanded ? 'Leave full screen' : 'Full screen'}
          className="grid size-10 place-items-center rounded-full border bg-background/90
                     text-foreground shadow-md backdrop-blur transition-colors
                     hover:bg-background active:scale-95"
        >
          {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </button>
      </div>
      {tilesFailed && (
        /* Not a toast. The map is still usable — the markers and the stops are
           this app's own data and are drawn regardless — so the honest thing
           is to label what is missing and leave the rest working. */
        <div className="pointer-events-none absolute inset-x-0 top-0 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          The street map did not load. Positions and stops below are still this
          school’s own and are drawn correctly.
        </div>
      )}
    </div>
  )
}
