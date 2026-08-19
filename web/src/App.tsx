import { Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider, useSession } from '@/lib/session'
import AccountPage from '@/features/shared/Profile'
import {
  CatalogProvider, useCatalog, useActiveRole, useFeature, featurePath, firstUsable,
} from '@/lib/catalog'
import { Shell } from '@/components/Shell'
import { PageHead, PageBody, Loading, EmptyState, UnavailableState } from '@/components/ui'
import { componentFor } from '@/features/registry'
import { ToastHost } from './components/Toast'
import NeedsAttention from '@/components/NeedsAttention'
import { I18nProvider } from '@/lib/i18n'

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
  /* The first feature that actually opens, not the first one catalogued.

     Taking sections[0].features[0] meant a role whose first catalogued entry
     is unbuilt landed on a placeholder -- one the navigation would never have
     offered, since it hides unbuilt items. super_admin did exactly this. */
  const first = firstUsable(role)
  if (!first) {
    /* Two very different reasons for an empty workspace, and they used to read
       the same.

       A teacher with no section and no subject holds every grant their role
       carries and can reach none of it, because reach comes from assignments
       rather than from the role. Telling them "no screen is ready yet" blames
       the product for something the office has not done, and they wait for a
       release that will not fix it. Telling them who to ask takes about a day
       off that. */
    const built = role.sections.some((sec) => sec.features.some((f) => f.live))
    return built ? (
      <EmptyState
        title="No class assigned to you yet"
        body={
          'Everything in this workspace opens once you are made class teacher of a ' +
          'section or given a subject in one. Ask your principal or head of ' +
          'department to assign you — that is what decides which children you see, ' +
          'not your role.'
        }
      />
    ) : (
      <EmptyState title={role.name} body="No screen in this workspace is ready yet." />
    )
  }
  return <Navigate to={featurePath(role.key, first.section.slug, first.feature.slug)} replace />
}

function FeatureRoute() {
  const { sectionSlug, featureSlug } = useParams()
  const role = useActiveRole()
  const session = useSession()
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
          <UnavailableState
            title="Nothing in your scope"
            body={`You can use this feature, but no ${scopeNoun(feature.scope)} is assigned to your account yet.`}
          />
        </PageBody>
      </>
    )
  }

  const Component = componentFor(feature.key)

  /* Every role's Home opens with the same question.

     Mounted here rather than inside each role's dashboard so that adding a
     role does not mean remembering to add its attention panel — and so the
     seven dashboards that already exist did not each grow their own slightly
     different version of it. The workspace is the trigger, not the component:
     a Home section is a Home section in all seventeen catalogues. */
  const isHome = section.workspace === 'Home' || section.slug === 'home' ||
    section.slug === 'dashboard'

  if (!Component) {
    if (isHome) {
      return (
        <>
          <PageHead eyebrow={role.name} title="Home" />
          <PageBody>
            <NeedsAttention name={session.user?.full_name.split(" ")[0]} />
          </PageBody>
        </>
      )
    }
    return <CataloguedStub sectionName={section.name} feature={feature} />
  }

  return (
    <Suspense fallback={<Loading />}>
      {isHome && (
        <PageBody>
          <NeedsAttention name={session.user?.full_name.split(" ")[0]} />
        </PageBody>
      )}
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
      <PageHead eyebrow={sectionName} title={feature.name} description={feature.summary} />
      <PageBody>
        <UnavailableState
          title="Not available yet"
          body={`${feature.name} is set up for this workspace, but its screen has not been built. It is listed here rather than hidden so the workspace reflects the full specification.`}
          technical={[
            { label: 'Permission', value: feature.key },
            { label: 'Data scope', value: feature.scope },
          ]}
        />
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
            <I18nProvider>
            <Shell>
              <Routes>
                {/* Outside the catalogue on purpose. Every signed-in person
                    has a name, a password and contact details, whatever their
                    role — and only faculty had a catalogue entry for it, so
                    eight roles out of nine could not reach the screen that
                    already existed to change their own password. */}
                <Route path="/account" element={<AccountPage />} />
                <Route path="/" element={<Home />} />
                <Route path="/:roleKey" element={<RoleIndex />} />
                <Route path="/:roleKey/:sectionSlug" element={<FeatureRoute />} />
                <Route path="/:roleKey/:sectionSlug/:featureSlug" element={<FeatureRoute />} />
                <Route path="*" element={<Home />} />
              </Routes>
            </Shell>
            </I18nProvider>
          </CatalogProvider>
        </SessionProvider>
      </BrowserRouter>
    </ToastHost>
    </QueryClientProvider>
  )
}
