import { useQuery } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { api, type List } from '@/lib/api'

/* WHO READS THIS. The owner asked that a parent see where an absence or a
   leave request goes before they send it: the child's class teacher by name,
   and the office that follows up absences (the server's attendanceOwners).
   The head is not told, so the line does not claim it. */
export function SentTo({ studentId }: { studentId: string }) {
  const teachers = useQuery({
    queryKey: ['portal-teachers', studentId],
    queryFn: () =>
      api.get<List<{ user_id: string; full_name: string; class_teacher: boolean }>>(
        `/api/v1/portal/messages/teachers?student_id=${studentId}`),
    enabled: studentId !== '',
  })
  if (studentId === '') return null
  const ct = teachers.data?.items?.find((x) => x.class_teacher)
  return (
    <p className="mt-4 flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[13px]">
      <Send className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span>
        Goes to{' '}
        <b>{ct ? `${ct.full_name} (class teacher)` : 'the class teacher'}</b>
        {' '}and <b>the attendance office</b>.
      </span>
    </p>
  )
}
