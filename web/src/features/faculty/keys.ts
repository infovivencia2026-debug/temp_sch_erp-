import { screen } from '@/lib/screen'

/* The faculty communication screens, keyed by catalogue entry.

   Keys are the ones internal/catalog carries — faculty.communication.*,
   not faculty.communication.* — because the catalogue is generated from
   docs/edu_features.csv and the SPA's router looks the component up by the key
   it was navigated to. A key invented here would render the honest "catalogued,
   not implemented" placeholder instead of the screen.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in and runs `make
   catalog` so internal/api/implemented_gen.go agrees with it. */
export const facultyCommsKeys = {
  'faculty.communication.remarks': screen(() => import('./Remarks')),
  'faculty.communication.anecdotal_records': screen(() => import('./Anecdotal')),
  'faculty.communication.class_teacher_remarks': screen(() => import('./ClassTeacherRemarks')),
  'faculty.communication.ptm_notes_action_items': screen(() => import('./PTMNotes')),
  'faculty.communication.classroom_communication': screen(() => import('./Broadcasts')),
  'faculty.communication.communication': screen(() => import('./Communication')),
}
