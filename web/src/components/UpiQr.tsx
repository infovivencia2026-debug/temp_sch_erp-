import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { buildUpiIntent } from '@/lib/upi'
import { formatPaise } from '@/lib/utils'

/* The code a parent scans to pay a fee.

   Same idea as the laminated QR taped to every fee counter in the country,
   with the amount and the admission number already inside it, so the parent
   does not type either and the bank narration says whose money it is. Drawn
   on a canvas from the intent string the browser already has -- no round
   trip, so it works on a phone at the gate with one bar of signal.

   Error correction M rather than BusSticker's H: this is a screen, not a
   windscreen, and H would make a fixed-amount intent with a note dense enough
   that an older phone camera struggles at arm's length.

   It says what it is. A parent who pays here has paid the school, not the
   system, and the receipt appears once the office records the transfer -- so
   the caption says so rather than letting the QR imply a card checkout. */
export default function UpiQr({
  vpa,
  payeeName,
  amountPaise,
  note,
  size = 220,
  caption,
}: {
  vpa: string
  payeeName: string
  amountPaise: number
  note?: string
  size?: number
  /** What to say under the code. Absent, nothing is said. */
  caption?: string
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [failed, setFailed] = useState(false)
  const intent = buildUpiIntent({ vpa, payeeName, amountPaise, note })

  useEffect(() => {
    if (!canvas.current) return
    setFailed(false)
    QRCode.toCanvas(canvas.current, intent, {
      width: size * 2, // drawn at 2x and shown at 1x: crisp on a phone screen
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(() => setFailed(true))
  }, [intent, size])

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="rounded-xl border bg-white p-2">
        {failed ? (
          <div
            className="grid place-items-center text-[13px] text-muted-foreground"
            style={{ width: size, height: size }}
          >
            The code could not be drawn. Pay to {vpa} instead.
          </div>
        ) : (
          <canvas ref={canvas} style={{ width: size, height: size }} aria-label={`UPI QR code to pay ${formatPaise(amountPaise)} to ${vpa}`} />
        )}
      </div>
      <div>
        <p className="text-[20px] font-semibold tabular-nums">{formatPaise(amountPaise)}</p>
        <p className="text-[12.5px] text-muted-foreground">
          {payeeName} · <span className="font-mono">{vpa}</span>
        </p>
        {note && <p className="mt-0.5 text-[12px] text-muted-foreground">Note: {note}</p>}
      </div>
      {/* On a phone this opens the UPI app directly; on a desk it does
          nothing, which is fine -- the code above is what a desk shows. */}
      <a
        href={intent}
        className="text-[13px] font-medium text-primary underline-offset-2 hover:underline"
      >
        Open in a UPI app on this phone
      </a>
      {caption && <p className="max-w-[28rem] text-[12.5px] text-muted-foreground">{caption}</p>}
    </div>
  )
}
