import { BoardRoll } from './BoardRoll'

/** Class 10 with BSE Telangana. The roll itself is BoardRoll; this names the
    examination, since the board, the class and the subject list are the only
    things that differ from the Intermediate roll. */
export default function SSCRegistration() {
  return (
    <BoardRoll
      stage="ssc"
      eyebrow="Examinations"
      title="SSC board registration"
      description="The Class 10 nominal roll for BSE Telangana: who is entered, what they are entered for, and what the board has said about each of them."
      defaultBoard="BSE Telangana"
      defaultExamName={`SSC Public Examination March ${new Date().getFullYear() + 1}`}
      defaultSubjects="Telugu, Hindi, English, Mathematics, Science, Social Studies"
    />
  )
}
