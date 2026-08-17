import { Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider } from '@/lib/session'
import { CatalogProvider, useCatalog, useActiveRole, useFeature, featurePath } from '@/lib/catalog'
import { Shell } from '@/components/Shell'
import { PageHead, PageBody, Card, Loading, EmptyState, Badge } from '@/components/ui'
import { componentFor } from '@/features/registry'
import { ToastHost } from './components/Toast'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Reference data (classes, sections, subjects) changes a few times a
      // year; refetching on every window focus is pure noise.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

/** Sends the user to the first feature of their first role. */
function RoleIndex() {
  const role = useActiveRole()
  if (!role) return <EmptyState title="No workspace" body="Your account holds no feature grants yet." />
  const section = role.sections[0]
  const feature = section?.features[0]
  if (!section || !feature) {
    return <EmptyState title={role.name} body="This role has no features you can access." />
  }
  return <Navigate to={featurePath(role.key, section.slug, feature.slug)} replace />
}

function FeatureRoute() {
  const { sectionSlug, featureSlug } = useParams()
  const role = useActiveRole()
  const { section, feature } = useFeature(sectionSlug, featureSlug)

  if (!role || !section || !feature) {
    return (
      <>
        <PageHead eyebrow="Not found" title="No such feature" />
        <PageBody>
          <EmptyState
            title="That feature is not in your workspace"
            body="It may not exist, or your role may not grant it."
          />
        </PageBody>
      </>
    )
  }

  // Holding the grant but having nothing behind it is a normal state, not an
  // error: a department head with no department, a teacher with no sections.
  if (!feature.in_scope) {
    return (
      <>
        <PageHead eyebrow={section.name} title={feature.name} description={feature.summary} />
        <PageBody>
          <EmptyState
            title="Nothing in your scope"
            body={`You can use this feature, but no ${scopeNoun(feature.scope)} is assigned to your account yet.`}
          />
        </PageBody>
      </>
    )
  }

  const Component = componentFor(feature.key)
  if (!Component) {
    return <CataloguedStub sectionName={section.name} feature={feature} />
  }

  return (
    <Suspense fallback={<Loading />}>
      <Component />
    </Suspense>
  )
}

function scopeNoun(scope: string) {
  switch (scope) {
    case 'campus': return 'campus'
    case 'department': return 'department'
    case 'assigned_classes': return 'class or subject'
    case 'self': return 'student record'
    case 'children': return 'child'
    default: return 'record'
  }
}

/**
 * Rendered for a feature that is in the catalog, permissioned and in scope,
 * but has no implementation yet. It states that plainly instead of showing
 * mock data — a fake dashboard is worse than an empty one, because nobody can
 * tell it is fake.
 */
function CataloguedStub({
  sectionName,
  feature,
}: {
  sectionName: string
  feature: { name: string; summary: string; scope: string; key: string }
}) {
  return (
    <>
      <PageHead
        eyebrow={sectionName}
        title={feature.name}
        description={feature.summary}
        actions={<Badge tone="warning">Not built yet</Badge>}
      />
      <PageBody>
        <Card className="p-8">
          <p className="text-[13px] font-medium">Catalogued, not implemented</p>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
            This feature is registered in the catalog with its permission and data scope, and your
            role grants it — but no screen has been built for it yet. It is listed here rather than
            hidden so the workspace reflects the full specification.
          </p>
          <dl className="mt-6 grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[12px]">
            <dt className="text-muted-foreground">Permission key</dt>
            <dd className="font-mono text-[11px]">{feature.key}</dd>
            <dt className="text-muted-foreground">Data scope</dt>
            <dd>{feature.scope}</dd>
          </dl>
        </Card>
      </PageBody>
    </>
  )
}

/** Lands on the user's first role. */
function Home() {
  const catalog = useCatalog()
  const first = catalog.roles[0]
  if (!first) {
    return <EmptyState title="No workspace" body="Your account holds no feature grants yet." />
  }
  return <Navigate to={`/${first.key}`} replace />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastHost>
      <BrowserRouter>
        <SessionProvider>
          <CatalogProvider>
            <Shell>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/:roleKey" element={<RoleIndex />} />
                <Route path="/:roleKey/:sectionSlug" element={<FeatureRoute />} />
                <Route path="/:roleKey/:sectionSlug/:featureSlug" element={<FeatureRoute />} />
                <Route path="*" element={<Home />} />
              </Routes>
            </Shell>
          </CatalogProvider>
        </SessionProvider>
      </BrowserRouter>
    </ToastHost>
    </QueryClientProvider>
  )
}
