/* SAVE A FILE THE SERVER DREW, WITHOUT LETTING THE PAGE NAVIGATE TO IT.

   An `<a href download>` pointing at an API route looks like the simple
   answer and is not: the download attribute only binds the browser on a
   same-origin navigation, this app registers a service worker that answers
   navigations with the SPA shell, and a phone that decides to render the PDF
   instead hands the person a viewer with a print button on it -- which is
   exactly what was reported, a Download that printed.

   Fetching the bytes here keeps it an ordinary request the service worker
   passes through, and an object URL with a filename is the one path every
   browser treats as a save. The name comes from the server's own
   Content-Disposition when it sent one, so the file is called what the
   document is called rather than what the route is called.

   The object URL is revoked on the next tick: Safari has not finished with it
   when click() returns. */
export async function saveFile(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) {
    let why = `${res.status}`
    try {
      const body = await res.json() as { error?: string }
      if (body?.error) why = body.error
    } catch { /* not JSON: the status is all there is to say */ }
    throw new Error(why)
  }
  const blob = await res.blob()
  const named = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')
  const name = named?.[1] ?? fallbackName
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 0)
}
