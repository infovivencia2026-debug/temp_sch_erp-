import { lazy } from 'react'

/* The faculty communication screens, keyed by catalogue entry.

   Keys are the ones internal/catalog carries — faculty.teaching_workspace.*,
   not faculty.communication.* — because the catalogue is generated from
   docs/edu_features.csv and the SPA's router looks the component up by the key
   it was navigated to. A key invented here would render the honest "catalogued,
   not implemented" placeholder instead of the screen.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs `make
   catalog` so internal/api/implemented_gen.go agrees with it. */
export const facultyCommsKeys = {
  'faculty.teaching_workspace.remarks': lazy(() => import('./Remarks')),
  'faculty.teaching_workspace.anecdotal_records': lazy(() => import('./Anecdotal')),
  'faculty.teaching_workspace.class_teacher_remarks': lazy(() => import('./ClassTeacherRemarks')),
  'faculty.teaching_workspace.ptm_notes_action_items': lazy(() => import('./PTMNotes')),
  'faculty.teaching_workspace.classroom_communication_broadcasting': lazy(() => import('./Broadcasts')),
  'faculty.teaching_workspace.communication': lazy(() => import('./Communication')),
}
