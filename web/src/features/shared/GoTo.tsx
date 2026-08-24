import { useEffect } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useCatalog, usable } from '@/lib/catalog'
import { PageHead, PageBody, EmptyState, Loading } from '@/components/ui'

/* A link that does not have to know which workspace you are in.
 *
 * Notifications carry a link, and something has to decide the first segment of
 * it — the role. Guessing it from the reader's rbac role looked right and was
 * not: a head of department holds the role key "hod" and is served the
 * institution_admin workspace, because that catalogue is the one they borrow.
 * The alert therefore pointed at /hod/approvals/approvals, a path the app
 * cannot resolve, and the person who had just been told something needed them
 * landed on "That feature is not in your workspace".
 *
 * So the sender stops guessing. /go/approvals/approvals names the section and
 * the feature, and this resolves the workspace at the moment it is opened —
 * which is the only moment anybody knows it, because it depends on who is
 * reading and on which of their roles is active.
 *
 * Falls back to searching by feature slug alone: sections get renamed, and a
 * notification stored in March should still open in September.
 */
export default function GoTo() {
  const { sectionSlug, featureSlug } = useParams()
  const catalog = useCatalog()
  const navigate = useNavigate()
  /* The query string travels with it.
   *
   * A message notification carries ?with=<sender>, which is the whole point of
   * the link — it opens that conversation rather than the address book. */
  const { search } = useLocation()

  useEffect(() => {
    if (!catalog.roles.length) return
    for (const role of catalog.roles) {
      for (const section of role.sections) {
        for (const f of section.features) {
          if (!usable(f)) continue
          const bySection = section.slug === sectionSlug && f.slug === featureSlug
          const bySlugOnly = !sectionSlug && f.slug === featureSlug
          if (bySection || bySlugOnly) {
            navigate(`/${role.key}/${section.slug}/${f.slug}${search}`, { replace: true })
            return
          }
        }
      }
    }
    // Second pass: the section moved, but the feature is still somewhere.
    for (const role of catalog.roles) {
      for (const section of role.sections) {
        const f = section.features.find((x) => usable(x) && x.slug === featureSlug)
        if (f) {
          navigate(`/${role.key}/${section.slug}/${f.slug}${search}`, { replace: true })
          return
        }
      }
    }

    /* Third pass: the same idea under a different name.
     *
     * A parent's homework screen is "homework_academics" and a student's is
     * "homework_assignments" — one word for one thing, spelt twice because two
     * roles describe it differently. A link written as /go/homework should
     * reach whichever of them the reader has, so the last resort matches on
     * the word rather than the whole slug. */
    const want = (featureSlug ?? '').toLowerCase()
    if (want) {
      for (const role of catalog.roles) {
        for (const section of role.sections) {
          const f = section.features.find(
            (x) => usable(x) && (x.slug.includes(want) || want.includes(x.slug)),
          )
          if (f) {
            navigate(`/${role.key}/${section.slug}/${f.slug}${search}`, { replace: true })
            return
          }
        }
      }
    }
  }, [catalog.roles, sectionSlug, featureSlug, navigate, search])

  /* The first screen this reader can actually open, for the way back. Resolved
     the same way the resolver above works — from the catalogue rather than from
     a guess about their role. */
  const homeHref = (() => {
    for (const role of catalog.roles) {
      for (const section of role.sections) {
        const f = section.features.find(usable)
        if (f) return `/${role.key}/${section.slug}/${f.slug}`
      }
    }
    return ''
  })()

  if (!catalog.roles.length) return <Loading />

  /* A dead end has to offer a door.
   *
   * This said a screen had moved and then stopped, with no controls and no
   * links — which is worse than a 404, because a 404 at least admits it is the
   * end of the road. Somebody arriving here has just been told something needs
   * them, so the two things worth offering are the place they were going
   * (search, which knows every screen they can open) and the place they can
   * always get back to. */
  return (
    <>
      <PageHead eyebrow="Not found" title="That screen has moved" />
      <PageBody>
        <EmptyState
          title="This link points at a screen your workspace does not have"
          body="It may have been renamed since the message was sent, or it may belong to a role you no longer hold."
        />
        <p className="mt-4 text-center text-[13px] text-muted-foreground">
          {/* Named, not just linked: somebody who does not know what was meant by
              the link needs to know what they are being offered instead. */}
          Press <kbd className="rounded border px-1 font-mono text-[11px]">Ctrl K</kbd> to search
          everything you can open{homeHref ? ', or ' : '.'}
          {homeHref && (
            <button type="button" onClick={() => navigate(homeHref)} className="underline">
              go to your home screen
            </button>
          )}
          {homeHref ? '.' : ''}
        </p>
      </PageBody>
    </>
  )
}
