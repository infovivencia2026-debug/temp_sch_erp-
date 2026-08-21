/* What to call the modifier key, on the machine actually in front of somebody.

   The palette has always listened for both Meta and Control, so the shortcut
   itself worked everywhere. Only the label was wrong: a Windows user was told
   to press a key their keyboard does not have, which reads as the feature not
   being for them.

   userAgentData.platform is the modern answer and is absent in Safari and
   Firefox, so navigator.platform stays as the fallback. It is deprecated and
   still universally implemented; when it finally goes, the default here is the
   Windows spelling, which is the larger population and the safer wrong answer. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const modern = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform
  const raw = modern || navigator.platform || ''
  return /mac|iphone|ipad|ipod/i.test(raw)
}

/** The modifier as it is printed on the key: ⌘ on a Mac, Ctrl everywhere else. */
export function modifierLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl'
}

/** The shortcut as a person would say it: "⌘K" or "Ctrl K". */
export function shortcutLabel(key: string): string {
  return isApplePlatform() ? `⌘${key}` : `Ctrl ${key}`
}
