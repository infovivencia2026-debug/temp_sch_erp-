import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, FileText, LayoutGrid, MessageSquare, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, Button, Badge, Field, FormGrid, FormNotice, Input, Select, Textarea, Checkbox,
  EmptyState, ErrorState, Loading, tabClass, TAB_BAR,
} from '@/components/ui'
import { ChatThread, type ChatMessage } from '@/components/Chat'
import { ConversationPane } from '@/components/ChatScreen'
import { useSession } from '@/lib/session'
import { useCan } from '@/lib/session'
import { useI18n } from '@/lib/i18n'
import { useResolvedRole, usable, featurePath } from '@/lib/catalog'
import { buildIndex, rank, fold, type SearchDoc } from '@/lib/search/feature-search'
import { collectDiagnostics, lastErrorRef } from '@/lib/diagnostics'
import { formatDate, cn } from '@/lib/utils'
import { buzz } from '@/lib/haptics'
import { useToast } from '@/components/Toast'
import { REF_IN_TEXT } from '@/components/CopyRef'
import type {
  HelpArticleView, HelpCategoryOption, HelpDiagnostics, HelpRequestDetail, HelpSimilar, HelpTicket, HelpTipView, HelpFollowed,
} from '@shared/api/feature_helpdesk'
import type { List } from '@shared/api/contract'
import { Redact, type RedactedImage } from './Redact'
import { showMe } from './Spotlight'
import { Troubleshooter } from './Troubleshooter'
import { AssistCard } from './Assist'
import { STAGE_KEY, STAGE_TONE, articleBlocks, shownStage } from './help-lib'

/* THE HELP CENTRE, for every person of a school.

   Shaped after the help a phone and a desktop already give: one question at
   the top ("How can we help?") that searches help articles, the screens this
   person can open and their own requests at once; topics for the role, each
   opening on its likely fixes; the requests already sent, as conversations;
   and a short "What's new" that can be put away.

   One page, four views, chosen by the address so Back works on a phone:
     /help                      home
     /help?topic=<category>     a topic: likely fixes, then Report a problem
     /help?report=1             the form (with &topic= to preselect)
     /help?request=<id>         one request as a conversation
     /help?tab=requests         every request
   `from` carries the screen Help was opened from, for the report. */

type Q = Record<string, string>

export default function HelpCentre() {
  const [params, setParams] = useSearchParams()
  const p = Object.fromEntries(params.entries()) as Q
  const go = (next: Q, replace = false) => {
    const keep: Q = p.from ? { from: p.from } : {}
    setParams({ ...keep, ...next }, { replace })
  }
  const { locale, t } = useI18n()
  const session = useSession()
  const school = session.institution?.display_name || session.institution?.name || ''
  const isDesk = useCan()('help.desk.write')

  const cats = useQuery({ queryKey: ['help', 'categories', locale], queryFn: () => api.call('GET /help/categories', { query: { lang: locale } }) })
  const articles = useQuery({ queryKey: ['help', 'articles'], queryFn: () => api.call('GET /help/articles') })
  const mine = useQuery({ queryKey: ['help', 'requests'], queryFn: () => api.call('GET /help/requests'), staleTime: 0 })

  const view = p.request ? 'request' : p.report ? 'report' : p.topic ? 'topic' : p.tab === 'requests' ? 'requests' : 'home'

  return (
    <>
      <PageHead eyebrow={school ? `${school} · ${t('help.eyebrow')}` : t('help.eyebrow')} title={view === 'report' ? t('help.report') : t('help.title')} width={view === 'request' ? 'operational' : 'form'} />
      <PageBody width={view === 'request' ? 'operational' : 'form'}>
        {(view === 'home' || view === 'requests') && (
          <nav className={TAB_BAR} aria-label={t('help.eyebrow')}>
            <button type="button" className={tabClass(view === 'home')} aria-current={view === 'home' ? 'page' : undefined} onClick={() => go({})}>{t('help.tab.home')}</button>
            <button type="button" className={tabClass(view === 'requests')} aria-current={view === 'requests' ? 'page' : undefined} onClick={() => go({ tab: 'requests' })}>
              {t('help.tab.requests')}
              {!!mine.data?.items.filter((r) => r.last_reply_side && r.last_reply_side !== 'raiser' && r.stage !== 'closed').length && (
                <Badge tone="primary">{mine.data.items.filter((r) => r.last_reply_side && r.last_reply_side !== 'raiser' && r.stage !== 'closed').length}</Badge>
              )}
            </button>
            {isDesk && <Link to="/go/help/helpdesk" className={tabClass(false)}>{t('help.helpdesk')}</Link>}
          </nav>
        )}
        {view === 'home' && (
          <Home cats={cats.data?.items ?? []} articles={articles.data?.items ?? []} requests={mine.data?.items ?? []}
            onTopic={(k) => go({ topic: k })} onRequest={(id) => go({ request: id })} onReport={() => go({ report: '1' })}
            onAll={() => go({ tab: 'requests' })} />
        )}
        {view === 'topic' && (
          <Topic cat={cats.data?.items.find((c) => c.key === p.topic)} articles={(articles.data?.items ?? []).filter((a) => a.topic === p.topic)}
            from={p.from} onBack={() => go({}, true)} onReport={() => go({ report: '1', topic: p.topic })} />
        )}
        {view === 'report' && (
          <Report cats={cats.data?.items ?? []} initialTopic={p.topic} from={p.from} school={school} toVendor={isDesk}
            onBack={() => go(p.topic ? { topic: p.topic } : {}, true)} onSent={(id) => go({ request: id }, true)} />
        )}
        {view === 'requests' && (
          <Requests error={mine.error} loading={mine.isLoading} items={mine.data?.items ?? []} following={mine.data?.following ?? []} cats={cats.data?.items ?? []}
            school={school} onOpen={(id) => go({ tab: 'requests', request: id })} onReport={() => go({ report: '1' })} />
        )}
        {view === 'request' && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
            <Requests error={mine.error} loading={mine.isLoading} items={mine.data?.items ?? []} following={mine.data?.following ?? []} cats={cats.data?.items ?? []}
              school={school} onOpen={(id) => go({ tab: 'requests', request: id })} onReport={() => go({ report: '1' })} active={p.request} />
            <RequestThread id={p.request} school={school} cats={cats.data?.items ?? []} onClose={() => go({ tab: 'requests' }, true)} />
          </div>
        )}
      </PageBody>
    </>
  )
}

// --- home ----------------------------------------------------------------------

function useScreens(): (SearchDoc & { path: string })[] {
  const { role } = useResolvedRole()
  return useMemo(() => {
    const out: (SearchDoc & { path: string })[] = []
    for (const s of role?.sections ?? []) for (const f of s.features) {
      if (!usable(f)) continue
      out.push({ key: f.key, name: f.name, slug: f.slug, section: s.name, workspace: s.workspace || '', summary: f.summary ?? '', path: featurePath(role!.key, s.slug, f.slug) })
    }
    return out
  }, [role])
}

function Home({ cats, articles, requests, onTopic, onRequest, onReport, onAll }: {
  cats: HelpCategoryOption[]; articles: HelpArticleView[]; requests: HelpTicket[]
  onTopic: (k: string) => void; onRequest: (id: string) => void; onReport: () => void; onAll: () => void
}) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const screens = useScreens()
  const screenIndex = useMemo(() => buildIndex(screens), [screens])
  const articleIndex = useMemo(() => buildIndex(articles.map((a) => ({ key: a.key, name: a.title, slug: a.key, section: a.topic, workspace: '', summary: `${a.keywords ?? ''} ${a.body}` }))), [articles])
  const needle = fold(q).trim()
  const hits = needle ? {
    articles: rank(articleIndex, q, { limit: 5 }).map((h) => articles.find((a) => a.key === h.doc.key)!).filter(Boolean),
    screens: rank(screenIndex, q, { limit: 5 }).map((h) => h.doc as SearchDoc & { path: string }),
    requests: requests.filter((r) => fold(r.subject).includes(needle)).slice(0, 5),
  } : null
  const open = requests.filter((r) => r.stage !== 'resolved' && r.stage !== 'closed')

  return (
    <div className="space-y-5">
      <div data-help-anchor="help-search">
        <Input value={q} onChange={setQ} type="search" srLabel={t('help.search_label')} placeholder={t('help.search_placeholder')} autoFocus />
      </div>

      {hits ? (
        <SearchResults hits={hits} onRequest={onRequest} onReport={onReport} />
      ) : (
        <>
          <section aria-labelledby="help-topics">
            <h2 id="help-topics" className="mb-2 text-[13px] font-semibold text-muted-foreground">{t('help.topics')}</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {cats.map((c) => (
                <button key={c.key} type="button" onClick={() => onTopic(c.key)}
                  className="card flex min-h-[44px] items-center justify-between gap-3 px-4 py-3 text-left text-[15px] font-medium hover:bg-surface-hover">
                  <span className="min-w-0 truncate">{c.label}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>

          {open.length > 0 && (
            <Card>
              <CardHeader title={t('help.your_requests')} action={<Button variant="ghost" size="sm" onClick={onAll}>{t('help.all_requests')}</Button>} />
              <ul className="divide-y">
                {open.slice(0, 3).map((r) => <RequestRow key={r.id} r={r} onOpen={() => onRequest(r.id)} />)}
              </ul>
            </Card>
          )}

          <Tips />
          <AssistCard />

          <div className="flex justify-center pb-2">
            <span data-help-anchor="help-report"><Button onClick={onReport}>{t('help.report')}</Button></span>
          </div>
        </>
      )}
    </div>
  )
}

function SearchResults({ hits, onRequest, onReport }: {
  hits: { articles: HelpArticleView[]; screens: (SearchDoc & { path: string })[]; requests: HelpTicket[] }
  onRequest: (id: string) => void; onReport: () => void
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const none = !hits.articles.length && !hits.screens.length && !hits.requests.length
  if (none) {
    return <EmptyState title={t('help.no_results')} action={<Button onClick={onReport}>{t('help.report')}</Button>} />
  }
  return (
    <div className="space-y-4">
      {hits.articles.length > 0 && (
        <Card>
          <CardHeader title={t('help.results_articles')} />
          <ul className="divide-y">
            {hits.articles.map((a) => (
              <li key={a.key}>
                <ArticleRow a={a} open={openKey === a.key} onToggle={() => setOpenKey(openKey === a.key ? null : a.key)} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      {hits.screens.length > 0 && (
        <Card>
          <CardHeader title={t('help.results_screens')} />
          <ul className="divide-y">
            {hits.screens.map((s) => (
              <li key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-[var(--card-pad)] py-3">
                <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="truncate text-[12px] text-muted-foreground">{s.section}</div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="secondary" size="sm" onClick={() => { navigate(s.path); showMe('page-title', s.name) }}>{t('help.show_me')}</Button>
                  <Button variant="ghost" size="sm" onClick={() => navigate(s.path)}>{t('help.open')}</Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {hits.requests.length > 0 && (
        <Card>
          <CardHeader title={t('help.results_requests')} />
          <ul className="divide-y">{hits.requests.map((r) => <RequestRow key={r.id} r={r} onOpen={() => onRequest(r.id)} />)}</ul>
        </Card>
      )}
    </div>
  )
}

function ArticleRow({ a, open, onToggle }: { a: HelpArticleView; open: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="flex min-h-[44px] w-full items-center gap-3 px-[var(--card-pad)] py-3 text-left hover:bg-surface-hover">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-medium">{a.title}</span>
        <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
      </button>
      {open && (
        <div className="space-y-2 px-[var(--card-pad)] pb-4 text-[14px] leading-relaxed">
          {(() => {
            const blocks = articleBlocks(a.body)
            let n = 0
            return blocks.map((b, i) => b.kind === 'step'
              ? <p key={i} className="flex gap-2"><span className="w-5 shrink-0 font-semibold tabular-nums">{++n}.</span><span>{b.text}</span></p>
              : <p key={i} className="text-secondary-foreground">{b.text}</p>)
          })()}
          {(a.route || a.anchor) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {a.anchor && (
                <Button variant="secondary" size="sm" onClick={() => { if (a.route) navigate(a.route); showMe(a.anchor!, a.title) }}>{t('help.show_me')}</Button>
              )}
              {a.route && <Button variant="ghost" size="sm" onClick={() => navigate(a.route!)}>{t('help.open')}</Button>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Tips() {
  const { t, locale } = useI18n()
  const qc = useQueryClient()
  const tips = useQuery({ queryKey: ['help', 'tips', locale], queryFn: () => api.call('GET /help/tips', { query: { lang: locale } }) })
  const desktop = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches
  const away = useMutation({
    mutationFn: (key: string) => api.call('POST /help/tips/{key}/dismiss', { params: { key } }),
    onMutate: (key) => {
      qc.setQueryData<List<HelpTipView>>(['help', 'tips', locale], (old) => old && { items: old.items.filter((x) => x.key !== key) })
    },
    onError: () => qc.invalidateQueries({ queryKey: ['help', 'tips'] }),
  })
  const items = (tips.data?.items ?? []).filter((x) => !x.device || (x.device === 'desktop') === desktop).slice(0, 3)
  if (!items.length) return null
  return (
    <section aria-labelledby="help-new">
      <h2 id="help-new" className="mb-2 text-[13px] font-semibold text-muted-foreground">{t('help.whats_new')}</h2>
      <div className="space-y-2">
        {items.map((x) => (
          <div key={x.key} className="card flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{x.title}</p>
              <p className="mt-0.5 text-[14px] text-muted-foreground">{x.body}</p>
            </div>
            <Button variant="ghost" size="sm" title={t('help.dismiss_tip')} onClick={() => away.mutate(x.key)}>
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
    </section>
  )
}

// --- topic ---------------------------------------------------------------------

function Topic({ cat, articles, from, onBack, onReport }: { cat?: HelpCategoryOption; articles: HelpArticleView[]; from?: string; onBack: () => void; onReport: () => void }) {
  const { t } = useI18n()
  const [openKey, setOpenKey] = useState<string | null>(articles.length === 1 ? articles[0].key : null)
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}><ChevronLeft className="h-4 w-4" aria-hidden="true" />{t('help.back')}</Button>
        <h2 className="min-w-0 truncate text-[17px] font-semibold">{cat?.label ?? ''}</h2>
      </div>
      <Card>
        <CardHeader title={t('help.likely_fixes')} />
        {articles.length ? (
          <ul className="divide-y">
            {articles.map((a) => <li key={a.key}><ArticleRow a={a} open={openKey === a.key} onToggle={() => setOpenKey(openKey === a.key ? null : a.key)} /></li>)}
          </ul>
        ) : (
          <p className="px-[var(--card-pad)] py-4 text-[14px] text-muted-foreground">{t('help.no_fixes')}</p>
        )}
      </Card>
      {cat?.troubleshooter && <Troubleshooter kind={cat.troubleshooter} from={from} />}
      <Card className="flex flex-wrap items-center justify-between gap-3 px-[var(--card-pad)] py-4">
        <p className="font-medium">{t('help.still_stuck')}</p>
        <Button onClick={onReport}>{t('help.report')}</Button>
      </Card>
    </div>
  )
}

// --- report a problem ------------------------------------------------------------

function Report({ cats, initialTopic, from, school, toVendor, onBack, onSent }: {
  cats: HelpCategoryOption[]; initialTopic?: string; from?: string; school: string; toVendor: boolean
  onBack: () => void; onSent: (id: string) => void
}) {
  const { t, locale } = useI18n()
  const qc = useQueryClient()
  const toast = useToast()
  const { role } = useResolvedRole()
  const [category, setCategory] = useState(initialTopic ?? '')
  const [body, setBody] = useState(() => sessionStorage.getItem('help.draft') ?? '')
  const [urgent, setUrgent] = useState(false)
  const [ref, setRef] = useState(() => lastErrorRef() ?? '')
  const [shot, setShot] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [redacted, setRedacted] = useState<RedactedImage | null>(null)
  const route = from && from.startsWith('/') ? from : undefined
  /* The conversation the assistant handed over with "This didn't help" (components/AssistantTab.tsx). */
  const [conversation] = useState<HelpDiagnostics['conversation']>(() => {
    try { const v = sessionStorage.getItem('help.conversation'); return v ? JSON.parse(v) : undefined } catch { return undefined }
  })
  const [checks] = useState<HelpDiagnostics['checks']>(() => {
    try { const v = sessionStorage.getItem('help.checks'); return v ? JSON.parse(v) : undefined } catch { return undefined }
  })
  const diag = useMemo(() => ({ ...collectDiagnostics(route ?? '/help', role?.key, locale), conversation, checks }), [route, role?.key, locale, conversation, checks])
  useEffect(() => { try { sessionStorage.setItem('help.draft', body) } catch { /* private mode */ } }, [body])
  useEffect(() => { if (!category && cats.length) setCategory('') }, [cats, category])

  const similar = useQuery({
    queryKey: ['help', 'similar', category, route],
    queryFn: () => api.call('GET /help/similar', { query: { category, route } }),
    enabled: !!category,
  })
  const meToo = useMutation({
    mutationFn: (id: string) => api.call('POST /help/requests/{id}/me-too', { params: { id } }),
    onSuccess: () => { buzz('tap'); qc.invalidateQueries({ queryKey: ['help', 'requests'] }); qc.invalidateQueries({ queryKey: ['help', 'similar'] }) },
  })

  const send = useMutation({
    mutationFn: async () => {
      let attachment: string | undefined
      if (redacted) {
        const form = new FormData()
        form.append('file', new File([redacted.blob], redacted.name, { type: 'image/png' }))
        form.append('purpose', 'help_screenshot')
        const res = await fetch('/api/v1/files', { method: 'POST', body: form, credentials: 'same-origin' })
        const j = await res.json().catch(() => ({}))
        if (!res.ok) throw new ApiError(res.status, j.code ?? 'upload', j.error ?? 'The screenshot could not be uploaded.')
        attachment = j.file_id
      }
      return api.call('POST /help/requests', { body: {
        category, body, urgent, route, role: role?.key, error_ref: ref.trim() || undefined, attachment_file_id: attachment, diagnostics: diag,
      } })
    },
    onSuccess: (r) => {
      buzz('tap')
      try { sessionStorage.removeItem('help.draft'); sessionStorage.removeItem('help.conversation'); sessionStorage.removeItem('help.checks') } catch { /* private mode */ }
      toast.ok(t('help.sent'))
      qc.invalidateQueries({ queryKey: ['help', 'requests'] })
      onSent(r.id)
    },
  })

  const cat = cats.find((c) => c.key === category)
  const s: HelpSimilar | undefined = similar.data
  const diagRows: [string, string | undefined][] = [
    ['Screen', diag.route], ['Role', role?.name], ['School', school], ['Layout and theme', [diag.layout, diag.theme].filter(Boolean).join(', ')],
    ['App version', diag.app_version], ['Browser', [diag.browser, diag.os].filter(Boolean).join(' on ')], ['Screen size', diag.viewport],
    ['Connection', diag.online ? 'Online' : 'Offline'],
    ['Last failed request', diag.last_failed ? `${diag.last_failed.path} (${diag.last_failed.status})${diag.last_failed.ref ? `, Ref: ${diag.last_failed.ref}` : ''}` : undefined],
    ['Errors on this page', diag.client_errors?.join('; ')],
    ['Assistant conversation', conversation?.length ? `${conversation.length} messages` : undefined],
    ['Checks run', checks?.length ? checks.map((c) => `${c.ok ? 'OK' : 'Problem'}: ${c.check}`).join('; ') : undefined],
  ]

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}><ChevronLeft className="h-4 w-4" aria-hidden="true" />{t('help.back')}</Button>
      <p className="text-[14px] text-muted-foreground">{toVendor ? t('help.report_lead_vendor') : t('help.report_lead', { school })}</p>
      <Card className="space-y-5 p-[var(--card-pad)]">
        <FormGrid>
          <Field label={t('help.topic_label')} required wide>
            <Select value={category} onChange={setCategory} options={cats.map((c) => ({ value: c.key, label: c.label }))} />
          </Field>
        </FormGrid>

        {s && s.count > 0 && s.ticket_id && (
          <div className="rounded-md bg-muted px-3 py-3 text-[14px]">
            <p>{t('help.similar', { count: s.count })}</p>
            {s.already_following || meToo.data ? (
              <p className="mt-1 text-muted-foreground">{meToo.data ? t('help.me_too_done') : t('help.me_too_already')}</p>
            ) : (
              <div className="mt-2"><Button variant="secondary" size="sm" pending={meToo.isPending} onClick={() => meToo.mutate(s.ticket_id!)}>{t('help.me_too')}</Button></div>
            )}
            <FormNotice error={meToo.error} />
          </div>
        )}

        <FormGrid>
          <Field label={t('help.what_happened')} hint={cat?.hint} required wide>
            <Textarea value={body} onChange={setBody} rows={4} aria-label={t('help.what_happened')} />
          </Field>
          <Field label={t('help.ref_label')} hint={t('help.ref_hint')}>
            <Input value={ref} onChange={(v) => setRef(v.toUpperCase().replace(REF_IN_TEXT, '$1').slice(0, 6))} placeholder="K7Q2X9" />
          </Field>
        </FormGrid>
        <Checkbox checked={urgent} onChange={setUrgent} label={t('help.urgent')} hint={t('help.urgent_hint')} />

        <div className="space-y-2">
          <p className="text-[13px] font-medium text-secondary-foreground">{t('help.screenshot')}</p>
          {shot ? (
            <>
              <Redact file={shot} onChange={setRedacted} />
              <Button variant="ghost" size="sm" onClick={() => { setShot(null); setRedacted(null) }}>{t('help.remove')}</Button>
            </>
          ) : (
            <>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-hidden="true"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) setShot(f); e.target.value = '' }} />
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>{t('help.add_screenshot')}</Button>
            </>
          )}
          {!shot && <p className="text-[13px] text-muted-foreground">{t('help.screenshot_hint')}</p>}
        </div>

        <details className="rounded-md bg-muted/60 px-3 py-2 text-[13px]">
          <summary className="cursor-pointer py-1 font-medium">{t('help.diag_title')}</summary>
          <p className="mb-2 text-muted-foreground">{t('help.diag_lead')}</p>
          <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
            {diagRows.filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>
            ))}
          </dl>
        </details>

        <FormNotice error={send.error} />
        <div className="flex justify-end">
          <Button disabled={!category || !body.trim()} pending={send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? t('help.sending') : t('help.send')}
          </Button>
        </div>
      </Card>
    </div>
  )
}

// --- requests ------------------------------------------------------------------

function RequestRow({ r, onOpen, active }: { r: HelpTicket; onOpen: () => void; active?: boolean }) {
  const { t } = useI18n()
  const stage = shownStage(r)
  const unread = r.last_reply_side && r.last_reply_side !== 'raiser' && r.stage !== 'closed'
  return (
    <li>
      <button type="button" onClick={onOpen} aria-current={active ? 'true' : undefined}
        className={cn('flex min-h-[44px] w-full items-center gap-3 px-[var(--card-pad)] py-3 text-left hover:bg-surface-hover', active && 'bg-surface-hover')}>
        <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className={cn('truncate', unread ? 'font-semibold' : 'font-medium')}>{r.subject}</div>
          <div className="truncate text-[12px] text-muted-foreground">{formatDate(r.last_reply_at ?? r.created_at)}</div>
        </div>
        <Badge tone={STAGE_TONE[stage] ?? 'neutral'}>{t(STAGE_KEY[stage] ?? 'help.stage.new')}</Badge>
      </button>
    </li>
  )
}

function Requests({ items, following, loading, error, onOpen, onReport, active }: {
  items: HelpTicket[]; following: HelpFollowed[]; loading: boolean; error: unknown; cats: HelpCategoryOption[]; school: string
  onOpen: (id: string) => void; onReport: () => void; active?: string
}) {
  const { t } = useI18n()
  if (error) return <ErrorState error={error} />
  if (loading) return <Loading />
  return (
    <div className="space-y-4">
      {items.length === 0 ? (
        <EmptyState title={t('help.no_requests')} body={t('help.no_requests_body')} action={<Button onClick={onReport}>{t('help.report')}</Button>} />
      ) : (
        <Card>
          <ul className="divide-y">{items.map((r) => <RequestRow key={r.id} r={r} active={r.id === active} onOpen={() => onOpen(r.id)} />)}</ul>
        </Card>
      )}
      {following.length > 0 && (
        <Card>
          <CardHeader title={t('help.following')} />
          <ul className="divide-y">
            {following.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 px-[var(--card-pad)] py-3 text-[14px]">
                <span className="text-muted-foreground">{formatDate(f.created_at)}</span>
                <Badge tone={STAGE_TONE[f.stage] ?? 'neutral'}>{t(STAGE_KEY[f.stage] ?? 'help.stage.new')}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function RequestThread({ id, school, cats, onClose }: { id: string; school: string; cats: HelpCategoryOption[]; onClose: () => void }) {
  const { t } = useI18n()
  const qc = useQueryClient()
  const key = ['help', 'request', id]
  const q = useQuery({ queryKey: key, queryFn: () => api.call('GET /help/requests/{id}', { params: { id } }), staleTime: 0, refetchInterval: 30_000 })
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['help', 'requests'] }) }
  const replyM = useMutation({ mutationFn: (body: string) => api.call('POST /help/requests/{id}/reply', { params: { id }, body: { body } }), onSuccess: refresh })
  const rate = useMutation({
    mutationFn: (helpful: boolean) => api.call('POST /help/requests/{id}/rating', { params: { id }, body: { helpful } }),
    onSuccess: () => { buzz('tap'); refresh() },
  })
  const [reason, setReason] = useState('')
  const reopen = useMutation({ mutationFn: () => api.call('POST /help/requests/{id}/reopen', { params: { id }, body: { reason } }), onSuccess: () => { setReason(''); refresh() } })

  const d: HelpRequestDetail | undefined = q.data
  const messages: ChatMessage[] = d ? [
    { id: 'first', body: d.body, at: d.created_at, mine: true },
    ...d.thread.map((e) => ({ id: e.id, body: e.body, at: e.created_at, mine: e.side === 'raiser', sender: e.side === 'raiser' ? undefined : e.author })),
  ] : []
  const settled = d && (d.status === 'resolved' || d.status === 'closed')
  const stage = d ? shownStage(d) : 'new'
  const cat = cats.find((c) => c.key === d?.category)

  return (
    <ConversationPane
      open
      title={<span>{d?.subject ?? ''}</span>}
      subtitle={d ? `${t(STAGE_KEY[stage] ?? 'help.stage.new')} · ${d.with === 'vendor' ? t('help.with_vendor') : t('help.with_school', { school })}${cat ? ` · ${cat.label}` : ''}` : undefined}
      onBack={onClose}
    >
      {q.error ? <div className="p-4"><ErrorState error={q.error} /></div> : (
        <>
          {d?.incident && (
            <div className="border-b bg-muted/60 px-4 py-3 text-[14px]">
              <p className="font-semibold">{t('help.known_issue')}: {d.incident.title}</p>
              <p className="mt-0.5">{d.incident.workaround}</p>
            </div>
          )}
          {d?.escalated && <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">{t('help.passed_on')}</p>}
          <ChatThread
            messages={messages}
            loading={q.isLoading}
            onSend={(m) => replyM.mutateAsync(m.body)}
            sending={replyM.isPending}
            error={replyM.error}
            canSend={!settled}
            cannotSendNote={t('help.closed_note')}
            placeholder={t('help.reply_placeholder')}
            allowAttachments={false}
            showSender
            height="min-h-[14rem] flex-1"
          />
          {d && settled && d.helpful === undefined && d.resolved_at && (
            <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
              <span className="mr-auto font-medium">{t('help.did_it_help')}</span>
              <Button variant="secondary" size="sm" pending={rate.isPending} onClick={() => rate.mutate(true)}>{t('help.yes')}</Button>
              <Button variant="secondary" size="sm" pending={rate.isPending} onClick={() => rate.mutate(false)}>{t('help.no')}</Button>
            </div>
          )}
          {d && settled && d.can_reopen && d.helpful !== true && (
            <div className="space-y-2 border-t px-4 py-3">
              <Field label={t('help.reopen_reason')}>
                <Textarea value={reason} onChange={setReason} rows={2} aria-label={t('help.reopen_reason')} />
              </Field>
              <div className="flex justify-end"><Button variant="secondary" size="sm" disabled={!reason.trim()} pending={reopen.isPending} onClick={() => reopen.mutate()}>{t('help.reopen')}</Button></div>
              <FormNotice error={reopen.error ?? rate.error} />
            </div>
          )}
          {d?.helpful === true && <p className="border-t px-4 py-3 text-[14px] text-muted-foreground">{t('help.thanks')}</p>}
        </>
      )}
    </ConversationPane>
  )
}
