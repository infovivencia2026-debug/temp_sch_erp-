import type { QueryClient } from '@tanstack/react-query'

/* A concession is shown on five screens: the fee desk's Concessions tab,
   Approvals, the attention strip, a child's fee card and Fee & Enrolment, and
   in the bell. Deciding it on one of them left the others saying "pending"
   until their five-minute cache ran out (owner, 2026-10-23: "after approved,
   still showing pending"), so every write refreshes all of them. */
export function refreshConcessions(qc: QueryClient): void {
  for (const key of ['concessions', 'approvals', 'attention', 'notifications', 'student-detail', 'pending-admissions']) {
    qc.invalidateQueries({ queryKey: [key] })
  }
}
