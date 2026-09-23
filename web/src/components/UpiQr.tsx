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
   the server made shows in anything that renders an <img>, and the app
   buttons beside it are plain anchors. The address and payee come from the
   school's profile on the server, never from this page, so a tampered page
   cannot point the code at a stranger.

   It says what it is. A parent who pays here has paid the school, not the
   system, and the receipt appears once the office records the transfer -- so
   the caption says so rather than letting the QR imply a card checkout. */

interface UpiApp {
  key: string
  label: string
  /** intent: URI naming the Android package, so the OS default is bypassed. */
  android?: string
  /** The app's own iOS URL scheme. */
  ios?: string
}

interface UpiCode {
  vpa: string
  payee_name: string
  amount_paise: number
  note?: string
  intent: string
  apps?: UpiApp[]
  image: string
}

/* Which phone this is, for the one decision that depends on it.

   Android takes an intent: URI that names a package; iOS takes the app's own
   scheme; anything else gets the plain upi:// link, which on a desktop does
   nothing and should not pretend otherwise. UA sniffing is the wrong tool for
   almost everything and the right one here: there is no feature to detect,
   the two platforms genuinely need different URI syntax, and a wrong guess
   costs a tap rather than a payment -- the QR above still works. */
function appHref(app: UpiApp, generic: string): string {
  if (!app.android && !app.ios) return generic
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Android/i.test(ua)) return app.android || generic
  if (/iPhone|iPad|iPod/i.test(ua)) return app.ios || generic
  return generic
}

export default function UpiQr({
  vpa,
  payeeName,
  amountPaise,
  note,
  reference,
  size = 220,
  caption,
}: {
  /** Shown while the code loads and as the fallback if it cannot; the
      server decides the address the code actually carries. */
  vpa: string
  payeeName: string
  amountPaise: number
  note?: string
  /** The invoice this pays, sent as the UPI transaction reference on a
      merchant account so the office can match the transfer to the bill.
      Ignored for a personal address, which carries no reference. */
  reference?: string
  size?: number
  /** What to say under the code. Absent, nothing is said. */
  caption?: string
}) {
  const q = new URLSearchParams({ amount_paise: String(Math.round(amountPaise)), size: String(size * 2) })
  if (note) q.set('note', note)
  if (reference) q.set('ref', reference)
  const code = useQuery({
    queryKey: ['upi-code', amountPaise, note ?? '', reference ?? '', size],
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
      {/* THE PARENT PICKS THE APP, NOT THE PHONE.

          This was one "Open in a UPI app" link to upi://pay. Android sends
          that to whichever app holds the default UPI handler, and on a great
          many phones that is WhatsApp -- so a parent whose money is in Google
          Pay tapped it and landed in a WhatsApp account they had never
          funded, with no chooser and nothing on screen to explain it.

          A button each, addressing the app directly. "Another UPI app" keeps
          the old generic link for anyone whose app is not on the list, and on
          a desktop it is the only one that is offered, because none of the
          others can open there. */}
      {code.data?.apps?.length ? (
        <div className="w-full">
          <p className="text-[12.5px] text-muted-foreground">Or pay from this phone</p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {code.data.apps.map((app) => (
              <a
                key={app.key}
                href={appHref(app, code.data!.intent)}
                className="rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[hsl(var(--surface-hover))]"
              >
                {app.label}
              </a>
            ))}
          </div>
        </div>
      ) : code.data ? (
        <a
          href={code.data.intent}
          className="text-[13px] font-medium text-primary underline-offset-2 hover:underline"
        >
          Open in a UPI app on this phone
        </a>
      ) : null}
      {caption && <p className="max-w-[28rem] text-[12.5px] text-muted-foreground">{caption}</p>}
    </div>
  )
}
