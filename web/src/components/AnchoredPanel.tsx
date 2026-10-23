import { useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, Z_ABOVE_DIALOGS, type AnchorOptions } from './anchored'

/* A panel opened from a trigger, drawn in the body so no overflow can clip it,
   and placed by useAnchoredPosition so it is always fully on screen (flipped
   above when the room below is short, height capped with its own scroll).
   Use this instead of an `absolute` div under the trigger. */
export function Anchored({
  open, anchor, panelRef, className, style, children, role, ...opts
}: AnchorOptions & {
  open: boolean
  anchor: RefObject<HTMLElement | null>
  /** Optional ref to the panel, for outside-click checks (see useDismiss). */
  panelRef?: RefObject<HTMLDivElement>
  className?: string
  style?: CSSProperties
  role?: string
  children: ReactNode
}) {
  const own = useRef<HTMLDivElement>(null)
  const panel = panelRef ?? own
  const place = useAnchoredPosition(open, anchor, panel, opts)
  if (!open || typeof document === 'undefined') return null
  return createPortal(
    <div ref={panel} role={role} data-anchored-panel="" className={className}
      style={{ ...style, ...place, zIndex: Z_ABOVE_DIALOGS }}>
      {children}
    </div>,
    document.body,
  )
}
