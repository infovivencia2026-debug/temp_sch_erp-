import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Palette, Rows3, MonitorCog } from 'lucide-react'
import { api } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Button,
  Checkbox, Field, FormGrid, FormNotice, Select,
  Loading, ErrorState,
} from '@/components/ui'

interface Preference {
  theme: string
  density: string
  reduce_motion: boolean
}
interface PreferenceResponse {
  preference: Preference
  theme_choices: string[]
  density_choices: string[]
  default_theme: string
  default_density: string
}

const THEME_LABEL: Record<string, string> = {
  system: 'Follow this device',
  light: 'Light',
  dark: 'Dark',
}
const DENSITY_LABEL: Record<string, string> = {
  compact: 'Compact — more rows on screen',
  comfortable: 'Comfortable — the standard spacing',
  relaxed: 'Relaxed — more room between rows',
}

/* Where the appearance settings live, and nothing more than that.

   This screen deliberately introduces no palette, no component variant and no
   spacing of its own. Everything it can select was already implemented and
   already reachable: index.css has carried a light palette, a .dark override
   and a three-step data-density dial since before this feature existed, and
   the shell's own toggle drives exactly these two mechanisms. What was missing
   was memory — localStorage is per-device, so a child who chose dark mode in
   the computer room got the default again on the tablet at home and concluded
   the setting did not work.

   So the feature is storage, not styling. The choice is saved against the
   account, applied through the same class and data attribute the shell already
   uses, and written back to the same localStorage keys so the shell's own
   toggle and this screen never disagree.

   'Follow this device' is the default and stays the default. Storing 'light'
   for somebody who never opened this page would change what they see, which is
   precisely the change that is not on the table. */
export default function ThemeSelection() {
  const qc = useQueryClient()
  const [theme, setTheme] = useState('system')
  const [density, setDensity] = useState('comfortable')
  const [reduceMotion, setReduceMotion] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const prefs = useQuery({
    queryKey: ['display-preferences'],
    queryFn: () => api.get<PreferenceResponse>('/api/v1/portal/preferences/display'),
  })

  // Seed the form from the stored row once. Not on every render: a controlled
  // Select that resets from a refetch loses whatever the person just chose.
  useEffect(() => {
    if (prefs.data && !loaded) {
      setTheme(prefs.data.preference.theme)
      setDensity(prefs.data.preference.density)
      setReduceMotion(prefs.data.preference.reduce_motion)
      setLoaded(true)
    }
  }, [prefs.data, loaded])

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/v1/portal/preferences/display', {
        theme,
        density,
        reduce_motion: reduceMotion,
      }),
    onSuccess: () => {
      apply(theme, density)
      qc.invalidateQueries({ queryKey: ['display-preferences'] })
    },
  })

  if (prefs.isLoading) return <Loading label="Reading your settings…" />
  if (prefs.error) return <ErrorState error={prefs.error} />

  const themeChoices = prefs.data?.theme_choices ?? ['system', 'light', 'dark']
  const densityChoices = prefs.data?.density_choices ?? ['compact', 'comfortable', 'relaxed']
  const stored = prefs.data?.preference
  const dirty =
    !!stored &&
    (stored.theme !== theme ||
      stored.density !== density ||
      stored.reduce_motion !== reduceMotion)

  return (
    <>
      <PageHead
        eyebrow="Home"
        title="Appearance"
        description="How the portal looks on every device you sign in on, not just this one."
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label="Theme" value={THEME_LABEL[stored?.theme ?? 'system']} icon={Palette} />
          <Stat
            label="Row height"
            value={(stored?.density ?? 'comfortable').replace(/^./, (c) => c.toUpperCase())}
            icon={Rows3}
          />
          <Stat
            label="Saved to"
            value="Your account"
            icon={MonitorCog}
            hint="Applies wherever you sign in"
          />
        </CellGrid>

        <Card>
          <CardHeader
            title="Choose"
            description="These are the looks the portal already has. Nothing new is being added."
          />
          <div className="space-y-5 p-5">
            <FormGrid>
              <Field
                label="Theme"
                hint="Following the device switches with your phone or laptop's own dark mode."
              >
                <Select
                  value={theme}
                  onChange={setTheme}
                  options={themeChoices.map((v) => ({ value: v, label: THEME_LABEL[v] ?? v }))}
                />
              </Field>
              <Field label="Row height" hint="Compact fits more of a long list on one screen.">
                <Select
                  value={density}
                  onChange={setDensity}
                  options={densityChoices.map((v) => ({
                    value: v,
                    label: DENSITY_LABEL[v] ?? v,
                  }))}
                />
              </Field>
              <Field label="Movement" wide>
                <Checkbox
                  checked={reduceMotion}
                  onChange={setReduceMotion}
                  label="Reduce movement"
                  hint="Kept with your other display choices."
                />
              </Field>
            </FormGrid>
            <FormNotice
              error={save.error}
              ok={save.isSuccess && !dirty ? 'Saved to your account.' : undefined}
            />
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="secondary"
                disabled={
                  theme === (prefs.data?.default_theme ?? 'system') &&
                  density === (prefs.data?.default_density ?? 'comfortable')
                }
                onClick={() => {
                  setTheme(prefs.data?.default_theme ?? 'system')
                  setDensity(prefs.data?.default_density ?? 'comfortable')
                }}
              >
                Back to the defaults
              </Button>
            </div>
            <p className="text-[12.5px] text-muted-foreground">
              Saving applies the change here straight away and on your next sign-in anywhere else.
            </p>
          </div>
        </Card>
      </PageBody>
    </>
  )
}

/* Apply a saved choice through the mechanisms the shell already owns.

   The class name, the data attribute and both localStorage keys are exactly
   what components/Shell.tsx reads and writes. Using anything else here would
   give the product two disagreeing sources of truth about the theme, and the
   header toggle would appear to undo whatever this page had just saved. */
function apply(theme: string, density: string) {
  const root = document.documentElement
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  root.classList.toggle('dark', dark)
  root.dataset.density = density
  try {
    localStorage.setItem('erp.theme', JSON.stringify(dark ? 'dark' : 'light'))
    localStorage.setItem('erp.density', density)
  } catch {
    /* private browsing; the stored preference still applies on next sign-in */
  }
}
