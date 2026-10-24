import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Dialog, ErrorState, Loading } from '@/components/ui'
import { readDoc } from './lib/doc'
import PaperPreview from './editor/PaperPreview'
import { useSchoolHead } from './PaperEditor'
import './lib/fonts-css'

/* A paper written in Question maker, as it was sent for approval: read on
   screen at A4, with its answer key, and printed from here. Not offered as a
   Word file, for the same reason an uploaded paper is not downloaded: a copy
   of an unsat paper in a Downloads folder is what a school does not want. */
export default function SentPaper({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const school = useSchoolHead()
  const q = useQuery({ queryKey: ['question-paper-doc', id], queryFn: () => api.get<{ doc: unknown }>(`/api/v1/exams/question-papers/${id}/doc`) })
  if (q.data) return <PaperPreview doc={readDoc(q.data.doc)} school={school} title={title} word={false} onClose={onClose} />
  return (
    <Dialog title={title} size="xl" onClose={onClose}>
      {q.error ? <ErrorState error={q.error} /> : <Loading shape="page" />}
    </Dialog>
  )
}
