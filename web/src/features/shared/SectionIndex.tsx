import { Link, useParams } from 'react-router-dom'
import { ChevronRight, FileText } from 'lucide-react'
import { PageHead, PageBody, EmptyState } from '@/components/ui'
import { useResolvedRole, usable, featurePath } from '@/lib/catalog'

/* A section's screens as a folder (owner, 2026-11-17: like Google Drive).
   Opened from the first part of any breadcrumb. */
export default function SectionIndex() {
  const { sectionSlug } = useParams()
  const { role } = useResolvedRole()
  const section = role?.sections.find((s) => s.slug === sectionSlug)
  const items = section?.features.filter(usable) ?? []
  return (
    <>
      <PageHead title={section?.name ?? 'Not found'} />
      <PageBody>
        {!role || !section || !items.length
          ? <EmptyState title="Nothing to open here" body="This section has no screens in your workspace." />
          : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {items.map((f) => (
                <Link key={f.key} to={featurePath(role.key, section.slug, f.slug)}
                  className="flex min-h-[64px] items-center gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-muted/40">
                  <FileText className="size-6 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-foreground">{f.name}</span>
                    {f.summary && <span className="block truncate text-[13px] text-muted-foreground">{f.summary}</span>}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              ))}
            </div>
          )}
      </PageBody>
    </>
  )
}
