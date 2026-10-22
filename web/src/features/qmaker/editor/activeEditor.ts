import { useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/react'

/**
 * One toolbar serves every text box: whichever editor was focused last is "active",
 * like Word's ribbon acting on the current cursor.
 */
let active: Editor | null = null
let version = 0
const listeners = new Set<() => void>()
const emit = () => {
  version++
  listeners.forEach((l) => l())
}

export function setActiveEditor(editor: Editor | null) {
  if (active === editor) return
  active?.off('transaction', emit)
  active = editor
  active?.on('transaction', emit)
  emit()
}

export function clearActiveEditor(editor: Editor) {
  if (active === editor) setActiveEditor(null)
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The active editor; re-renders the caller on every edit or cursor move so buttons show state. */
export function useActiveEditor() {
  useSyncExternalStore(subscribe, () => version)
  return active && !active.isDestroyed ? active : null
}
