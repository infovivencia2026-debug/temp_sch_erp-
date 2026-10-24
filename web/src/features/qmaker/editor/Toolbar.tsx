import { useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, ChevronDown, Italic, List, ListOrdered, Omega,
  RemoveFormatting, Strikethrough, Subscript, Superscript, Table2, Underline,
} from 'lucide-react'
import { Button, Checkbox, Field, Input } from '@/components/ui'
import { Anchored } from '@/components/AnchoredPanel'
import { useDismiss } from '@/components/anchored'
import { useActiveEditor } from './activeEditor'
import { insertAssets, insertImages } from './RichInput'
import { useMaker } from './context'
import ImagePicker from './ImagePicker'
import { Menu } from '@/features/bento/Menu'

const SYMBOLS = '√ ∛ π ° ± × ÷ = ≠ ≈ ≤ ≥ < > ∞ ∠ △ ⊥ ∥ ∴ ∵ ∈ ∉ ⊂ ∪ ∩ ∅ α β γ δ θ λ μ σ ω Ω Σ Δ → ← ↔ ⇌ ↑ ↓ ½ ⅓ ¼ ¾ ² ³ ₂ ₃ ⁻ ✓ ✗ ☐ ★ ₹ %'.split(' ')

function Tool({ on, title, onClick, children, disabled }: { on?: boolean; title: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return <Button size="sm" variant="ghost" title={title} disabled={disabled} onClick={onClick} className={on ? 'bg-accent text-foreground' : undefined}>{children}</Button>
}

/** A toolbar button that opens a panel under it (a small form, not a menu). */
function Popover({ label, title, disabled, open, setOpen, children }: {
  label: ReactNode; title: string; disabled: boolean; open: boolean; setOpen: (v: boolean) => void; children: ReactNode
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null) as RefObject<HTMLDivElement>
  useDismiss(open, () => setOpen(false), [anchor, panel])
  return (
    <span ref={anchor} className="inline-flex">
      <Button size="sm" variant="ghost" title={title} disabled={disabled} ariaHasPopup="menu" ariaExpanded={open} onClick={() => setOpen(!open)}
        className={open ? 'bg-accent text-foreground' : undefined}>
        {label}<ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
      </Button>
      <Anchored open={open} anchor={anchor} panelRef={panel} role="menu" maxHeight={420}
        className="rounded-xl border bg-popover p-2 text-popover-foreground shadow-[0_10px_25px_-5px_rgba(0,0,0,0.18)]">
        {/* React carries this press up to the toolbar through the portal; stop
            it there. Keeping focus in the paper's text (no default) is right
            for the buttons, wrong for the table form's fields. */}
        <div onMouseDown={(e) => {
          e.stopPropagation()
          if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault()
        }}>{children}</div>
      </Anchored>
    </span>
  )
}

function TableForm({ onPick }: { onPick: (rows: number, cols: number, borderless: boolean) => void }) {
  const [rows, setRows] = useState('3')
  const [cols, setCols] = useState('3')
  const [borderless, setBorderless] = useState(false)
  const n = (v: string) => Math.min(20, Math.max(1, Math.round(Number(v)) || 1))
  return (
    <div className="w-64 space-y-3 p-1">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Rows"><Input type="number" min={1} max={20} value={rows} onChange={setRows} /></Field>
        <Field label="Columns"><Input type="number" min={1} max={20} value={cols} onChange={setCols} /></Field>
      </div>
      <Checkbox checked={borderless} onChange={setBorderless} label="No borders" hint="A layout grid: things side by side." />
      <Button size="sm" onClick={() => onPick(n(rows), n(cols), borderless)}>Insert table</Button>
    </div>
  )
}

function insertTable(editor: Editor, rows: number, cols: number, borderless: boolean) {
  const chain = editor.chain().focus().insertTable({ rows, cols, withHeaderRow: false })
  ;(borderless ? chain.updateAttributes('table', { borderless: true }) : chain).run()
}

/** One toolbar for every text box on the sheet: it acts on whichever has the cursor. */
export default function Toolbar() {
  const editor = useActiveEditor()
  const { addImage, remember } = useMaker()
  const [menu, setMenu] = useState<null | 'insert' | 'table' | 'symbols'>(null)
  const [storeOpen, setStoreOpen] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const multi = useRef(false)

  const e = editor
  const c = () => e!.chain().focus()
  const off = !e
  const inTable = !!e?.isActive('table')
  const close = () => setMenu(null)
  const insertAt = useRef<HTMLSpanElement>(null)

  return (
    /* A press on the toolbar keeps the cursor in the paper's text. Only a press
       on the toolbar itself: dialogs and menus opened from it are portalled,
       and their fields must still take focus. */
    <div className="qm-toolbar" role="toolbar" aria-label="Text formatting"
      onMouseDown={(ev) => { if (ev.currentTarget.contains(ev.target as Node)) ev.preventDefault() }}>
      <div className="qm-tgroup">
        <Tool title="Bold (Ctrl+B)" on={e?.isActive('bold')} disabled={off} onClick={() => c().toggleBold().run()}><Bold className="size-4" /></Tool>
        <Tool title="Italic (Ctrl+I)" on={e?.isActive('italic')} disabled={off} onClick={() => c().toggleItalic().run()}><Italic className="size-4" /></Tool>
        <Tool title="Underline (Ctrl+U)" on={e?.isActive('underline')} disabled={off} onClick={() => c().toggleUnderline().run()}><Underline className="size-4" /></Tool>
        <Tool title="Strikethrough" on={e?.isActive('strike')} disabled={off} onClick={() => c().toggleStrike().run()}><Strikethrough className="size-4" /></Tool>
        <Tool title="Subscript, as in H₂O" on={e?.isActive('subscript')} disabled={off} onClick={() => c().toggleSubscript().run()}><Subscript className="size-4" /></Tool>
        <Tool title="Superscript, as in x²" on={e?.isActive('superscript')} disabled={off} onClick={() => c().toggleSuperscript().run()}><Superscript className="size-4" /></Tool>
      </div>
      <div className="qm-tgroup">
        <Tool title="Align left" on={e?.isActive({ textAlign: 'left' })} disabled={off} onClick={() => c().setTextAlign('left').run()}><AlignLeft className="size-4" /></Tool>
        <Tool title="Centre" on={e?.isActive({ textAlign: 'center' })} disabled={off} onClick={() => c().setTextAlign('center').run()}><AlignCenter className="size-4" /></Tool>
        <Tool title="Align right" on={e?.isActive({ textAlign: 'right' })} disabled={off} onClick={() => c().setTextAlign('right').run()}><AlignRight className="size-4" /></Tool>
        <Tool title="Justify" on={e?.isActive({ textAlign: 'justify' })} disabled={off} onClick={() => c().setTextAlign('justify').run()}><AlignJustify className="size-4" /></Tool>
      </div>
      <div className="qm-tgroup">
        <Tool title="Bulleted list" on={e?.isActive('bulletList')} disabled={off} onClick={() => c().toggleBulletList().run()}><List className="size-4" /></Tool>
        <Tool title="Numbered list" on={e?.isActive('orderedList')} disabled={off} onClick={() => c().toggleOrderedList().run()}><ListOrdered className="size-4" /></Tool>
      </div>
      <div className="qm-tgroup">
        <Popover label={<Table2 className="size-4" />} title="Insert a table" disabled={off} open={menu === 'table'} setOpen={(v) => setMenu(v ? 'table' : null)}>
          {e && <TableForm onPick={(r, col, b) => { insertTable(e, r, col, b); close() }} />}
        </Popover>
        <span ref={insertAt} className="inline-flex">
          <Button size="sm" variant="ghost" title="Insert a picture, lines or a box" disabled={off} ariaHasPopup="menu" ariaExpanded={menu === 'insert'}
            onClick={() => setMenu(menu === 'insert' ? null : 'insert')} className={menu === 'insert' ? 'bg-accent text-foreground' : undefined}>
            Insert<ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
          </Button>
        </span>
        <Menu open={menu === 'insert' && !!e} anchor={insertAt.current} label="Insert" onClose={close} width={248}>
          {e && ([
            ['Picture from this device', () => { multi.current = false; file.current?.click() }],
            ['Several pictures in a row', () => { multi.current = true; file.current?.click() }],
            ['Picture from the image store', () => setStoreOpen(true)],
            ['Two columns', () => insertTable(e, 1, 2, true)],
            ['Three columns', () => insertTable(e, 1, 3, true)],
            ['Answer lines', () => c().insertContent({ type: 'answerLines', attrs: { lines: 3 } }).run()],
            ['Drawing box', () => c().insertContent({ type: 'drawBox', attrs: { height: 40 } }).run()],
            ['Horizontal line', () => c().setHorizontalRule().run()],
            ['Blank to fill in', () => c().insertContent('________').run()],
            ['Tick box', () => c().insertContent('☐ ').run()],
            ['Line break (Shift+Enter)', () => c().setHardBreak().run()],
          ] as const).map(([label, run]) => (
            <button key={label} type="button" role="menuitem" className="bento-menu__item" onClick={() => { close(); run() }}>{label}</button>
          ))}
        </Menu>
        <Popover label={<Omega className="size-4" />} title="Symbols" disabled={off} open={menu === 'symbols'} setOpen={(v) => setMenu(v ? 'symbols' : null)}>
          {e && (
            <div className="grid w-72 grid-cols-8 gap-0.5">
              {SYMBOLS.map((s) => <Button key={s} size="sm" variant="ghost" title={`Insert ${s}`} onClick={() => c().insertContent(s).run()}>{s}</Button>)}
            </div>
          )}
        </Popover>
      </div>
      {inTable && (
        <div className="qm-tgroup">
          <Tool title="Add a row above" onClick={() => c().addRowBefore().run()}>Row above</Tool>
          <Tool title="Add a row below" onClick={() => c().addRowAfter().run()}>Row below</Tool>
          <Tool title="Add a column to the left" onClick={() => c().addColumnBefore().run()}>Column left</Tool>
          <Tool title="Add a column to the right" onClick={() => c().addColumnAfter().run()}>Column right</Tool>
          <Tool title="Delete this row" onClick={() => c().deleteRow().run()}>Delete row</Tool>
          <Tool title="Delete this column" onClick={() => c().deleteColumn().run()}>Delete column</Tool>
          <Tool title="Merge the selected cells (drag across them first)" disabled={!e?.can().mergeCells()} onClick={() => c().mergeCells().run()}>Merge</Tool>
          <Tool title="Split this cell" disabled={!e?.can().splitCell()} onClick={() => c().splitCell().run()}>Split</Tool>
          <Tool title="Make the first row a heading" onClick={() => c().toggleHeaderRow().run()}>Heading row</Tool>
          <Tool title="Borders on or off" on={!e?.getAttributes('table').borderless} onClick={() => c().updateAttributes('table', { borderless: !e?.getAttributes('table').borderless }).run()}>Borders</Tool>
          <Tool title="Delete the table" onClick={() => c().deleteTable().run()}>Delete table</Tool>
        </div>
      )}
      <div className="qm-tgroup">
        <Tool title="Clear formatting" disabled={off} onClick={() => c().unsetAllMarks().setTextAlign('left').run()}><RemoveFormatting className="size-4" /></Tool>
      </div>
      {off && <span className="qm-thint">Click into any text on the paper to format it.</span>}
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(ev) => {
          const files = [...(ev.target.files ?? [])].filter((f) => f.type.startsWith('image/'))
          if (e && files.length) insertImages(e, multi.current ? files : files.slice(0, 1), addImage)
          ev.target.value = ''
        }}
      />
      {storeOpen && e && (
        <ImagePicker
          onClose={() => setStoreOpen(false)}
          onPick={(assets) => {
            setStoreOpen(false)
            remember(assets)
            insertAssets(e, assets)
          }}
        />
      )}
    </div>
  )
}
