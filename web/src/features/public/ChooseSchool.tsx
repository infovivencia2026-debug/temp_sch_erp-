import { useEffect, useState } from 'react'
import { Button, Card, Field, FormNotice, Input } from '@/components/ui'
import { can, pickNative, shell } from '@/lib/shell'

/* WHICH SCHOOL THIS APP IS FOR (the generic XULO app's first screen).

   A per-school app has its school built in and never shows this. The generic
   app opens here until a school is chosen: the person types the school code
   printed on the school's notice (in/riverside), scans the school's QR code,
   or arrived from a school link, which the shell turns into the code itself.
   The school's public /<cc>/<slug>/app.json gives the name, logo, colours and
   address; the shell keeps it (ErpShell.setSchool) and opens the school.

   Public: no sign-in, nothing of any school in the source. */

export interface SchoolConfig {
  name: string
  short_name: string
  portal_url: string
  primary_color: string
  logo_url: string | null
}

/** "in/riverside", "IN / Riverside", a full school link or a QR's text: the
    country and slug, or null. */
export function parseSchoolCode(raw: string): { cc: string; slug: string } | null {
  const s = raw.trim().toLowerCase()
  const m = s.match(/(?:^|\/)([a-z]{2})\s*\/\s*([a-z0-9][a-z0-9-]{1,62})\/?(?:[?#].*)?$/)
  return m ? { cc: m[1], slug: m[2] } : null
}

async function decodeQr(file: File): Promise<string | null> {
  const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect(i: ImageBitmap): Promise<{ rawValue: string }[]> } }).BarcodeDetector
  if (!BD) return null
  try {
    const found = await new BD({ formats: ['qr_code'] }).detect(await createImageBitmap(file))
    return found[0]?.rawValue ?? null
  } catch {
    return null
  }
}

export default function ChooseSchool() {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [found, setFound] = useState<SchoolConfig | null>(null)
  const canScan = can('pickFile') && 'BarcodeDetector' in window

  useEffect(() => {
    document.title = 'Choose your school'
    const q = new URLSearchParams(location.search).get('code')
    if (q) { setCode(q); void look(q) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function look(raw: string) {
    setError(undefined)
    setFound(null)
    const p = parseSchoolCode(raw)
    if (!p) { setError('Type the code as country / school, for example in/riverside. It is on the school\'s notice or website.'); return }
    setBusy(true)
    try {
      const res = await fetch(`/${p.cc}/${p.slug}/app.json`, { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error()
      setFound(await res.json() as SchoolConfig)
    } catch {
      setError(navigator.onLine === false
        ? 'Needs internet. Connect and try again.'
        : 'No school has that code. Check it with the school office.')
    } finally {
      setBusy(false)
    }
  }

  async function scan() {
    const files = await pickNative('camera', 'image/*')
    const text = files?.[0] ? await decodeQr(files[0]) : null
    if (!text) { setError('No school code found in that photo. Type the code instead.'); return }
    setCode(text)
    void look(text)
  }

  function open(cfg: SchoolConfig) {
    const s = shell()
    if (s?.setSchool) s.setSchool(JSON.stringify(cfg))
    else location.href = cfg.portal_url
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-8 text-foreground">
      <Card className="w-full max-w-[420px]">
        <div className="p-[var(--card-pad,24px)]">
        <h1 className="text-[20px] font-semibold">Choose your school</h1>
        <p className="mt-1 text-[14px] text-muted-foreground">
          Type the school code from the school's notice or website, or scan the school's QR code.
        </p>
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => { e.preventDefault(); void look(code) }}
        >
          <Field label="School code">
            <Input value={code} onChange={setCode} placeholder="in/riverside" autoComplete="off" autoFocus />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant={found ? "secondary" : "primary"} pending={busy} disabled={!code.trim()}>Find school</Button>
            {canScan && <Button variant="secondary" onClick={() => void scan()}>Scan QR code</Button>}
          </div>
          {error && <FormNotice error={new Error(error)} />}
        </form>
        {found && (
          <div className="mt-6 flex items-center gap-3 border-t pt-5">
            {found.logo_url && <img src={found.logo_url} alt="" className="size-12 shrink-0 rounded-md object-contain" />}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{found.name}</p>
              <p className="truncate text-[13px] text-muted-foreground">{new URL(found.portal_url).host}</p>
            </div>
            <Button onClick={() => open(found)}>Open</Button>
          </div>
        )}
        </div>
      </Card>
    </main>
  )
}
