/* What to call the modifier key on the machine actually in front of somebody.

   The palette has always listened for Meta *and* Control, so the shortcut
   worked on Windows from the start. Only the label was wrong — it said ⌘K, a
   key a Windows keyboard does not have, so the shortcut read as not being for
   them and went untried.

   userAgentData.platform is the modern answer and is absent in Firefox and
   Safari, so navigator.platform stays as the fallback. It is deprecated and
   still universally implemented; when it goes the default here is the Windows
   spelling, which is both the larger population and the safer wrong answer. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const modern = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
  return /mac|iphone|ipad|ipod/i.test(modern || navigator.platform || '')
}

/** The shortcut as a person would read it off their own keyboard. */
export function shortcutLabel(key: string): string {
  return isApplePlatform() ? `⌘${key}` : `Ctrl ${key}`
}
