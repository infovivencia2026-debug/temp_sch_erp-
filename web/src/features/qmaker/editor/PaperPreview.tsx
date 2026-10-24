import { useState } from 'react'
import { FileDown, Printer } from 'lucide-react'
import { Button, Dialog, FormNotice, TAB_BAR, tabClass } from '@/components/ui'
import A4Frame from '@/components/A4Frame'
import type { PaperDoc, SchoolHead } from '../lib/doc'
import { paperDocumentHtml, printPaper } from '../lib/renderHtml'
import { download, safeFileName } from '../lib/util'

/* The paper, or its answer key, at A4 as it will print (shrunk to fit on a
   phone, never re-flowed). Print from here; Word is offered where the reader
   may need to change it. */
export default function PaperPreview({ doc, school, title, onClose, word = true }: {
  doc: PaperDoc
  school: SchoolHead
  title: string
  onClose: () => void
  /** Offer the Word file too (the teacher's own paper; not a paper being reviewed). */
  word?: boolean
}) {
  const [key, setKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const base = safeFileName([doc.examName || 'Paper', doc.className, doc.subject].filter(Boolean).join(' - '))

  const toWord = async () => {
    setBusy(true)
    setError(null)
    try {
      const { renderPaperDocx } = await import('../lib/renderDocx')
      const bytes = await renderPaperDocx(doc, school, key)
      download(bytes.slice().buffer, `${base}${key ? ' - Answer key' : ''}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={title}
      size="xl"
      onClose={onClose}
      footer={<>
        {word && <Button variant="secondary" pending={busy} disabled={busy} onClick={toWord}><FileDown className="size-4" /> Word file</Button>}
        <Button onClick={() => printPaper(doc, school, key)}><Printer className="size-4" /> {key ? 'Print the answer key' : 'Print the paper'}</Button>
      </>}
    >
      <div className="space-y-3">
        <div className={TAB_BAR} role="tablist">
          <button type="button" role="tab" aria-selected={!key} className={tabClass(!key)} onClick={() => setKey(false)}>Paper</button>
          <button type="button" role="tab" aria-selected={key} className={tabClass(key)} onClick={() => setKey(true)}>Answer key</button>
        </div>
        <FormNotice error={error} />
        <p className="text-[12px] text-muted-foreground">To keep a PDF, press Print and choose Save as PDF.</p>
        <A4Frame key={String(key)} title={key ? 'Answer key' : 'Question paper'} html={paperDocumentHtml(doc, school, key, '14mm')} />
      </div>
    </Dialog>
  )
}
