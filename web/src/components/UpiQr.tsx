import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatPaise } from '@/lib/utils'

/* The code a parent scans to pay a fee.

   Same idea as the laminated QR taped to every fee counter in the country,
   with the amount and the admission number already inside it, so the parent
   does not type either and the bank narration says whose money it is.

   The server draws it. This used to be drawn on a canvas in the browser from
   an intent string built here, and that is one more thing an old phone
   browser fails at silently: no canvas, a WebView with scripts half off, a
   bundle that stalled. A parent then saw a white square at the gate. A PNG
   the server made shows in anything that renders an <img>, and the
   upi://pay link beside it is a plain anchor. The address and payee come
   from the school's profile on the server, never from this page, so a
   tampered page cannot point the code at a stranger.

   It says what it is. A parent who pays here has paid the school, not the
   system, and the receipt appears once the office records the transfer -- so
   the caption says so rather than letting the QR imply a card checkout. */

interface UpiCode {
  vpa: string
  payee_name: string
  amount_paise: number
  note?: string
  intent: string
  image: string
}

export default function UpiQr({
  vpa,
  payeeName,
  amountPaise,
  note,
  size = 220,
  caption,
}: {
  /** Shown while the code loads and as the fallback if it cannot; the
      server decides the address the code actually carries. */
  vpa: string
  payeeName: string
  amountPaise: number
  note?: string
  size?: number
  /** What to say under the code. Absent, nothing is said. */
  caption?: string
}) {
  const q = new URLSearchParams({ amount_paise: String(Math.round(amountPaise)), size: String(size * 2) })
  if (note) q.set('note', note)
  const code = useQuery({
    queryKey: ['upi-code', amountPaise, note ?? '', size],
    queryFn: () => api.get<UpiCode>(`/api/v1/fees/upi-code?${q.toString()}`),
    enabled: amountPaise > 0,
    staleTime: 60 * 60 * 1000,
  })
  const shownVpa = code.data?.vpa ?? vpa
  const shownPayee = code.data?.payee_name ?? payeeName

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="rounded-xl border bg-white p-2">
        {code.data ? (
          <img
            src={code.data.image}
            width={size}
            height={size}
            style={{ width: size, height: size, display: 'block' }}
            alt={`UPI QR code to pay ${formatPaise(amountPaise)} to ${shownVpa}`}
          />
        ) : (
          <div
            className="grid place-items-center text-[13px] text-muted-foreground"
            style={{ width: size, height: size }}
          >
            {code.isError ? `The code could not be fetched. Pay to ${vpa} instead.` : 'Getting the code…'}
          </div>
        )}
      </div>
      <div>
        <p className="text-[20px] font-semibold tabular-nums">{formatPaise(amountPaise)}</p>
        <p className="text-[12.5px] text-muted-foreground">
          {shownPayee} · <span className="font-mono">{shownVpa}</span>
        </p>
        {note && <p className="mt-0.5 text-[12px] text-muted-foreground">Note: {code.data?.note ?? note}</p>}
      </div>
      {/* On a phone this opens the UPI app directly; on a desk it does
          nothing, which is fine -- the code above is what a desk shows. */}
      {code.data && (
        <a
          href={code.data.intent}
          className="text-[13px] font-medium text-primary underline-offset-2 hover:underline"
        >
          Open in a UPI app on this phone
        </a>
      )}
      {caption && <p className="max-w-[28rem] text-[12.5px] text-muted-foreground">{caption}</p>}
    </div>
  )
}
