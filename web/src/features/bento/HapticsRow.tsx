import { useAppearance } from '@/lib/appearance'
import { useT } from '@/lib/i18n'
import { Rows, SwitchRow } from './SettingsRows'

/* SETTINGS > APPEARANCE > HAPTICS.

   One switch, device-local like every other appearance preference, read by
   lib/haptics on every pulse. Default on. It is its own file so it can be
   dropped into any appearance surface as a single line: the /settings route
   renders it under the pane (HapticsRows), and the desktop dialog's
   appearance <Rows> takes the bare <HapticsRow /> the same way. */
export function HapticsRow() {
  const t = useT()
  const { appearance, set } = useAppearance()
  const on = appearance.haptics !== 'off'
  return (
    <SwitchRow
      label={t('bento.settings.haptics')}
      helper={t('bento.settings.haptics_helper')}
      on={on}
      onToggle={() => set('haptics', on ? 'off' : 'on')}
    />
  )
}

/** The row in its own group, for a page that shows the appearance pane and
    has no <Rows> of its own to put it in. */
export function HapticsRows() {
  return (
    <Rows className="mt-[12px]">
      <HapticsRow />
    </Rows>
  )
}
