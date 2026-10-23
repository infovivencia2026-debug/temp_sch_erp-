import { useId, useState } from 'react'
import { Languages } from 'lucide-react'
import { Button } from '@/components/ui'
import { aiApi, AiLabel, type Lang } from './aiApi'
import { AiOffNote, isAiKeyError, useAiStatus, useMarkAiOff } from './useAiStatus'

/* "Translate" for a notice: Telugu or Hindi, shown beside the original, which
   is kept. onUse receives the translation to append or place in the editor;
   the screen decides, and nothing is published by this. */
export default function TranslateNotice({ title, text, onUse }: {
  title?: string
  text: string
  /** Gets the translated title and text, plus a combined bilingual body (original first). */
  onUse?: (t: { title: string; text: string; bilingual: string; language: Lang }) => void
}) {
  const [busy, setBusy] = useState<Lang | null>(null)
  const [out, setOut] = useState<{ language: Lang; title: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ai = useAiStatus()
  const markOff = useMarkAiOff()
  const offId = useId()
  const run = async (language: Lang) => {
    setBusy(language); setError(null)
    try {
      const r = await aiApi.translate({ title, text, language })
      if (!r.configured || !r.translated) { setError(r.message ?? 'Translation is not available.'); return }
      setOut({ language, ...r.translated })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not translate just now.')
      if (isAiKeyError(e)) markOff()
    } finally { setBusy(null) }
  }
  const disabled = text.trim() === '' || !ai.ok
  const described = ai.ok ? undefined : offId
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Languages className="h-4 w-4 text-muted-foreground" aria-hidden />
        <Button size="sm" variant="outline" disabled={disabled} ariaDescribedBy={described} pending={busy === 'te'} onClick={() => run('te')}>Translate to Telugu</Button>
        <Button size="sm" variant="outline" disabled={disabled} ariaDescribedBy={described} pending={busy === 'hi'} onClick={() => run('hi')}>Translate to Hindi</Button>
      </div>
      <AiOffNote id={offId} reason={ai.reason} />
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {out && (
        <div className="rounded-md border p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <AiLabel text="AI translation" />
            {onUse && (
              <Button size="sm" variant="secondary" onClick={() => onUse({
                title: out.title, text: out.text, language: out.language,
                bilingual: `${text}\n\n---\n\n${out.title ? out.title + '\n' : ''}${out.text}`,
              })}>Add below the original</Button>
            )}
          </div>
          {out.title && <p className="text-sm font-semibold">{out.title}</p>}
          <p className="whitespace-pre-wrap text-sm">{out.text}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">The original stays as written. Have a fluent reader check the translation before it goes out.</p>
        </div>
      )}
    </div>
  )
}
