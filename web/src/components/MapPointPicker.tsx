import { useEffect, useRef, useState } from 'react'
import maplibregl, { type Map as MLMap, type Marker } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Button } from '@/components/ui'
import { selfHostedStyle } from '@/components/FleetMap'

/* Putting a stop where it actually is.

   A bus stop's coordinates decide where the arrival alert fires, and the only
   way to enter them was two decimal fields. Nobody in a school office knows
   that the JNTU crossroads is 17.4933, 78.3915. What they did instead was open
   a maps app on their phone, long-press the junction, copy a string, and paste
   half of it into each box — and a transposed digit puts the geofence in a
   different district with nothing on the screen to say so.

   So: the same basemap the fleet screens use, a pin the office drags, and the
   numbers filled in from where they dropped it. The fields stay, because a
   coordinate read off a survey or pasted from elsewhere is still the fastest
   way in when you have one.

   TILES: the same self-hosted archive FleetMap draws from, so the point the
   office picks is picked on the map the parent will see it on. See the note
   above selfHostedStyle in FleetMap for why it is ours and not a tile host's. */

interface Props {
  /** Where to open. Null means "no point chosen yet" — see `fallback`. */
  value: { lat: number; lng: number } | null
  /* Where to look when this stop has no coordinates yet: the route's other
     stops, usually. A picker that opens on the whole of India makes somebody
     pan for a minute before they can even see the town. */
  fallback?: { lat: number; lng: number } | null
  onPick: (point: { lat: number; lng: number }) => void
  onClose: () => void
}

/** Six decimals is a tenth of a metre. More is noise and reads as precision. */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

export default function MapPointPicker({ value, fallback, onPick, onClose }: Props) {
  const host = useRef<HTMLDivElement | null>(null)
  const map = useRef<MLMap | null>(null)
  const marker = useRef<Marker | null>(null)
  const [point, setPoint] = useState(value)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!host.current || map.current) return
    const start = value ?? fallback
    const m = new maplibregl.Map({
      container: host.current,
      style: selfHostedStyle(),
      center: start ? [start.lng, start.lat] : [78.9629, 20.5937],
      // Close enough to see which side of the road, when we know where to look.
      zoom: start ? 16 : 4,
      pitchWithRotate: false,
      dragRotate: false,
      attributionControl: { compact: true },
    })
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

    /* A community tile host with no SLA. An empty grey square reads as "there
       is nothing here", which is a different and much worse statement than
       "the map did not load". */
    m.on('error', () => setFailed(true))

    const place = (lng: number, lat: number) => {
      const next = { lat: round(lat), lng: round(lng) }
      setPoint(next)
      if (!marker.current) {
        marker.current = new maplibregl.Marker({ draggable: true, color: '#1B4332' })
          .setLngLat([next.lng, next.lat])
          .addTo(m)
        marker.current.on('dragend', () => {
          const p = marker.current!.getLngLat()
          setPoint({ lat: round(p.lat), lng: round(p.lng) })
        })
      } else {
        marker.current.setLngLat([next.lng, next.lat])
      }
    }

    if (start && value) place(start.lng, start.lat)
    m.on('click', (e) => place(e.lngLat.lng, e.lngLat.lat))
    map.current = m
    return () => {
      m.remove()
      map.current = null
      marker.current = null
    }
    // Mounted once: the map owns its own camera after that, and re-running
    // this on every parent render would throw the office's panning away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="mt-3 rounded-md border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <p className="text-[13px] text-muted-foreground">
          {point
            ? `${point.lat}, ${point.lng} — drag the pin to correct it.`
            : 'Tap the map where the bus stops.'}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={!point}
            onClick={() => {
              if (point) onPick(point)
            }}
          >
            Use this point
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
      {failed && (
        <p className="border-b bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
          The map tiles did not load. The coordinate fields still work, and the pin still
          reports where you tap.
        </p>
      )}
      <div ref={host} className="h-[320px] w-full" />
    </div>
  )
}
