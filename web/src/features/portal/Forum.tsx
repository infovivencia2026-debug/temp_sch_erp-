import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessagesSquare, Pin, Lock } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Table, Td, Badge, Button,
  ConfirmButton, Field, FormGrid, FormNotice, Input, Select, Textarea, Loading, SkeletonTable,
  EmptyState,
} from '@/components/ui'
import { ScreenError } from './screen-error'
import { useT } from '@/lib/i18n'
import { useChildren, childOptions } from './use-children'

/* The parents' board for one class.

   Not a school-wide forum and not a complaints box. Parents of 8-B agreeing
   who is driving to the museum, which is the thing families currently do in a
   WhatsApp group the school cannot see, cannot moderate and cannot correct
   when it repeats something wrong about a teacher.

   Three things the screen has to make obvious, because each is a promise the
   server keeps and a parent has no other way to learn:

     - You are reading YOUR class. The board picker is not a filter over
       everything; it is the whole list of boards you have, one per child, and
       the server refuses any other. Naming it "8-B — Aarav's class" rather
       than "Filter" is the difference between a parent understanding the scope
       and assuming the school is hiding the rest.

     - Your name is on it. Printed under the compose box, not buried in a
       tooltip. There is no anonymous mode and a parent should know that before
       they type, not after.

     - A complaint belongs somewhere else. The compose box says so and links
       the thought to Concerns, because a parent who posts a grievance here
       gets it converted by a moderator — which works, but is slower and more
       public than filing it properly in the first place. */

interface Board {
  section_id: string
  class: string
  student_id: string
  student_name: string
  open_threads: number
  last_activity_at?: string
}

interface Thread {
  id: string
  section_id: string
  class: string
  category: string
  title: string
  body: string
  author_name: string
  author_relation: string
  status: string
  written_by_me: boolean
  pinned: boolean
  locked: boolean
  lock_reason?: string
  replies: number
  open_reports: number
  opened_at: string
  last_activity_at: string
  moderation_note?: string
  grievance_id?: string
}

interface Post {
  id: string
  body: string
  author_name: string
  author_relation?: string
  from_staff: boolean
  written_by_me: boolean
  status: string
  at: string
  moderation_note?: string
}

/* The categories the server accepts, paired with their message keys.

   Written out rather than composed as `portal.forum.category_${c}`: a template
   literal is not a MessageKey, so the type checker cannot tell you that you
   added a category and forgot its string, and the screen ships a raw key in a
   dropdown. */
const CATEGORIES = [
  { value: 'general', key: 'portal.forum.category_general' },
  { value: 'event', key: 'portal.forum.category_event' },
  { value: 'trip', key: 'portal.forum.category_trip' },
  { value: 'volunteering', key: 'portal.forum.category_volunteering' },
  { value: 'logistics', key: 'portal.forum.category_logistics' },
  { value: 'lost_found', key: 'portal.forum.category_lost_found' },
  { value: 'question', key: 'portal.forum.category_question' },
] as const

function categoryKey(value: string) {
  return CATEGORIES.find((c) => c.value === value)?.key ?? 'portal.forum.category_general'
}

export default function Forum() {
  const t = useT()
  const qc = useQueryClient()
  const { children, chosen, setChosen } = useChildren()
  const [board, setBoard] = useState('')
  const [open, setOpen] = useState('')

  const boards = useQuery({
    queryKey: ['parent-forum-boards'],
    queryFn: () => api.get<List<Board>>('/api/v1/portal/parent-forum/boards'),
  })
  const all = boards.data?.items ?? []
  // One class needs no choosing, exactly as one child does. The picker appears
  // only when there is a real choice to make.
  const section = all.length === 1 ? all[0].section_id : board
  const current = all.find((b) => b.section_id === section)

  const threads = useQuery({
    queryKey: ['parent-forum-threads', section],
    queryFn: () =>
      api.get<{ items: Thread[] }>(
        `/api/v1/portal/parent-forum/threads${section ? `?section_id=${section}` : ''}`,
      ),
    enabled: all.length > 0,
  })

  if (boards.isLoading) return <SkeletonTable columns={6} label={t('portal.forum.loading')} />
  // Never an empty state for a failed query: "your class has said nothing" and
  // "we could not ask" are different facts and only one of them is reassuring.
  if (boards.error) return <ScreenError error={boards.error} />
  if (threads.error) return <ScreenError error={threads.error} />

  const rows = threads.data?.items ?? []
  const mine = rows.filter((r) => r.written_by_me)

  return (
    <>
      <PageHead
        eyebrow={t('portal.forum.eyebrow')}
        title={t('portal.forum.title')}
        description={t('portal.forum.description')}
      />
      <PageBody>
        <CellGrid cols={3}>
          <Stat label={t('portal.forum.stat_threads')} value={rows.length} icon={MessagesSquare} />
          <Stat label={t('portal.forum.stat_mine')} value={mine.length} />
          <Stat
            label={t('portal.forum.stat_class')}
            value={current ? current.class : t('portal.forum.stat_class_all')}
          />
        </CellGrid>

        {all.length > 1 && (
          <Card>
            <CardHeader
              title={t('portal.forum.picker_title')}
              description={t('portal.forum.picker_description')}
            />
            <div className="p-5">
              <FormGrid>
                <Field label={t('portal.forum.picker_label')}>
                  <Select
                    value={board}
                    onChange={(v) => {
                      setBoard(v)
                      setOpen('')
                    }}
                    placeholder={t('portal.forum.picker_all')}
                    options={all.map((b) => ({
                      value: b.section_id,
                      label: `${b.class} — ${b.student_name}`,
                    }))}
                  />
                </Field>
              </FormGrid>
            </div>
          </Card>
        )}

        {all.length === 0 ? (
          <EmptyState
            title={t('portal.forum.no_board_title')}
            body={t('portal.forum.no_board_body')}
          />
        ) : (
          <>
            <NewThread
              children_={children}
              chosen={chosen}
              setChosen={setChosen}
              onDone={() => qc.invalidateQueries({ queryKey: ['parent-forum-threads'] })}
            />

            <Card>
              <CardHeader
                title={t('portal.forum.threads_title')}
                description={t('portal.forum.threads_description')}
              />
              {/* The table is a sibling of the header rather than living inside
                  a padded body: a Table already insets its own cells by 20px,
                  and nesting it in a p-5 body double-insets every column. */}
              <Table
                head={[
                  t('portal.forum.col_thread'),
                  t('portal.forum.col_started_by'),
                  t('portal.forum.col_replies'),
                  t('portal.forum.col_last'),
                  '',
                ]}
                empty={rows.length === 0}
                emptyLabel={t('portal.forum.threads_empty')}
              >
                {rows.map((th) => (
                  <tr key={th.id}>
                    <Td>
                      <div className="flex items-center gap-1.5 font-medium">
                        {th.pinned && <Pin className="h-3.5 w-3.5 text-primary" />}
                        {th.locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                        {th.title}
                      </div>
                      <div className="text-[12px] text-muted-foreground">
                        {th.class} · {t(categoryKey(th.category))}
                      </div>
                      {th.status !== 'open' && th.moderation_note && (
                        <div className="mt-1 text-[12px] text-muted-foreground">
                          {t('portal.forum.taken_down', { reason: th.moderation_note })}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <div>{th.author_name}</div>
                      <div className="text-[12px] text-muted-foreground">
                        {th.author_relation}
                        {th.written_by_me && ` · ${t('portal.forum.badge_mine')}`}
                      </div>
                    </Td>
                    <Td className="tabular-nums">{th.replies}</Td>
                    <Td className="whitespace-nowrap">{th.last_activity_at.replace('T', ' ')}</Td>
                    <Td className="text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setOpen(open === th.id ? '' : th.id)}
                      >
                        {open === th.id
                          ? t('portal.forum.action_close')
                          : t('portal.forum.action_open')}
                      </Button>
                    </Td>
                  </tr>
                ))}
              </Table>
            </Card>

            {/* key on the thread id. A reply box that keeps its draft when the
                reader opens a different thread posts one family's words into
                another family's conversation — nine bugs of exactly this shape
                have shipped in this codebase. */}
            {open && (
              <ThreadDetail
                key={open}
                threadId={open}
                children_={children}
                chosen={chosen}
              />
            )}
          </>
        )}
      </PageBody>
    </>
  )
}

/* Starting a thread.

   Its own component so the draft it holds is not entangled with the reader
   below it, and so the "your name will be on this" line sits with the box
   rather than in a page-level paragraph nobody reads. */
function NewThread({
  children_,
  chosen,
  setChosen,
  onDone,
}: {
  children_: ReturnType<typeof useChildren>['children']
  chosen: string
  setChosen: (v: string) => void
  onDone: () => void
}) {
  const t = useT()
  const [category, setCategory] = useState('general')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const post = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/parent-forum/threads', {
        student_id: chosen || undefined,
        category,
        title,
        body,
      }),
    onSuccess: () => {
      setTitle('')
      setBody('')
      onDone()
    },
  })

  return (
    <Card>
      <CardHeader
        title={t('portal.forum.compose_title')}
        description={t('portal.forum.compose_description')}
      />
      <div className="p-5">
        <FormGrid>
          {children_.length > 1 && (
            <Field label={t('portal.forum.field_child')} hint={t('portal.forum.field_child_hint')} required>
              <Select
                value={chosen}
                onChange={setChosen}
                placeholder={t('portal.forum.field_child_placeholder')}
                options={childOptions(children_)}
              />
            </Field>
          )}
          <Field label={t('portal.forum.field_category')}>
            <Select
              value={category}
              onChange={setCategory}
              options={CATEGORIES.map((c) => ({ value: c.value, label: t(c.key) }))}
            />
          </Field>
          <Field label={t('portal.forum.field_title')} required wide>
            <Input value={title} onChange={setTitle} placeholder={t('portal.forum.field_title_placeholder')} />
          </Field>
          <Field label={t('portal.forum.field_body')} required wide>
            <Textarea value={body} onChange={setBody} rows={4} />
          </Field>
        </FormGrid>
        <p className="mt-4 text-[13px] text-muted-foreground">{t('portal.forum.named_notice')}</p>
        <p className="mt-1.5 text-[13px] text-muted-foreground">{t('portal.forum.grievance_notice')}</p>
        <div className="mt-4 flex items-center gap-3">
          <Button
            onClick={() => post.mutate()}
            disabled={post.isPending || !title.trim() || !body.trim()}
          >
            {t('portal.forum.action_post')}
          </Button>
          <FormNotice error={post.error} ok={post.isSuccess ? t('portal.forum.posted') : undefined} />
        </div>
      </div>
    </Card>
  )
}

/* One thread and its replies. */
function ThreadDetail({
  threadId,
  children_,
  chosen,
}: {
  threadId: string
  children_: ReturnType<typeof useChildren>['children']
  chosen: string
}) {
  const t = useT()
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const [reason, setReason] = useState('')

  const thread = useQuery({
    queryKey: ['parent-forum-thread', threadId],
    queryFn: () =>
      api.get<{ thread: Thread; posts: Post[] }>(
        `/api/v1/portal/parent-forum/threads/${threadId}`,
      ),
  })

  const reply = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/portal/parent-forum/threads/${threadId}/posts`, {
        student_id: chosen || undefined,
        body,
      }),
    onSuccess: () => {
      setBody('')
      qc.invalidateQueries({ queryKey: ['parent-forum-thread', threadId] })
      qc.invalidateQueries({ queryKey: ['parent-forum-threads'] })
    },
  })

  const report = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/portal/parent-forum/threads/${threadId}/report`, { reason }),
    onSuccess: () => setReason(''),
  })

  if (thread.isLoading) return <Loading label={t('portal.forum.loading_thread')} />
  if (thread.error) return <ScreenError error={thread.error} />

  const head = thread.data?.thread
  const posts = thread.data?.posts ?? []
  if (!head) return <ScreenError error={new Error(t('portal.forum.thread_missing'))} />

  return (
    <Card>
      <CardHeader
        title={head.title}
        description={t('portal.forum.thread_by', {
          name: head.author_name,
          relation: head.author_relation,
          at: head.opened_at.replace('T', ' '),
        })}
        action={
          head.locked ? (
            <Badge tone="neutral">{t('portal.forum.badge_locked')}</Badge>
          ) : (
            <Badge tone="success">{t('portal.forum.badge_open')}</Badge>
          )
        }
      />
      <div className="p-5">
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{head.body}</p>

        {head.lock_reason && (
          <p className="mt-4 text-[13px] text-muted-foreground">
            {t('portal.forum.locked_because', { reason: head.lock_reason })}
          </p>
        )}
        {head.grievance_id && (
          <p className="mt-4 text-[13px] text-muted-foreground">
            {t('portal.forum.converted_notice')}
          </p>
        )}

        <div className="mt-6 space-y-4 border-t pt-5">
          {posts.length === 0 && (
            <p className="text-[13px] text-muted-foreground">{t('portal.forum.no_replies')}</p>
          )}
          {posts.map((p) => (
            <div key={p.id} className="rounded-md border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium">
                  {p.author_name}
                  {p.from_staff && ` · ${t('portal.forum.badge_staff')}`}
                  {p.author_relation && !p.from_staff && ` · ${p.author_relation}`}
                </span>
                <span className="text-[12px] text-muted-foreground">{p.at.replace('T', ' ')}</span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed">{p.body}</p>
              {p.moderation_note && (
                <p className="mt-2 text-[12px] text-muted-foreground">
                  {t('portal.forum.taken_down', { reason: p.moderation_note })}
                </p>
              )}
            </div>
          ))}
        </div>

        {!head.locked && head.status === 'open' && (
          <div className="mt-6 border-t pt-5">
            {children_.length > 1 && !chosen && (
              <p className="mb-3 text-[13px] text-muted-foreground">
                {t('portal.forum.pick_child_first')}
              </p>
            )}
            <Textarea
              value={body}
              onChange={setBody}
              rows={3}
              placeholder={t('portal.forum.reply_placeholder')}
            />
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                onClick={() => reply.mutate()}
                disabled={reply.isPending || !body.trim()}
              >
                {t('portal.forum.action_reply')}
              </Button>
              <FormNotice error={reply.error} />
            </div>
          </div>
        )}

        <div className="mt-6 border-t pt-5">
          <p className="text-[13px] text-muted-foreground">{t('portal.forum.report_explainer')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Input
              value={reason}
              onChange={setReason}
              srLabel={t('portal.forum.report_label')}
              placeholder={t('portal.forum.report_placeholder')}
              className="max-w-sm"
            />
            <ConfirmButton
              confirmLabel={t('portal.forum.report_confirm')}
              question={t('portal.forum.report_question')}
              onConfirm={() => report.mutate()}
              disabled={report.isPending || !reason.trim()}
            >
              {t('portal.forum.action_report')}
            </ConfirmButton>
            <FormNotice
              error={report.error}
              ok={report.isSuccess ? t('portal.forum.reported') : undefined}
            />
          </div>
        </div>
      </div>
    </Card>
  )
}
