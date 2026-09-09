import { activeRole, modulesForRole } from './index'

/* ===========================================================================
   WHAT A ROLE MAY DO, NOT JUST WHAT IT MAY SEE

   Reaching a module and being able to change it are different questions. A
   student can open LMS — that is where their courses are — but was being
   offered "Create course", Import, Add, bulk Approve and Delete on it. The
   route guard let them through because reaching the page is correct; nothing
   then asked whether they were allowed to act.

   So each role gets a set of modules it can write to. Everything else it can
   reach is read-only: it still opens, still lists, still exports, but the
   controls that would change a record are not drawn at all — offering an
   action and then refusing it is worse than never offering it.
   =========================================================================== */

/** Modules a role may create, edit and delete in. '*' means every module. */
const WRITE: Record<string, string[] | '*'> = {
  'super-admin': '*',
  'institution-admin': '*',
  principal: '*',

  dean: ['academics', 'examinations', 'timetable', 'research', 'workload', 'accreditation', 'obe'],
  hod: ['academics', 'timetable', 'attendance', 'examinations', 'workload', 'lms', 'obe'],

  faculty: ['attendance', 'examinations', 'lms', 'homework', 'timetable'],
  accountant: ['finance', 'scholarships', 'payroll', 'procurement', 'assets'],
  'hr-manager': ['hr', 'payroll', 'recruitment', 'workload', 'documents'],
  librarian: ['library'],
  'transport-manager': ['transport', 'assets', 'facilities'],
  'admission-counselor': ['admissions', 'forms'],

  // The people the records are about. They raise things; they do not edit the
  // institution's copy of their own record.
  student: ['helpdesk', 'student-portal'],
  parent: ['helpdesk', 'parent-portal'],
}

/** May this role change records in this module? */
export function canWrite(roleId: string, moduleId: string): boolean {
  const allowed = WRITE[roleId]
  if (allowed === undefined) {
    // A role with no entry inherits from its reach: unrestricted roles write
    // everywhere, scoped ones are read-only until they are listed above.
    const role = activeRole(roleId)
    return role?.modules === '*'
  }
  if (allowed === '*') return true
  return allowed.includes(moduleId)
}

/** Modules this role can act in — used to build create menus. */
export function writableModules(roleId: string): string[] {
  return modulesForRole(roleId).map((m) => m.id).filter((id) => canWrite(roleId, id))
}
