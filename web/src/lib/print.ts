/* Print, wherever the page happens to be running.

   window.print() is what a browser answers with its print dialog and what a
   WebView answers with nothing: neither the Android WebView nor WKWebView
   wires it to the system's print service, so every "Print" button in the
   product -- the fee receipt, the report card, the ID card, the bus sticker
   -- did nothing at all inside the parent app. No error, no dialog, a button
   that pressed and stayed pressed.

   The shells now expose ErpShell.print (mobile/apps/parent MainActivity.kt,
   mobile/apps/parent-ios BridgeScript.swift), which hands the page to the
   phone's own print sheet. Both sheets include "Save as PDF", which is what
   a parent on a phone actually wants from "Print": a file to keep or send.
   The site's print stylesheet applies in the WebView exactly as in a
   browser, so what comes out is the same document. Older builds of the app
   have no such method and fall through to window.print, which is no worse
   than before. */
export function printPage(): void {
  if (typeof window === 'undefined') return
  const shell = window.ErpShell?.print
  if (typeof shell === 'function') {
    shell.call(window.ErpShell)
    return
  }
  window.print()
}
