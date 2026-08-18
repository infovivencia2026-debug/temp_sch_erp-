import { RemarkBoard } from './Remarks'

/* Anecdotal records — the private half of the same file.

   Same board, same table, one flag apart. It gets its own route because the
   catalogue lists it separately and because a teacher opening "Anecdotal
   Records" is asking a narrower question than "what has anyone written about
   this class"; what it must never be is a second store with its own idea of
   who may read it. */

export default function Anecdotal() {
  return (
    <RemarkBoard
      anecdotal
      eyebrow="Teaching workspace"
      title="Anecdotal records"
      description="Private observations on how a child is growing. Kept for the staff who teach them and never shown to the family."
    />
  )
}
