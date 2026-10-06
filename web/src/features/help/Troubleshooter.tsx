import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Card, CardHeader, ErrorState, Field, FormNotice, Input, Loading } from '@/components/ui'
import { useCan } from '@/lib/session'
import { useI18n } from '@/lib/i18n'

/* Runs one of the server's checks (worker/src/routes/help/troubleshoot.ts)
   on a topic page and lists what it found. What it found is kept for the
   report form, so a request sent afterwards carries it. */

interface Check { check: string; ok: boolean; detail: string; fix?: { action: string; label: string } }
interface Result { key: string; title: string; about: string; checks: Check[] }

const ASK_OTHERS: Record<string, { perm: string; param: string; label: string; hint: string }> = {
  sign_in: { perm: 'access.users.read', param: 'who', label: 'Someone else in the school', hint: 'Their email, phone or username. Leave empty to check your own account.' },
  messages: { perm: 'access.users.read', param: 'who', label: 'Someone else in the school', hint: 'Their email, phone or username. Leave empty to check your own account.' },
  fee_receipt: { perm: 'finance.invoices.read', param: 'receipt', label: 'Receipt number', hint: 'Leave empty to check your own children.' },
}

export function Troubleshooter({ kind, from }: { kind: string; from?: string }) {
  const { t } = useI18n()
  const can = useCan()
  const other = ASK_OTHERS[kind] && can(ASK_OTHERS[kind].perm) ? ASK_OTHERS[kind] : null
  const [value, setValue] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const query: Record<string, string> = {}
  if (other && asked) query[other.param] = asked
  if (kind === 'screen' && from) query.route = from
  const q = useQuery({
    queryKey: ['help', 'troubleshoot', kind, query],
    queryFn: async () => {
      const r = await api.get<Result>(`/api/v1/help/troubleshoot/${kind}?${new URLSearchParams(query)}`)
      try { sessionStorage.setItem('help.checks', JSON.stringify(r.checks.map(({ check, ok, detail }) => ({ check, ok, detail })))) } catch { /* private mode */ }
      return r
    },
    enabled: asked !== null && (kind !== 'screen' || !!from),
    staleTime: 0,
  })
  const fix = useMutation({
    mutationFn: (action: string) => api.post('/api/v1/help/troubleshoot/sign_in/fix', { who: asked, action }),
    onSuccess: () => q.refetch(),
  })
  if (kind === 'screen' && !from) return null
  return (
    <Card>
      <CardHeader title="Check it for me" />
      <div className="space-y-3 p-[var(--card-pad)]">
        {other && (
          <Field label={other.label} hint={other.hint}>
            <Input value={value} onChange={setValue} />
          </Field>
        )}
        <Button variant="secondary" onClick={() => setAsked(value.trim())} pending={q.isFetching}>{asked === null ? 'Run the checks' : 'Run again'}</Button>
        {q.error ? <ErrorState error={q.error} /> : q.isFetching && !q.data ? <Loading /> : q.data && (
          <ul className="space-y-2" aria-label={q.data.title}>
            {q.data.checks.map((c, i) => (
              <li key={i} className="flex gap-2.5 text-[14px]">
                {c.ok ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="OK" />
                  : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label="Needs attention" />}
                <div className="min-w-0">
                  <p className="font-medium">{c.check}</p>
                  <p className="text-muted-foreground">{c.detail}</p>
                  {c.fix && <Button size="sm" variant="secondary" className="mt-1.5" pending={fix.isPending} onClick={() => fix.mutate(c.fix!.action)}>{c.fix.label}</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
        <FormNotice error={fix.error} />
        {q.data && <p className="text-[13px] text-muted-foreground">{t('help.still_stuck')} {t('help.report')}: what was found is sent with it.</p>}
      </div>
    </Card>
  )
}
