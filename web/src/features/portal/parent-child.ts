import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/* THE CHILD AND THE ACADEMIC YEAR THE PARENT APP IS ABOUT (owner, 2026-11-26).

   The child follows the dashboard's switcher: `?student_id=` in the address,
   then this tab's choice, then the last child opened on this device (the same
   keys Portal.tsx and use-children.ts keep). The academic year is the
   dashboard card's picker: `?ay=` in the address, then the device's last
   choice; none means the child's current year. */
const YEAR_KEY = 'portal-year'

export function rememberedChildId(): string {
  try {
    return sessionStorage.getItem('portal-child') ?? localStorage.getItem('portal-last-child') ?? ''
  } catch {
    return ''
  }
}

function rememberedYear(): string {
  try { return localStorage.getItem(YEAR_KEY) ?? '' } catch { return '' }
}

/** The chosen academic year id ('' = the current one) and its setter. */
export function useParentYear(): [string, (id: string) => void] {
  const [params, setParams] = useSearchParams()
  const year = params.get('ay') ?? rememberedYear()
  const setYear = useCallback((id: string) => {
    try { if (id) localStorage.setItem(YEAR_KEY, id); else localStorage.removeItem(YEAR_KEY) } catch { /* private mode: the address still carries it */ }
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (id) next.set('ay', id); else next.delete('ay')
      return next
    }, { replace: true })
  }, [setParams])
  return [year, setYear]
}

export interface ChildSubject {
  class_subject_id: string; subject: string; periods_per_week: number
  teacher?: string; teacher_photo?: string
}
export interface ChildActivity { id: string; name: string; category?: string | null; schedule?: string | null; venue?: string | null }
export interface ChildProfile {
  student_id: string; full_name: string; admission_no: string
  admission_date?: string; photo_file_id?: string
  date_of_birth?: string; blood_group?: string; apaar_id?: string; has_transport?: boolean
  years: { academic_year_id: string; academic_year: string; is_current: boolean }[]
  academic_year_id?: string; academic_year?: string
  class_name?: string; section_name?: string; roll_no?: number
  subjects: ChildSubject[]
  eca: ChildActivity[]
}

export function useChildProfile(studentId: string | null | undefined, year: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['portal-child-profile', studentId ?? '', year],
    queryFn: () => {
      const q = new URLSearchParams()
      if (studentId) q.set('student_id', studentId)
      if (year) q.set('academic_year_id', year)
      return api.get<ChildProfile>(`/api/v1/portal/child-profile?${q}`)
    },
    retry: false,
  })
}

export const fileSrc = (id: string) => `/api/v1/files/${id}?inline=1`

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}
