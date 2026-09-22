import './workspace-loading.css'

/* The workspace opening (workspace-loading.css says why and how).

   Rendered by SessionProvider for the one request that decides who this is,
   and for 400ms after it answers so the app fades in under it rather than
   snapping. Nothing else in the product shows this: a screen change inside
   the app is a screen change, not an opening.

   The name is the product's until the session says whose school this is --
   that answer is what this screen is waiting for -- and a warm reload has
   already had applyBrand paint the school's colour into --brand-accent, so
   the wordmark wears it. */
export function WorkspaceLoading({ leaving = false }: { leaving?: boolean }) {
  return (
    <div
      className="ws-opening"
      data-leaving={leaving ? '' : undefined}
      role="status"
      aria-live="polite"
      aria-label={leaving ? undefined : 'Opening your workspace'}
    >
      <span className="ws-blob ws-blob-1" aria-hidden="true" />
      <span className="ws-blob ws-blob-2" aria-hidden="true" />
      <span className="ws-blob ws-blob-3" aria-hidden="true" />
      <div className="ws-mark">
        <p className="ws-word">School ERP</p>
        <div className="ws-rule" aria-hidden="true" />
        <p className="ws-sub">Opening your workspace</p>
      </div>
    </div>
  )
}
