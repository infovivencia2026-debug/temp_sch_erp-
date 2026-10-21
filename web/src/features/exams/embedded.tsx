import type { ReactNode } from 'react'

/* A screen shown as a tab inside another (Question maker inside Question
   papers): the host already has the page title, so the guest keeps only its
   buttons, and its body sits in the host's page instead of opening its own. */
export function EmbeddedHead({ actions }: { actions?: ReactNode; eyebrow?: string; title?: string; description?: string }) {
  return actions ? <div className="mb-4 flex flex-wrap justify-end gap-2">{actions}</div> : null
}

export function EmbeddedBody({ children }: { children: ReactNode }) {
  return <div className="space-y-4">{children}</div>
}
