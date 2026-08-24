import { screen } from '@/lib/screen'

/* The infirmary and the rest of the boarding house.

   Kept out of registry.ts so this batch of screens can be added without four
   agents editing one map at once. Spread into FEATURE_COMPONENTS there.

   Two keys share a screen where the two features are genuinely one job: a
   nurse's visit log and the medication register are the same half hour at the
   same trolley, and an annual card and the camp that filled it in are the same
   piece of paper. */
export const healthKeys = {
  'institution_admin.hostel.night_study_room_attendance': screen(() => import('./HostelNightStudy')),
  'institution_admin.hostel.room_inventory_checklists': screen(() => import('./HostelRoomChecks')),
  'institution_admin.hostel.hostel_visitor_log': screen(() => import('./HostelVisitors')),
  'institution_admin.hostel.boarder_laundry_tracking': screen(() => import('./HostelLaundry')),
}
