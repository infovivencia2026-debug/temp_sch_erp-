import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Button, Card } from '@/components/ui'

/* The sticker that goes inside the windscreen.

   A driver is not permanent on a bus. The regular man is on leave, the spare
   bus goes out, two drivers swap at lunch — so a phone bound once to one
   vehicle describes a school that does not exist. What is constant is the bus,
   so the bus carries the identifier and the driver says which one he is in
   today by scanning this or typing the six digits under it.

   The digits are printed as large as the code itself, and that is the point:
   a camera fails in a dark cab, on a cracked screen, and on a sticker somebody
   has cleaned with diesel. Every scannable thing in a vehicle needs a number a
   person can read aloud, or the fallback is a phone call to the office.

   Drawn to a canvas at print resolution rather than fetched as an image: the
   code is six digits the browser already has, and a round trip for a picture
   of them would be a round trip that fails when the office prints these on a
   morning the network is down. */
export default function BusSticker({
  code,
  registration,
  schoolName,
}: {
  code: string
  registration: string
  schoolName?: string
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!canvas.current) return
    QRCode.toCanvas(canvas.current, code, {
      width: 320,
      margin: 1,
      // Highest correction: this is going behind glass in a vehicle, and a
      // corner of it will be scuffed or covered by a tax disc within a term.
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(() => setFailed(true))
  }, [code])

  return (
    <Card className="print-sticker p-5 text-center">
      <p className="text-[13px] uppercase tracking-wider text-muted-foreground">
        {schoolName ?? 'School bus'}
      </p>
      <p className="mt-1 font-mono text-[18px] font-semibold">{registration}</p>

      <div className="mt-4 flex justify-center">
        {failed ? (
          <div className="grid h-[220px] w-[220px] place-items-center rounded-md border text-[13px] text-muted-foreground">
            The code could not be drawn. The number below still works.
          </div>
        ) : (
          <canvas ref={canvas} className="h-[220px] w-[220px]" />
        )}
      </div>

      <p className="mt-4 font-mono text-[34px] font-bold tracking-[0.18em] tabular-nums">
        {code}
      </p>
      <p className="mt-2 text-[13px] text-muted-foreground">
        Scan this in the driver app, or type the six digits, to say you are driving this bus
        today.
      </p>

      <div className="mt-4 no-print">
        <Button variant="secondary" size="sm" onClick={() => window.print()}>
          Print this sticker
        </Button>
      </div>
    </Card>
  )
}
