import { mergeAttributes, Node } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { Table } from '@tiptap/extension-table'
import { ImageView, LinesView, BoxView } from './NodeViews'

/** A picture from the image store, referenced by id. Inline so it can sit in text, cells or a row. */
export const QImage = Node.create({
  name: 'qimage',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      id: { default: '', parseHTML: (el) => el.getAttribute('data-id'), renderHTML: (a) => ({ 'data-id': a.id }) },
      width: { default: 40, parseHTML: (el) => Number(el.getAttribute('data-width')) || 40, renderHTML: (a) => ({ 'data-width': a.width }) },
      align: { default: 'inline', parseHTML: (el) => el.getAttribute('data-align') || 'inline', renderHTML: (a) => ({ 'data-align': a.align }) },
    }
  },
  parseHTML: () => [{ tag: 'img[data-id]' }],
  renderHTML: ({ HTMLAttributes }) => ['img', mergeAttributes(HTMLAttributes)],
  addNodeView: () => ReactNodeViewRenderer(ImageView),
})

/** Ruled lines for the student's answer, placeable anywhere (also inside table cells). */
export const AnswerLines = Node.create({
  name: 'answerLines',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ lines: { default: 3, parseHTML: (el) => Number(el.getAttribute('data-lines')) || 3, renderHTML: (a) => ({ 'data-lines': a.lines }) } }),
  parseHTML: () => [{ tag: 'div[data-lines]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes)],
  addNodeView: () => ReactNodeViewRenderer(LinesView),
})

/** An empty bordered box ("draw the diagram here"). Height in mm. */
export const DrawBox = Node.create({
  name: 'drawBox',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ height: { default: 40, parseHTML: (el) => Number(el.getAttribute('data-box')) || 40, renderHTML: (a) => ({ 'data-box': a.height }) } }),
  parseHTML: () => [{ tag: 'div[data-box]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes)],
  addNodeView: () => ReactNodeViewRenderer(BoxView),
})

/** Tables can be real tables (borders) or invisible layout grids (no borders). */
export const QTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      borderless: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-borderless') === 'true',
        renderHTML: (a) => (a.borderless ? { 'data-borderless': 'true' } : {}),
      },
    }
  },
})
