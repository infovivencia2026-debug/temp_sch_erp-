import { useEffect, useRef } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import TextAlign from '@tiptap/extension-text-align'
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { toHtml } from '../lib/richdoc'
import { defaultWidthMm, type ImageAsset } from '../lib/images'
import { AnswerLines, DrawBox, QImage, QTable } from './extensions'
import { clearActiveEditor, setActiveEditor } from './activeEditor'
import { useMaker } from './context'

export const editorExtensions = (placeholder = '') => [
  // Undo and redo belong to the whole paper (Ctrl+Z), so the editor's own history is off.
  StarterKit.configure({ undoRedo: false, heading: false, code: false, codeBlock: false, blockquote: false, link: false }),
  Subscript,
  Superscript,
  TextAlign.configure({ types: ['paragraph'] }),
  // Drag a column border to resize it (also in borderless layout grids).
  QTable.configure({ resizable: true, cellMinWidth: 24, lastColumnResizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  QImage,
  AnswerLines,
  DrawBox,
  Placeholder.configure({ placeholder }),
]

const imageFiles = (files: FileList | undefined | null) => [...(files ?? [])].filter((f) => f.type.startsWith('image/'))

/** Pictures at the cursor; several at once become a row (a borderless table), one per cell. */
export function insertAssets(editor: Editor, assets: ImageAsset[]) {
  if (!assets.length) return
  if (assets.length === 1) {
    const a = assets[0]
    editor.chain().focus().insertContent({ type: 'qimage', attrs: { id: a.id, width: defaultWidthMm(a), align: 'inline' } }).run()
    return
  }
  const cells = assets.map((a) => `<td><p style="text-align: center"><img data-id="${a.id}" data-width="25" data-align="inline"></p></td>`).join('')
  editor.chain().focus().insertContent(`<table data-borderless="true"><tbody><tr>${cells}</tr></tbody></table><p></p>`).run()
}

export async function insertImages(editor: Editor, files: File[], addImage: (b: Blob) => Promise<ImageAsset | null>) {
  insertAssets(editor, (await Promise.all(files.map((f) => addImage(f)))).filter((a): a is ImageAsset => a !== null))
}

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** Short fields: Enter does not start a new paragraph. */
  single?: boolean
  className?: string
  /** What a screen reader calls this box. */
  label: string
}

/** Word-like text on the sheet: formatting, lists, tables, pictures, answer lines. The shared toolbar acts on it. */
export default function RichInput({ value, onChange, placeholder, single, className = '', label }: Props) {
  const { addImage } = useMaker()
  const lastEmitted = useRef(value)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const addImageRef = useRef(addImage)
  addImageRef.current = addImage

  const editor = useEditor({
    extensions: editorExtensions(placeholder),
    content: toHtml(value),
    onUpdate: ({ editor }) => {
      const html = editor.isEmpty ? '' : editor.getHTML()
      lastEmitted.current = html
      onChangeRef.current(html)
    },
    onFocus: ({ editor }) => setActiveEditor(editor),
    editorProps: {
      attributes: { class: 'ed', 'aria-label': label, role: 'textbox', 'aria-multiline': single ? 'false' : 'true' },
      handleKeyDown: (_view, event) => !!single && event.key === 'Enter' && !event.shiftKey,
      handlePaste: (_view, event) => {
        const files = imageFiles(event.clipboardData?.files)
        if (!files.length || !editor) return false
        insertImages(editor, files, addImageRef.current)
        return true
      },
      handleDrop: (_view, event) => {
        const files = imageFiles((event as DragEvent).dataTransfer?.files)
        if (!files.length || !editor) return false
        event.preventDefault()
        insertImages(editor, files, addImageRef.current)
        return true
      },
    },
  })

  // A change from outside (undo, redo, a question swapped in) replaces the content.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return
    lastEmitted.current = value
    editor.commands.setContent(toHtml(value), { emitUpdate: false })
  }, [value, editor])

  useEffect(() => () => {
    if (editor) clearActiveEditor(editor)
  }, [editor])

  return (
    <div className={`rich ${single ? 'single' : ''} ${className}`}>
      <EditorContent editor={editor} />
    </div>
  )
}
