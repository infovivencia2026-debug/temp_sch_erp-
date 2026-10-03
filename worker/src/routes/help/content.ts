import type { Env } from '../../env'

/* HELP CONTENT, WRITTEN ONCE FOR EVERY SCHOOL.

   Categories, the SLA policy, help articles, tips and canned replies are the
   same in every school, so they are not copied into each school's database.
   The defaults ship in code (this file and content_articles.ts); CONTROL
   .help_content holds what the desk changed: a row with the same kind and key
   replaces the default, a row with a new key adds one, and status 'hidden'
   takes one away. Two support people edit one row and ten schools read it.

   Read through contentOf(), which keeps the merged list for a minute per
   isolate: content changes a few times a month and is read on every Help
   Centre visit. */

export type ContentKind = 'category' | 'sla' | 'article' | 'tip' | 'canned'

export interface HelpCategory {
  key: string
  label: string
  label_te?: string
  /** What to write, shown under the box. */
  hint: string
  hint_te?: string
  /** Roles that are offered it; empty means everyone. */
  roles: string[]
  /** The troubleshooter offered before the form, if any (step 3). */
  troubleshooter?: string
  sort: number
}

export interface SlaPolicy {
  key: string
  /** Hours to the first reply and to the answer, for the school's own helpdesk. */
  respond_hours: number
  resolve_hours: number
  /** The vendor's promise in hours by plan tier (rows) and urgency (urgent, high, normal, low). */
  vendor_hours?: number[][]
}

const STAFF = ['institution_admin', 'super_admin', 'admissions', 'front_office', 'finance', 'hr', 'hod', 'faculty', 'librarian', 'transport_manager']

export const DEFAULT_CATEGORIES: HelpCategory[] = [
  { key: 'sign_in', label: 'Signing in and passwords', label_te: 'సైన్ ఇన్ మరియు పాస్‌వర్డ్', roles: [], sort: 10, troubleshooter: 'sign_in',
    hint: 'Say who cannot sign in and what the sign-in page says.', hint_te: 'ఎవరు సైన్ ఇన్ చేయలేకపోతున్నారో, సైన్ ఇన్ పేజీ ఏమి చెబుతోందో రాయండి.' },
  { key: 'fees', label: 'Fees and receipts', label_te: 'ఫీజులు మరియు రసీదులు', roles: [], sort: 20, troubleshooter: 'fee_receipt',
    hint: 'Give the receipt number or the date and amount paid.', hint_te: 'రసీదు నంబర్ లేదా చెల్లించిన తేదీ, మొత్తం రాయండి.' },
  { key: 'attendance', label: 'Attendance', label_te: 'హాజరు', roles: [], sort: 30, troubleshooter: 'attendance',
    hint: 'Say which day and which class is wrong or missing.', hint_te: 'ఏ రోజు, ఏ తరగతి హాజరు తప్పుగా ఉందో లేదా కనిపించడం లేదో రాయండి.' },
  { key: 'messages', label: 'Messages and notices', label_te: 'సందేశాలు మరియు నోటీసులు', roles: [], sort: 40, troubleshooter: 'messages',
    hint: 'Say which message did not arrive and when it was sent.', hint_te: 'ఏ సందేశం రాలేదో, అది ఎప్పుడు పంపబడిందో రాయండి.' },
  { key: 'marks', label: 'Marks and report cards', label_te: 'మార్కులు మరియు రిపోర్ట్ కార్డులు', roles: [], sort: 50,
    hint: 'Name the exam and the subject.', hint_te: 'పరీక్ష పేరు, సబ్జెక్ట్ రాయండి.' },
  { key: 'screen', label: 'A screen is missing or will not open', label_te: 'ఒక స్క్రీన్ కనిపించడం లేదు లేదా తెరుచుకోవడం లేదు', roles: [], sort: 60, troubleshooter: 'screen',
    hint: 'Name the screen and what happens when you open it.', hint_te: 'స్క్రీన్ పేరు, దాన్ని తెరిచినప్పుడు ఏమి జరుగుతుందో రాయండి.' },
  { key: 'wrong_data', label: 'Something shown is wrong', label_te: 'చూపిస్తున్న సమాచారం తప్పుగా ఉంది', roles: [], sort: 70,
    hint: 'Say what is shown and what it should be.', hint_te: 'ఏమి చూపిస్తోందో, ఏమి ఉండాలో రాయండి.' },
  { key: 'slow', label: 'The app is slow or stuck', label_te: 'యాప్ నెమ్మదిగా ఉంది లేదా ఆగిపోయింది', roles: [], sort: 80,
    hint: 'Say which screen, and whether it is on phone data or Wi-Fi.', hint_te: 'ఏ స్క్రీన్‌లో, మొబైల్ డేటాలోనా లేదా వై-ఫైలోనా అని రాయండి.' },
  { key: 'setup', label: 'Setting up the school', roles: STAFF, sort: 90,
    hint: 'Say which setup step and what you were entering.' },
  { key: 'billing', label: 'Our plan and bill', roles: ['institution_admin', 'super_admin'], sort: 100,
    hint: 'Give the invoice number or the month.' },
  { key: 'other', label: 'Something else', label_te: 'ఇంకేదైనా', roles: [], sort: 999,
    hint: 'Describe what you were doing and what happened.', hint_te: 'మీరు ఏమి చేస్తున్నారో, ఏమి జరిగిందో రాయండి.' },
]

/* The school's own helpdesk: a first reply within a working day, an answer
   within two. The vendor's promise by plan and urgency is the table the queue
   has always used (seller/tenants.ts promisedHours); kept here so the desk can
   change it without a release. */
export const DEFAULT_SLA: SlaPolicy[] = [
  { key: 'policy', respond_hours: 8, resolve_hours: 48,
    vendor_hours: [[1, 4, 8, 24], [4, 8, 24, 48], [8, 24, 48, 72], [24, 48, 72, 120]] },
]

const DEFAULTS: Partial<Record<ContentKind, { key: string }[]>> = {
  category: DEFAULT_CATEGORIES,
  sla: DEFAULT_SLA,
}

/** Other files add their defaults here at import (content_articles.ts). */
export function registerDefaults(kind: ContentKind, rows: { key: string }[]): void {
  DEFAULTS[kind] = rows
}

interface Row { kind: string; key: string; data: string; status: string; updated_at: string; updated_by_name: string | null }

const TTL_MS = 60_000
let cache: { at: number; rows: Row[] } | null = null

async function overrides(env: Env): Promise<Row[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows
  let rows: Row[] = []
  try {
    rows = (await env.CONTROL.prepare(`SELECT kind, key, data, status, updated_at, updated_by_name FROM help_content`).all<Row>()).results ?? []
  } catch (e) {
    // A CONTROL that predates migration 0020 serves the shipped defaults.
    if (!/no such table/.test(String(e))) throw e
  }
  cache = { at: Date.now(), rows }
  return rows
}

/** Dropped after a write at the desk, so the editor reads its own change. */
export function forgetContent(): void { cache = null }

export interface ContentEntry<T> { item: T; source: 'default' | 'edited' | 'added'; hidden: boolean; updated_at?: string; updated_by?: string }

/** Every entry of a kind with where it came from: the desk's editor reads this. */
export async function contentEntries<T extends { key: string }>(env: Env, kind: ContentKind): Promise<ContentEntry<T>[]> {
  const rows = (await overrides(env)).filter((r) => r.kind === kind)
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const out: ContentEntry<T>[] = []
  for (const d of (DEFAULTS[kind] ?? []) as T[]) {
    const r = byKey.get(d.key)
    byKey.delete(d.key)
    if (!r) { out.push({ item: d, source: 'default', hidden: false }); continue }
    let item = d
    try { item = { ...d, ...(JSON.parse(r.data) as object), key: d.key } as T } catch { /* a broken row leaves the default */ }
    out.push({ item, source: 'edited', hidden: r.status === 'hidden', updated_at: r.updated_at, updated_by: r.updated_by_name ?? undefined })
  }
  for (const r of byKey.values()) {
    try {
      out.push({ item: { ...(JSON.parse(r.data) as object), key: r.key } as T, source: 'added', hidden: r.status === 'hidden',
        updated_at: r.updated_at, updated_by: r.updated_by_name ?? undefined })
    } catch { /* skip a row that is not JSON */ }
  }
  return out
}

/** What people are shown: defaults with the desk's edits applied, hidden ones gone. */
export async function contentOf<T extends { key: string }>(env: Env, kind: ContentKind): Promise<T[]> {
  return (await contentEntries<T>(env, kind)).filter((e) => !e.hidden).map((e) => e.item)
}

export async function categoriesFor(env: Env, roles: string[]): Promise<HelpCategory[]> {
  const all = await contentOf<HelpCategory>(env, 'category')
  return all.filter((c) => !c.roles?.length || c.roles.some((r) => roles.includes(r))).sort((a, b) => (a.sort ?? 500) - (b.sort ?? 500))
}

export async function slaPolicy(env: Env): Promise<SlaPolicy> {
  const p = (await contentOf<SlaPolicy>(env, 'sla')).find((x) => x.key === 'policy') ?? DEFAULT_SLA[0]
  return { ...DEFAULT_SLA[0], ...p }
}

/** The vendor's promised hours for a plan and an urgency, from the policy the desk keeps. */
export function vendorHours(policy: SlaPolicy, planCode: string, priority: string): number {
  const table = policy.vendor_hours && policy.vendor_hours.length === 4 ? policy.vendor_hours : DEFAULT_SLA[0].vendor_hours!
  let tier = 3
  switch (planCode.toLowerCase()) {
    case 'enterprise': case 'ent': tier = 0; break
    case 'pro': case 'campus_pro': case 'premium': tier = 1; break
    case 'basic': case 'standard': case 'starter': tier = 2; break
  }
  let col = 2
  switch (priority.toLowerCase()) { case 'urgent': col = 0; break; case 'high': col = 1; break; case 'low': col = 3; break }
  const h = Number(table[tier]?.[col])
  return h > 0 ? h : DEFAULT_SLA[0].vendor_hours![tier][col]
}

/** `label`/`hint` in the reader's language where the content carries one. */
export function localise<T extends Record<string, unknown>>(item: T, lang: string): T {
  if (lang === 'en') return item
  const out: Record<string, unknown> = { ...item }
  for (const k of Object.keys(item)) {
    const v = item[`${k}_${lang}`]
    if (typeof v === 'string' && v.trim() !== '') out[k] = v
  }
  return out as T
}
