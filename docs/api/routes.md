# Route inventory

Every route the router declares under `/api/v1`, extracted mechanically from
the `chi` declarations in `internal/api/*.go` (excluding `_test.go`) rather
than written by hand: a list of twelve hundred endpoints maintained by reading
is a list that is wrong within a week.

**This is an inventory, not a contract.** Most of these routes exist to drive
one screen and change with it. `docs/api/openapi.yaml` says which ones an
integration may rely on. If a route is here and not there, ask before you
build on it.

The permission column is what the route's own middleware demands, including
anything inherited from the group it sits in. A blank cell means the route
carries no `RequirePermission` of its own: either it is public (the
`/public/*` and device routes), or it is open to any signed-in member of the
school and the handler narrows the rows itself - the fee ledger and the parent
portal both work that way. Blank does not mean unguarded.

Some routes name two permissions because the group requires one and the route
requires another; both are needed.

Counted 1228 routes in 139 top-level groups.


## /abc  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/abc` | - | `getAcademicBankOfCredits` | `student_learning.go` |

## /absence  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/absence` | - | `reportChildAbsence` | `portal_requests.go` |

## /academic-record  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/academic-record` | - | `getAcademicRecord` | `student_learning.go` |

## /academics  (12)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/academics/activities` | `academics.read` | `listActivities` | `api.go` |
| POST | `/academics/activities` | `academics.read`, `academics.write` | `saveActivity` | `api.go` |
| GET | `/academics/classes` | `academics.read` | `listClasses` | `api.go` |
| GET | `/academics/co-scholastic-areas` | `academics.read` | `listCoScholasticAreas` | `api.go` |
| GET | `/academics/houses` | `academics.read` | `listHouses` | `api.go` |
| POST | `/academics/houses` | `academics.read`, `academics.write` | `saveHouse` | `api.go` |
| DELETE | `/academics/houses/{id}` | `academics.read`, `academics.write` | `deleteHouse` | `api.go` |
| GET | `/academics/iep` | - | `getFamilyIEP` | `portal_school_life.go` |
| GET | `/academics/sections` | `academics.read` | `listSections` | `api.go` |
| GET | `/academics/subjects` | `academics.read` | `listSubjects` | `api.go` |
| GET | `/academics/terms` | `academics.read` | `listTerms` | `api.go` |
| GET | `/academics/years` | `academics.read` | `listAcademicYears` | `api.go` |

## /admin  (56)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/admin/alumni` | `students.read.all` | `getAlumni` | `admin_academics.go` |
| POST | `/admin/alumni/contributions` | `students.write` | `recordAlumniContribution` | `admin_academics.go` |
| GET | `/admin/alumni/events` | `students.read.all` | `listAlumniEvents` | `admin_academics.go` |
| POST | `/admin/alumni/events` | `students.write` | `saveAlumniEvent` | `admin_academics.go` |
| POST | `/admin/alumni/events/{id}/attendance` | `students.write` | `recordAlumniAttendance` | `admin_academics.go` |
| POST | `/admin/alumni/profiles` | `students.write` | `saveAlumniProfile` | `admin_academics.go` |
| GET | `/admin/assignable-roles` | - | `listAssignableRoles` | `api.go` |
| GET | `/admin/audit` | `admin.audit.read` | `listAudit` | `api.go` |
| GET | `/admin/audit/summary` | `admin.audit.read` | `getAuditSummary` | `api.go` |
| GET | `/admin/calendar` | - | `getAcademicCalendar` | `admin_academics.go` |
| POST | `/admin/calendar` | `academics.write` | `saveCalendarEntry` | `admin_academics.go` |
| GET | `/admin/calendar/day` | - | `getCalendarDay` | `admin_academics.go` |
| DELETE | `/admin/calendar/{id}` | `academics.write` | `deleteCalendarEntry` | `admin_academics.go` |
| GET | `/admin/council` | `students.read.all` | `getCouncil` | `admin_academics.go` |
| POST | `/admin/council/duties` | `students.write` | `saveCouncilDuty` | `admin_academics.go` |
| POST | `/admin/council/members` | `students.write` | `saveCouncilMember` | `admin_academics.go` |
| POST | `/admin/council/positions` | `students.write` | `saveCouncilPosition` | `admin_academics.go` |
| GET | `/admin/department-students` | `students.read.all` | `getDepartmentStudents` | `admin_academics.go` |
| GET | `/admin/exam-monitor` | `admin.reports.read` | `getExamMonitor` | `admin_academics.go` |
| POST | `/admin/exam-monitor/approve` | `academics.exams.write` | `approveExamMarks` | `admin_academics.go` |
| GET | `/admin/faculty-allocation` | `academics.write` | `getFacultyAllocation` | `admin_academics.go` |
| POST | `/admin/faculty-allocation` | `academics.write` | `setFacultyAllocation` | `admin_academics.go` |
| POST | `/admin/faculty-allocation/apply` | `academics.write` | `applyAllocationToTimetable` | `admin_academics.go` |
| GET | `/admin/incidents` | `students.read.all` | `listIncidents` | `admin_academics.go` |
| POST | `/admin/incidents/{id}` | `students.write` | `updateIncident` | `admin_academics.go` |
| GET | `/admin/installable-roles` | `access.roles.read` | `listInstallableRoles` | `api.go` |
| GET | `/admin/institutions` | - | `listInstitutions` | `api.go` |
| GET | `/admin/modules` | `institution.read` | `listModules` | `api.go` |
| PUT | `/admin/modules` | `institution.settings.write` | `setModule` | `api.go` |
| GET | `/admin/outcomes` | `admin.reports.read` | `getOutcomes` | `admin_academics.go` |
| GET | `/admin/outcomes/attainment` | `admin.reports.read` | `getOutcomeAttainment` | `admin_academics.go` |
| POST | `/admin/outcomes/course` | `academics.write` | `saveCourseOutcome` | `admin_academics.go` |
| PUT | `/admin/outcomes/mapping` | `academics.write` | `setOutcomeMapping` | `admin_academics.go` |
| POST | `/admin/outcomes/programme` | `academics.write` | `saveProgrammeOutcome` | `admin_academics.go` |
| GET | `/admin/platform-dashboard` | - | `getPlatformDashboard` | `api.go` |
| GET | `/admin/role-presets` | `access.roles.read` | `listRolePresets` | `api.go` |
| GET | `/admin/roles` | `access.roles.read` | `listRoles` | `api.go` |
| POST | `/admin/roles` | `access.roles.write` | `createRole` | `api.go` |
| POST | `/admin/roles/install` | `access.roles.write` | `installRole` | `api.go` |
| GET | `/admin/roles/templates` | `access.roles.read` | `listRoleTemplates` | `api.go` |
| GET | `/admin/roles/{id}/grid` | `access.roles.read` | `getRoleGrid` | `api.go` |
| PUT | `/admin/roles/{id}/grid` | `access.roles.write` | `setRoleGrid` | `api.go` |
| GET | `/admin/roles/{id}/permissions` | `access.roles.read` | `getRolePermissions` | `api.go` |
| GET | `/admin/sessions` | `admin.audit.read` | `listSessions` | `api.go` |
| DELETE | `/admin/sessions/{id}` | `access.sessions.revoke` | `revokeSession` | `api.go` |
| GET | `/admin/substitution-board` | `academics.timetable.write` | `getSubstitutionBoard` | `admin_academics.go` |
| GET | `/admin/users` | `access.users.read` | `listUsers` | `api.go` |
| POST | `/admin/users` | `access.users.write` | `createUser` | `api.go` |
| POST | `/admin/users/generic` | `access.roles.write` | `createGenericAccount` | `api.go` |
| POST | `/admin/users/roles/transfer` | `access.roles.write` | `transferRoles` | `api.go` |
| GET | `/admin/users/{id}` | `access.users.read` | `getUser` | `api.go` |
| POST | `/admin/users/{id}/reset-password` | `access.users.write` | `resetUserPassword` | `api.go` |
| PUT | `/admin/users/{id}/roles` | `access.roles.write` | `setRoles` | `api.go` |
| PUT | `/admin/users/{id}/status` | `access.users.write` | `setUserStatus` | `api.go` |
| GET | `/admin/year-plan` | - | `getYearPlan` | `admin_academics.go` |
| POST | `/admin/year-plan/import` | `academics.write` | `importYearPlan` | `admin_academics.go` |

## /admin-ops  (43)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/admin-ops/evaluation/cycles` | `hr.employees.read` | `listEvaluationCycles` | `admin_ops.go` |
| POST | `/admin-ops/evaluation/cycles` | `hr.employees.write` | `saveEvaluationCycle` | `admin_ops.go` |
| GET | `/admin-ops/evaluation/cycles/{id}` | `hr.employees.read` | `getEvaluationCycle` | `admin_ops.go` |
| POST | `/admin-ops/evaluation/cycles/{id}/invitations` | `hr.employees.write` | `inviteEvaluationRespondents` | `admin_ops.go` |
| PUT | `/admin-ops/evaluation/cycles/{id}/questions` | `hr.employees.write` | `setEvaluationQuestions` | `admin_ops.go` |
| POST | `/admin-ops/evaluation/cycles/{id}/reviewees` | `hr.employees.write` | `addEvaluationReviewees` | `admin_ops.go` |
| POST | `/admin-ops/evaluation/cycles/{id}/status` | `hr.employees.write` | `setEvaluationCycleStatus` | `admin_ops.go` |
| POST | `/admin-ops/evaluation/invitations/{id}/respond` | - | `submitEvaluationResponse` | `admin_ops.go` |
| GET | `/admin-ops/evaluation/my-invitations` | - | `listMyEvaluationInvitations` | `admin_ops.go` |
| POST | `/admin-ops/evaluation/reviewees/{id}/release` | `hr.employees.write` | `releaseEvaluationReviewee` | `admin_ops.go` |
| GET | `/admin-ops/evaluation/reviewees/{id}/results` | - | `getEvaluationResults` | `admin_ops.go` |
| GET | `/admin-ops/fee-filings` | `finance.fees.read` | `listFeeFilings` | `admin_ops.go` |
| POST | `/admin-ops/fee-filings` | `finance.fees.write` | `saveFeeFiling` | `admin_ops.go` |
| GET | `/admin-ops/fee-filings/{id}` | `finance.fees.read` | `getFeeFiling` | `admin_ops.go` |
| POST | `/admin-ops/fee-filings/{id}/decide` | `finance.fees.write` | `decideFeeFiling` | `admin_ops.go` |
| POST | `/admin-ops/fee-filings/{id}/documents` | `finance.fees.write` | `attachFeeFilingDocument` | `admin_ops.go` |
| POST | `/admin-ops/fee-filings/{id}/submit` | `finance.fees.write` | `submitFeeFiling` | `admin_ops.go` |
| GET | `/admin-ops/fee-filings/{id}/variance` | `finance.fees.read` | `getFilingVariance` | `admin_ops.go` |
| GET | `/admin-ops/mdm/foodgrain` | `admin.reports.read` | `listFoodgrainReceipts` | `admin_ops.go` |
| POST | `/admin-ops/mdm/foodgrain` | `institution.write` | `saveFoodgrainReceipt` | `admin_ops.go` |
| GET | `/admin-ops/mdm/norms` | `admin.reports.read` | `listMDMNorms` | `admin_ops.go` |
| POST | `/admin-ops/mdm/norms` | `institution.write` | `saveMDMNorm` | `admin_ops.go` |
| GET | `/admin-ops/mdm/returns` | `admin.reports.read` | `listMDMReturns` | `admin_ops.go` |
| POST | `/admin-ops/mdm/returns` | `institution.write` | `saveMDMReturn` | `admin_ops.go` |
| POST | `/admin-ops/mdm/returns/{id}/finalise` | `institution.write` | `finaliseMDMReturn` | `admin_ops.go` |
| POST | `/admin-ops/mdm/returns/{id}/reopen` | `institution.write` | `reopenMDMReturn` | `admin_ops.go` |
| GET | `/admin-ops/mdm/utilisation` | `admin.reports.read` | `getMDMUtilisation` | `admin_ops.go` |
| GET | `/admin-ops/purchasing/matches` | `operations.inventory.read` | `listInvoiceMatches` | `admin_ops.go` |
| GET | `/admin-ops/purchasing/orders` | `operations.inventory.read` | `listPurchaseOrders` | `admin_ops.go` |
| POST | `/admin-ops/purchasing/orders` | `operations.inventory.write` | `savePurchaseOrder` | `admin_ops.go` |
| GET | `/admin-ops/purchasing/orders/{id}` | `operations.inventory.read` | `getPurchaseOrder` | `admin_ops.go` |
| POST | `/admin-ops/purchasing/orders/{id}/close` | `operations.inventory.write` | `closePurchaseOrder` | `admin_ops.go` |
| POST | `/admin-ops/purchasing/orders/{id}/issue` | `operations.inventory.write` | `issuePurchaseOrder` | `admin_ops.go` |
| GET | `/admin-ops/purchasing/orders/{id}/match` | `operations.inventory.read` | `previewInvoiceMatch` | `admin_ops.go` |
| POST | `/admin-ops/purchasing/orders/{id}/match` | `finance.invoices.write` | `recordInvoiceMatch` | `admin_ops.go` |
| POST | `/admin-ops/purchasing/orders/{id}/receipts` | `operations.inventory.write` | `recordGoodsReceipt` | `admin_ops.go` |
| GET | `/admin-ops/purchasing/requisitions` | `operations.inventory.read` | `listRequisitions` | `admin_ops.go` |
| POST | `/admin-ops/purchasing/requisitions` | `operations.inventory.write` | `saveRequisition` | `admin_ops.go` |
| GET | `/admin-ops/purchasing/requisitions/{id}` | `operations.inventory.read` | `getRequisition` | `admin_ops.go` |
| POST | `/admin-ops/purchasing/requisitions/{id}/decide` | - | `decideRequisition` | `admin_ops.go` |
| POST | `/admin-ops/purchasing/requisitions/{id}/submit` | `operations.inventory.write` | `submitRequisition` | `admin_ops.go` |
| GET | `/admin-ops/purchasing/thresholds` | `operations.inventory.read` | `listApprovalThresholds` | `admin_ops.go` |
| PUT | `/admin-ops/purchasing/thresholds` | `institution.settings.write` | `setApprovalThresholds` | `admin_ops.go` |

## /admission  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/admission` | - | `getPortalAdmission` | `portal_admission.go` |

## /admissions  (32)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/admissions/applications` | `admissions.read` | `listApplications` | `api.go` |
| POST | `/admissions/applications/patch` | `admissions.read`, `admissions.write` | `patchApplication` | `api.go` |
| GET | `/admissions/dashboard` | `admissions.read` | `getAdmissionsDashboard` | `api.go` |
| GET | `/admissions/enquiries` | `admissions.read` | `listEnquiries` | `api.go` |
| GET | `/admissions/leads` | `admissions.read` | `listLeads` | `api.go` |
| POST | `/admissions/leads/assign` | `admissions.read`, `admissions.write` | `assignLeads` | `api.go` |
| POST | `/admissions/message` | `admissions.read`, `admissions.write` | `messageApplicants` | `api.go` |
| GET | `/admissions/open-days` | `admissions.read` | `listOpenDays` | `api.go` |
| POST | `/admissions/open-days` | `admissions.read`, `admissions.write` | `createOpenDay` | `api.go` |
| POST | `/admissions/open-days/book` | `admissions.read`, `admissions.write` | `bookOpenDay` | `api.go` |
| GET | `/admissions/open-days/{id}/bookings` | `admissions.read` | `listOpenDayBookings` | `api.go` |
| GET | `/admissions/open-days/{id}/slots` | `admissions.read` | `listOpenDaySlots` | `api.go` |
| GET | `/admissions/prospectus` | `admissions.read` | `listProspectusSales` | `api.go` |
| POST | `/admissions/prospectus` | `admissions.read`, `admissions.write` | `sellProspectus` | `api.go` |
| GET | `/admissions/register` | `admissions.read` | `getAdmissionRegister` | `api.go` |
| POST | `/admissions/rte/import` | `admissions.read`, `admissions.write` | `importRTELottery` | `api.go` |
| GET | `/admissions/siblings` | `admissions.read` | `findSiblings` | `api.go` |
| GET | `/admissions/sources` | `admissions.read` | `getLeadSources` | `api.go` |
| POST | `/admissions/waitlist/promote` | `admissions.read`, `admissions.write` | `promoteWaitlist` | `api.go` |
| POST | `/admissions/workflow/applications` | `admissions.read`, `admissions.write` | `createApplication` | `api.go` |
| POST | `/admissions/workflow/applications/{id}/assessment` | `admissions.read`, `admissions.write` | `recordAssessment` | `api.go` |
| POST | `/admissions/workflow/applications/{id}/decision` | `admissions.read`, `admissions.write` | `decideApplication` | `api.go` |
| GET | `/admissions/workflow/applications/{id}/documents` | `admissions.read` | `listApplicationDocuments` | `api.go` |
| POST | `/admissions/workflow/applications/{id}/enrol` | `admissions.read`, `students.write` | `enrolApplicant` | `api.go` |
| GET | `/admissions/workflow/applications/{id}/fees` | `admissions.read` | `getAdmissionFees` | `api.go` |
| POST | `/admissions/workflow/enquiries` | `admissions.read`, `admissions.write` | `createEnquiry` | `api.go` |
| PUT | `/admissions/workflow/enquiries/{id}` | `admissions.read`, `admissions.write` | `updateEnquiry` | `api.go` |
| GET | `/admissions/workflow/funnel` | `admissions.read` | `getAdmissionsFunnel` | `api.go` |
| GET | `/admissions/workflow/merit` | `admissions.read` | `getMeritList` | `api.go` |
| GET | `/admissions/workflow/seats` | `admissions.read` | `getSeatMatrix` | `api.go` |
| GET | `/admissions/workflow/stages` | `admissions.read` | `getAdmissionStages` | `api.go` |
| PUT | `/admissions/workflow/stages` | `admissions.read`, `admissions.write` | `saveAdmissionStages` | `api.go` |

## /alumni  (6)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/alumni/directory` | - | `listAlumniDirectory` | `student_learning.go` |
| GET | `/alumni/jobs` | - | `listAlumniJobs` | `student_learning.go` |
| POST | `/alumni/jobs/{id}/interest` | - | `registerJobInterest` | `student_learning.go` |
| POST | `/alumni/jobs/{id}/withdraw` | - | `withdrawJobInterest` | `student_learning.go` |
| GET | `/alumni/profile` | - | `getAlumniProfile` | `student_learning.go` |
| POST | `/alumni/profile` | - | `saveAlumniRegistration` | `student_learning.go` |

## /api-keys  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/api-keys` | `access.users.read` | `listAPIKeys` | `api_keys.go` |
| POST | `/api-keys` | `access.users.write` | `issueAPIKey` | `api_keys.go` |
| POST | `/api-keys/{id}/revoke` | `access.users.write` | `revokeAPIKey` | `api_keys.go` |

## /applications  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/applications/{id}/answers` | - | `getApplicationAnswers` | `admissions_growth.go` |

## /assignments  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/assignments` | - | `listTeachingAssignments` | `teaching.go` |
| POST | `/assignments/{id}/grade` | - | `gradeAssignmentSubmissions` | `teaching.go` |
| GET | `/assignments/{id}/submissions` | - | `listAssignmentSubmissions` | `teaching.go` |

## /assistant  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/assistant/ask` | - | `assistantAsk` | `api.go` |
| POST | `/assistant/chat` | - | `assistantChat` | `api.go` |

## /attendance  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/attendance` | `academics.attendance.read` | `listAttendance` | `api.go` |
| POST | `/attendance` | `academics.attendance.write` | `markAttendance` | `api.go` |

## /attendance-workflow  (4)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/attendance-workflow/absence-alerts` | `comms.messages.send` | `sendAbsenceAlerts` | `api.go` |
| GET | `/attendance-workflow/corrections` | `academics.attendance.read` | `listCorrections` | `api.go` |
| POST | `/attendance-workflow/corrections` | `academics.attendance.write` | `requestCorrection` | `api.go` |
| POST | `/attendance-workflow/corrections/{id}/decide` | `academics.attendance.write.any` | `decideCorrection` | `api.go` |

## /attention  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/attention` | - | `getAttention` | `api.go` |

## /background-checks  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/background-checks` | - | `listBackgroundChecks` | `hr_lifecycle.go` |
| POST | `/background-checks` | `hr.employees.write` | `saveBackgroundCheck` | `hr_lifecycle.go` |

## /banking  (27)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/banking/accounts` | `finance.payments.read` | `listBankAccounts` | `banking.go` |
| POST | `/banking/accounts` | `finance.payments.write` | `saveBankAccount` | `banking.go` |
| POST | `/banking/lines/{id}/match` | `finance.payments.write` | `matchStatementLine` | `banking.go` |
| POST | `/banking/lines/{id}/unmatch` | `finance.payments.write` | `unmatchStatementLine` | `banking.go` |
| GET | `/banking/payouts` | `finance.payments.read` | `listPayoutBatches` | `banking.go` |
| POST | `/banking/payouts` | `finance.payments.write` | `createPayoutBatch` | `banking.go` |
| GET | `/banking/payouts/candidates` | `finance.payments.read` | `listPayoutCandidates` | `banking.go` |
| GET | `/banking/payouts/providers` | `finance.payments.read` | `listPayoutProviders` | `banking.go` |
| GET | `/banking/payouts/{id}` | `finance.payments.read` | `getPayoutBatch` | `banking.go` |
| POST | `/banking/payouts/{id}/decide` | `finance.refunds.write` | `decidePayoutBatch` | `banking.go` |
| GET | `/banking/payouts/{id}/file` | `finance.export` | `exportPayoutFile` | `banking.go` |
| POST | `/banking/payouts/{id}/items` | `finance.payments.write` | `addPayoutItems` | `banking.go` |
| DELETE | `/banking/payouts/{id}/items/{itemID}` | `finance.payments.write` | `removePayoutItem` | `banking.go` |
| POST | `/banking/payouts/{id}/submit` | `finance.payments.write` | `submitPayoutBatch` | `banking.go` |
| GET | `/banking/reconciliations` | `finance.payments.read` | `listBankReconciliations` | `banking.go` |
| POST | `/banking/reconciliations` | `finance.payments.write` | `saveBankReconciliation` | `banking.go` |
| GET | `/banking/reconciliations/{id}` | `finance.payments.read` | `getBankReconciliation` | `banking.go` |
| POST | `/banking/reconciliations/{id}/auto-match` | `finance.payments.write` | `autoMatchStatement` | `banking.go` |
| GET | `/banking/reconciliations/{id}/candidates/{lineID}` | `finance.payments.read` | `getMatchCandidates` | `banking.go` |
| POST | `/banking/reconciliations/{id}/finalise` | `finance.refunds.write` | `finaliseBankReconciliation` | `banking.go` |
| POST | `/banking/reconciliations/{id}/import` | `finance.payments.write` | `importBankStatement` | `banking.go` |
| POST | `/banking/reconciliations/{id}/reopen` | `finance.refunds.write` | `reopenBankReconciliation` | `banking.go` |
| GET | `/banking/student-accounts` | `finance.payments.read` | `listStudentBankAccounts` | `banking.go` |
| POST | `/banking/student-accounts` | `finance.payments.write` | `saveStudentBankAccount` | `banking.go` |
| POST | `/banking/student-accounts/{id}/primary` | `finance.payments.write` | `makeStudentAccountPrimary` | `banking.go` |
| GET | `/banking/student-accounts/{id}/reveal` | `finance.export` | `revealStudentBankAccount` | `banking.go` |
| POST | `/banking/student-accounts/{id}/verify` | `finance.payments.write` | `verifyStudentBankAccount` | `banking.go` |

## /board  (17)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/board/amendments` | `students.read.all` | `listBoardAmendments` | `board_exams.go` |
| POST | `/board/amendments/{id}/decide` | `academics.exams.write` | `decideBoardAmendment` | `board_exams.go` |
| GET | `/board/analysis/baseline` | `admin.reports.read` | `getBaselineAnalysis` | `board_exams.go` |
| GET | `/board/eligible` | `students.read.all` | `listBoardEligible` | `board_exams.go` |
| GET | `/board/performance` | `admin.reports.read` | `getBoardPerformance` | `board_exams.go` |
| GET | `/board/registrations` | `students.read.all` | `listBoardRegistrations` | `board_exams.go` |
| POST | `/board/registrations` | `academics.exams.write` | `addBoardCandidates` | `board_exams.go` |
| PUT | `/board/registrations/{id}` | `academics.exams.write` | `editBoardRegistration` | `board_exams.go` |
| POST | `/board/registrations/{id}/amendments` | `academics.exams.write` | `raiseBoardAmendment` | `board_exams.go` |
| POST | `/board/registrations/{id}/board-response` | `academics.exams.write` | `recordBoardResponse` | `board_exams.go` |
| POST | `/board/registrations/{id}/verify` | `academics.exams.write` | `verifyBoardRegistration` | `board_exams.go` |
| POST | `/board/results/import` | `academics.exams.write` | `importBoardResults` | `board_exams.go` |
| GET | `/board/results/imports` | `students.read.all` | `listBoardResultImports` | `board_exams.go` |
| POST | `/board/results/imports/{id}/publish` | `academics.exams.write` | `publishBoardResults` | `board_exams.go` |
| GET | `/board/results/reconciliation` | `students.read.all` | `getBoardReconciliation` | `board_exams.go` |
| POST | `/board/results/rows/{id}/match` | `academics.exams.write` | `matchBoardResultRow` | `board_exams.go` |
| POST | `/board/submit` | `academics.exams.write` | `submitBoardRoll` | `board_exams.go` |

## /broadcasts  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/broadcasts` | - | `listBroadcasts` | `faculty_comms.go` |

## /bus-tracker  (9)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/bus-tracker/checks` | - | `busTrackerRecordCheck` | `bus_tracker.go` |
| POST | `/bus-tracker/heartbeat` | - | `busTrackerHeartbeatHandler` | `bus_tracker.go` |
| POST | `/bus-tracker/positions` | - | `ingestBusTrackerPositions` | `bus_tracker.go` |
| GET | `/bus-tracker/routes` | - | `busTrackerRoutesForBus` | `bus_tracker.go` |
| POST | `/bus-tracker/session` | - | `busTrackerSignIn` | `bus_tracker.go` |
| POST | `/bus-tracker/session/end` | - | `busTrackerSignOut` | `bus_tracker.go` |
| POST | `/bus-tracker/trips` | - | `startBusTrackerTrip` | `bus_tracker.go` |
| POST | `/bus-tracker/trips/{id}/end` | - | `endBusTrackerTrip` | `bus_tracker.go` |
| GET | `/bus-tracker/trips/{id}/roll` | - | `busTrackerRoll` | `bus_tracker.go` |

## /cafeteria  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/cafeteria/purchases` | - | `listCafeteriaPurchases` | `portal_school_life.go` |

## /calendar  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/calendar` | - | `getStudentCalendar` | `student_learning.go` |

## /campaign-enrolments  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/campaign-enrolments/{id}/stop` | `admissions.write` | `stopCampaignEnrolment` | `admissions_growth.go` |

## /campaign-steps  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| DELETE | `/campaign-steps/{id}` | `admissions.write` | `deleteCampaignStep` | `admissions_growth.go` |

## /campaigns  (8)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/campaigns` | - | `listAdmissionCampaigns` | `admissions_growth.go` |
| POST | `/campaigns` | `admissions.write` | `saveAdmissionCampaign` | `admissions_growth.go` |
| GET | `/campaigns/outbox` | - | `listCampaignOutbox` | `admissions_growth.go` |
| POST | `/campaigns/run` | `admissions.write` | `runCampaignsHandler` | `admissions_growth.go` |
| POST | `/campaigns/{id}/enrol` | `admissions.write` | `enrolLeadsOnCampaign` | `admissions_growth.go` |
| GET | `/campaigns/{id}/enrolments` | - | `listCampaignEnrolments` | `admissions_growth.go` |
| GET | `/campaigns/{id}/steps` | - | `listCampaignSteps` | `admissions_growth.go` |
| POST | `/campaigns/{id}/steps` | `admissions.write` | `saveCampaignStep` | `admissions_growth.go` |

## /campus  (20)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/campus/events` | - | `listClubEvents` | `student_learning.go` |
| POST | `/campus/events/{id}/ticket` | - | `bookEventTicket` | `student_learning.go` |
| GET | `/campus/locker` | - | `getMyLocker` | `student_learning.go` |
| POST | `/campus/locker/access` | - | `logLockerAccess` | `student_learning.go` |
| POST | `/campus/locker/reveal` | - | `revealLockerCombination` | `student_learning.go` |
| GET | `/campus/lost-found` | - | `listLostFound` | `student_learning.go` |
| POST | `/campus/lost-found` | - | `reportLostFound` | `student_learning.go` |
| POST | `/campus/lost-found/claims/{id}/decide` | - | `decideLostFoundClaim` | `student_life.go` |
| POST | `/campus/lost-found/claims/{id}/withdraw` | - | `withdrawLostFoundClaim` | `student_life.go` |
| GET | `/campus/lost-found/{id}/claims` | - | `listLostFoundClaims` | `student_life.go` |
| POST | `/campus/lost-found/{id}/claims` | - | `claimLostFoundItem` | `student_life.go` |
| POST | `/campus/lost-found/{id}/photo` | - | `attachLostFoundPhoto` | `student_life.go` |
| POST | `/campus/lost-found/{id}/resolve` | - | `resolveLostFound` | `student_learning.go` |
| POST | `/campus/tickets/{id}/cancel` | - | `cancelEventTicket` | `student_learning.go` |
| GET | `/campus/wall` | - | `listWallPosts` | `student_life.go` |
| POST | `/campus/wall` | - | `postToWall` | `student_life.go` |
| GET | `/campus/wall/queue` | - | `listWallQueue` | `student_life.go` |
| GET | `/campus/wall/{id}/history` | - | `listWallModeration` | `student_life.go` |
| POST | `/campus/wall/{id}/moderate` | - | `moderateWallPost` | `student_life.go` |
| POST | `/campus/wall/{id}/report` | - | `reportWallPost` | `student_life.go` |

## /catalog  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/catalog` | - | `getCatalog` | `api.go` |

## /cce  (5)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/cce/formative` | - | `listFormativeEntries` | `teaching.go` |
| PUT | `/cce/formative` | - | `saveFormativeEntries` | `teaching.go` |
| GET | `/cce/summative` | - | `listSummativePapers` | `teaching.go` |
| PUT | `/cce/summative` | - | `saveSummativeMarks` | `teaching.go` |
| GET | `/cce/summative/roster` | - | `listSummativeRoster` | `teaching.go` |

## /celebrations  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/celebrations` | - | `listCelebrations` | `hr_lifecycle.go` |
| POST | `/celebrations/greet` | `hr.employees.write` | `recordGreeting` | `hr_lifecycle.go` |

## /classroom  (14)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/classroom/attendance/batches` | `academics.timetable.read` | `listCaptureBatches` | `classroom.go` |
| GET | `/classroom/attendance/conflicts` | `academics.timetable.read` | `listCaptureConflicts` | `classroom.go` |
| GET | `/classroom/diary` | `academics.timetable.read` | `listDiaryEntries` | `classroom.go` |
| GET | `/classroom/grading/tests` | `academics.timetable.read` | `listGradableTests` | `classroom.go` |
| GET | `/classroom/grading/tests/{id}/item-analysis` | `academics.timetable.read` | `getItemAnalysis` | `classroom.go` |
| GET | `/classroom/grading/tests/{id}/key` | `academics.timetable.read` | `getGradingKey` | `classroom.go` |
| GET | `/classroom/grading/tests/{id}/results` | `academics.timetable.read` | `listGradingResults` | `classroom.go` |
| GET | `/classroom/languages/allocation` | `academics.timetable.read` | `getLanguageAllocation` | `classroom.go` |
| GET | `/classroom/languages/elections` | `academics.timetable.read` | `listLanguageElections` | `classroom.go` |
| GET | `/classroom/languages/options` | `academics.timetable.read` | `listLanguageOptions` | `classroom.go` |
| GET | `/classroom/montessori/child/{studentID}` | `academics.timetable.read` | `getMontessoriChild` | `classroom.go` |
| GET | `/classroom/montessori/materials` | `academics.timetable.read` | `listMontessoriMaterials` | `classroom.go` |
| GET | `/classroom/montessori/section` | `academics.timetable.read` | `getMontessoriSection` | `classroom.go` |
| GET | `/classroom/portfolio/{studentID}` | `academics.timetable.read` | `getPortfolioForCuration` | `classroom.go` |

## /clearance-departments  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/clearance-departments` | - | `listClearanceDepartments` | `hr_lifecycle.go` |

## /collections  (31)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/collections/grants/certificates` | `finance.fees.read` | `listGrantCertificates` | `collections.go` |
| POST | `/collections/grants/certificates` | `finance.fees.write` | `saveGrantCertificate` | `collections.go` |
| GET | `/collections/grants/certificates/{id}` | `finance.fees.read` | `getGrantCertificate` | `collections.go` |
| POST | `/collections/grants/certificates/{id}/dispose` | `finance.refunds.write` | `disposeGrantUnspent` | `collections.go` |
| POST | `/collections/grants/certificates/{id}/issue` | `finance.refunds.write` | `issueGrantCertificate` | `collections.go` |
| GET | `/collections/grants/heads` | `finance.fees.read` | `listGrantHeads` | `collections.go` |
| POST | `/collections/grants/heads` | `finance.fees.write` | `saveGrantHead` | `collections.go` |
| GET | `/collections/grants/sanctions` | `finance.fees.read` | `listGrantSanctions` | `collections.go` |
| POST | `/collections/grants/sanctions` | `finance.fees.write` | `saveGrantSanction` | `collections.go` |
| GET | `/collections/grants/sanctions/{id}` | `finance.fees.read` | `getGrantSanction` | `collections.go` |
| POST | `/collections/grants/sanctions/{id}/expenditures` | `finance.fees.write` | `recordGrantExpenditure` | `collections.go` |
| POST | `/collections/grants/sanctions/{id}/receipts` | `finance.fees.write` | `recordGrantReceipt` | `collections.go` |
| GET | `/collections/grants/utilisation` | `finance.fees.read` | `getGrantUtilisation` | `collections.go` |
| GET | `/collections/products` | `finance.fees.read` | `listStoreProducts` | `collections.go` |
| POST | `/collections/products` | `finance.fees.write` | `saveStoreProduct` | `collections.go` |
| GET | `/collections/sales` | `finance.fees.read` | `listPosSales` | `collections.go` |
| POST | `/collections/sales` | `finance.payments.write` | `recordPosSale` | `collections.go` |
| GET | `/collections/sales/{id}` | `finance.fees.read` | `getPosSale` | `collections.go` |
| POST | `/collections/sales/{id}/return` | `finance.refunds.write` | `returnPosSale` | `collections.go` |
| GET | `/collections/sessions` | `finance.fees.read` | `listTillSessions` | `collections.go` |
| POST | `/collections/sessions` | `finance.payments.write` | `openTillSession` | `collections.go` |
| GET | `/collections/sessions/variance` | `finance.fees.read` | `getTillVariance` | `collections.go` |
| GET | `/collections/sessions/{id}` | `finance.fees.read` | `getTillSession` | `collections.go` |
| POST | `/collections/sessions/{id}/close` | `finance.payments.write` | `closeTillSession` | `collections.go` |
| GET | `/collections/settings` | `finance.fees.read` | `getCollectionsSettings` | `collections.go` |
| POST | `/collections/settings` | `finance.fees.write` | `saveCollectionsSettings` | `collections.go` |
| GET | `/collections/stock-items` | `finance.fees.read` | `listStockItems` | `collections.go` |
| GET | `/collections/terminals` | `finance.fees.read` | `listPosTerminals` | `collections.go` |
| POST | `/collections/terminals` | `finance.fees.write` | `savePosTerminal` | `collections.go` |
| GET | `/collections/variants` | `finance.fees.read` | `listStoreVariants` | `collections.go` |
| POST | `/collections/variants` | `finance.fees.write` | `saveStoreVariant` | `collections.go` |

## /comms  (31)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/comms/achievements` | `students.read` | `listShowcase` | `comms.go` |
| POST | `/comms/achievements` | `students.read`, `students.write` | `createShowcaseEntry` | `comms.go` |
| DELETE | `/comms/achievements/{id}` | `students.read`, `students.write` | `deleteShowcaseEntry` | `comms.go` |
| GET | `/comms/achievements/{id}` | `students.read` | `getShowcaseEntry` | `comms.go` |
| PUT | `/comms/achievements/{id}` | `students.read`, `students.write` | `updateShowcaseEntry` | `comms.go` |
| POST | `/comms/achievements/{id}/consent` | `students.read`, `students.write` | `recordShowcaseConsent` | `comms.go` |
| POST | `/comms/achievements/{id}/media` | `students.read`, `students.write` | `addShowcaseMedia` | `comms.go` |
| DELETE | `/comms/achievements/{id}/media/{mediaID}` | `students.read`, `students.write` | `removeShowcaseMedia` | `comms.go` |
| POST | `/comms/achievements/{id}/publish` | `comms.announcements.write`, `students.read`, `students.write` | `publishShowcaseEntry` | `comms.go` |
| POST | `/comms/achievements/{id}/unpublish` | `comms.announcements.write`, `students.read`, `students.write` | `unpublishShowcaseEntry` | `comms.go` |
| GET | `/comms/counselor/contacts` | `self.profile.read` | `listCounselorContacts` | `comms.go` |
| GET | `/comms/counselor/threads` | `self.profile.read` | `listCounselorThreads` | `comms.go` |
| POST | `/comms/counselor/threads` | `self.profile.read` | `openCounselorThread` | `comms.go` |
| GET | `/comms/counselor/threads/{id}` | `self.profile.read` | `getCounselorThread` | `comms.go` |
| POST | `/comms/counselor/threads/{id}/close` | `self.profile.read` | `closeCounselorThread` | `comms.go` |
| GET | `/comms/counselor/threads/{id}/messages` | `self.profile.read` | `listCounselorMessages` | `comms.go` |
| POST | `/comms/counselor/threads/{id}/messages` | `self.profile.read` | `postCounselorMessage` | `comms.go` |
| GET | `/comms/counselor/threads/{id}/participants` | `self.profile.read` | `listCounselorParticipants` | `comms.go` |
| POST | `/comms/counselor/threads/{id}/participants` | `self.profile.read` | `addCounselorParticipant` | `comms.go` |
| POST | `/comms/counselor/threads/{id}/participants/{userID}/remove` | `self.profile.read` | `removeCounselorParticipant` | `comms.go` |
| GET | `/comms/grievance-sla` | `office.front_desk.read` | `listFeedbackSLA` | `comms.go` |
| PUT | `/comms/grievance-sla` | `office.front_desk.read`, `office.front_desk.write` | `saveFeedbackSLA` | `comms.go` |
| GET | `/comms/grievances` | `office.front_desk.read` | `listParentFeedback` | `comms.go` |
| GET | `/comms/grievances/summary` | `office.front_desk.read` | `getFeedbackSummary` | `comms.go` |
| GET | `/comms/grievances/{id}` | `office.front_desk.read` | `getParentFeedback` | `comms.go` |
| POST | `/comms/grievances/{id}/acknowledge` | `office.front_desk.read`, `office.front_desk.write` | `acknowledgeParentFeedback` | `comms.go` |
| POST | `/comms/grievances/{id}/escalate` | `office.front_desk.read`, `office.front_desk.write` | `escalateParentFeedback` | `comms.go` |
| POST | `/comms/grievances/{id}/resolve` | `office.front_desk.read`, `office.front_desk.write` | `resolveParentFeedback` | `comms.go` |
| PUT | `/comms/grievances/{id}/triage` | `office.front_desk.read`, `office.front_desk.write` | `triageParentFeedback` | `comms.go` |
| GET | `/comms/grievances/{id}/updates` | `office.front_desk.read` | `listFeedbackUpdates` | `comms.go` |
| POST | `/comms/grievances/{id}/updates` | `office.front_desk.read`, `office.front_desk.write` | `addFeedbackUpdate` | `comms.go` |

## /communication  (5)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/communication` | - | `getCommunicationSummary` | `faculty_comms.go` |
| GET | `/communication/circulars` | - | `listCirculars` | `api.go` |
| POST | `/communication/circulars` | `comms.announcements.write` | `publishCircular` | `api.go` |
| POST | `/communication/circulars/{id}/ack` | - | `ackCircular` | `api.go` |
| GET | `/communication/circulars/{id}/delivery` | - | `getCircularDelivery` | `api.go` |

## /compliance  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/compliance/apaar` | `admin.reports.read`, `students.write` | `setAPAARID` | `api.go` |
| GET | `/compliance/udise` | `admin.reports.read` | `getUDISEExport` | `api.go` |

## /concerns  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/concerns` | - | `listPortalConcerns` | `portal_requests.go` |
| POST | `/concerns` | - | `raisePortalConcern` | `portal_requests.go` |

## /concessions  (29)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/concessions/claims` | `finance.fees.read` | `listClaims` | `concessions.go` |
| POST | `/concessions/claims` | `finance.fees.write` | `saveClaim` | `concessions.go` |
| GET | `/concessions/claims/ageing` | `finance.fees.read` | `getClaimAgeing` | `concessions.go` |
| GET | `/concessions/claims/{id}` | `finance.fees.read` | `getClaim` | `concessions.go` |
| POST | `/concessions/claims/{id}/build` | `finance.fees.write` | `buildClaimLines` | `concessions.go` |
| GET | `/concessions/claims/{id}/file` | `finance.export` | `exportClaimFile` | `concessions.go` |
| DELETE | `/concessions/claims/{id}/lines/{lineID}` | `finance.fees.write` | `removeClaimLine` | `concessions.go` |
| POST | `/concessions/claims/{id}/receipts` | `finance.fees.write` | `recordClaimReceipt` | `concessions.go` |
| POST | `/concessions/claims/{id}/sanction` | `finance.refunds.write` | `recordClaimSanction` | `concessions.go` |
| POST | `/concessions/claims/{id}/submit` | `finance.refunds.write` | `submitClaim` | `concessions.go` |
| GET | `/concessions/loans/applications` | `finance.fees.read` | `listLoanApplications` | `concessions.go` |
| POST | `/concessions/loans/applications` | `finance.fees.write` | `saveLoanApplication` | `concessions.go` |
| GET | `/concessions/loans/applications/{id}` | `finance.fees.read` | `getLoanApplication` | `concessions.go` |
| POST | `/concessions/loans/applications/{id}/documents` | `finance.fees.write` | `saveLoanDocument` | `concessions.go` |
| POST | `/concessions/loans/applications/{id}/status` | `finance.fees.write` | `setLoanStatus` | `concessions.go` |
| GET | `/concessions/loans/lenders` | `finance.fees.read` | `listLoanLenders` | `concessions.go` |
| POST | `/concessions/loans/lenders` | `finance.fees.write` | `saveLoanLender` | `concessions.go` |
| GET | `/concessions/rates` | `finance.fees.read` | `listReimbursementRates` | `concessions.go` |
| POST | `/concessions/rates` | `finance.fees.write` | `saveReimbursementRate` | `concessions.go` |
| GET | `/concessions/schemes` | `finance.fees.read` | `listAidSchemes` | `concessions.go` |
| POST | `/concessions/schemes` | `finance.fees.write` | `saveAidScheme` | `concessions.go` |
| GET | `/concessions/scholarships` | `finance.fees.read` | `listScholarshipAwards` | `concessions.go` |
| POST | `/concessions/scholarships` | `finance.fees.write` | `saveScholarshipAward` | `concessions.go` |
| GET | `/concessions/scholarships/imports` | `finance.fees.read` | `listScholarshipImports` | `concessions.go` |
| POST | `/concessions/scholarships/imports` | `finance.fees.write` | `importScholarshipDisbursements` | `concessions.go` |
| GET | `/concessions/scholarships/imports/{id}` | `finance.fees.read` | `getScholarshipImport` | `concessions.go` |
| POST | `/concessions/scholarships/lines/{id}/match` | `finance.fees.write` | `matchDisbursementLine` | `concessions.go` |
| POST | `/concessions/scholarships/{id}/fee-credit` | `finance.fees.write` | `creditScholarshipToFees` | `concessions.go` |
| POST | `/concessions/scholarships/{id}/verify` | `finance.fees.write` | `verifyScholarshipAward` | `concessions.go` |

## /connectors  (18)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/connectors/crm` | `platform.tenants.write` | `getCRMConnector` | `connectors.go` |
| PUT | `/connectors/crm` | `platform.tenants.write` | `saveCRMConnector` | `connectors.go` |
| GET | `/connectors/crm/conflicts` | `platform.tenants.write` | `listCRMConflicts` | `connectors.go` |
| POST | `/connectors/crm/conflicts/{id}/resolve` | `platform.tenants.write` | `resolveCRMConflict` | `connectors.go` |
| GET | `/connectors/crm/credentials` | `platform.tenants.write` | `getCRMCredentials` | `connectors.go` |
| PUT | `/connectors/crm/credentials` | `platform.tenants.write` | `saveCRMCredentials` | `connectors.go` |
| POST | `/connectors/crm/export` | `platform.tenants.write` | `exportCRMLeads` | `connectors.go` |
| POST | `/connectors/crm/import` | `platform.tenants.write` | `importCRMLeads` | `connectors.go` |
| PUT | `/connectors/crm/mappings` | `platform.tenants.write` | `saveCRMMappings` | `connectors.go` |
| GET | `/connectors/crm/queue` | `platform.tenants.write` | `listCRMQueue` | `connectors.go` |
| GET | `/connectors/crm/runs` | `platform.tenants.write` | `listCRMRuns` | `connectors.go` |
| GET | `/connectors/crm/runs/{id}/file` | `platform.tenants.write` | `downloadCRMExport` | `connectors.go` |
| GET | `/connectors/crm/runs/{id}/items` | `platform.tenants.write` | `listCRMRunItems` | `connectors.go` |
| GET | `/connectors/meetings` | `platform.tenants.write` | `getMeetingConnector` | `connectors.go` |
| PUT | `/connectors/meetings/providers` | `platform.tenants.write` | `saveMeetingProvider` | `connectors.go` |
| DELETE | `/connectors/meetings/providers/{id}` | `platform.tenants.write` | `deleteMeetingProvider` | `connectors.go` |
| GET | `/connectors/meetings/requests` | `platform.tenants.write` | `listMeetingRequests` | `connectors.go` |
| POST | `/connectors/meetings/sessions/{id}/meeting` | `platform.tenants.write` | `requestMeeting` | `connectors.go` |

## /date-ranges  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/date-ranges` | - | `listRangePresets` | `api.go` |

## /department  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/department/dashboard` | `hr.employees.read` | `getDeptDashboard` | `api.go` |
| GET | `/department/faculty` | `hr.employees.read` | `listDeptFaculty` | `api.go` |

## /department-timetable  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/department-timetable` | - | `getDepartmentTimetable` | `timetable_ops.go` |

## /diary  (5)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/diary` | - | `getStudentDiary` | `student_life.go` |
| GET | `/diary/notes` | - | `listDiaryNotes` | `student_life.go` |
| POST | `/diary/notes` | - | `createDiaryNote` | `student_life.go` |
| DELETE | `/diary/notes/{id}` | - | `deleteDiaryNote` | `student_life.go` |
| POST | `/diary/notes/{id}` | - | `updateDiaryNote` | `student_life.go` |

## /digital-library  (10)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/digital-library/audiences` | `operations.library.write` | `listDigitalAudiences` | `digital_library.go` |
| GET | `/digital-library/catalogue` | `operations.library.read` | `listDigitalCatalogue` | `digital_library.go` |
| POST | `/digital-library/holdings` | `operations.library.write` | `saveDigitalHolding` | `digital_library.go` |
| DELETE | `/digital-library/holdings/{id}` | `operations.library.write` | `deleteDigitalHolding` | `digital_library.go` |
| GET | `/digital-library/holdings/{id}/access` | `operations.library.read` | `openDigitalHolding` | `digital_library.go` |
| POST | `/digital-library/holdings/{id}/borrow` | `operations.library.read` | `borrowDigitalHolding` | `digital_library.go` |
| PUT | `/digital-library/holdings/{id}/visibility` | `operations.library.write` | `setDigitalVisibility` | `digital_library.go` |
| GET | `/digital-library/providers` | `operations.library.read` | `listDigitalProviders` | `digital_library.go` |
| POST | `/digital-library/providers` | `operations.library.write` | `saveDigitalProvider` | `digital_library.go` |
| DELETE | `/digital-library/providers/{id}` | `operations.library.write` | `deleteDigitalProvider` | `digital_library.go` |

## /documents  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/documents` | - | `listPortalDocuments` | `portal_requests.go` |

## /enquiries  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/enquiries/pipeline` | - | `getSalesPipeline` | `seller_crm.go` |
| PUT | `/enquiries/{id}` | - | `updateSalesEnquiry` | `seller_crm.go` |
| GET | `/enquiries/{id}/notes` | - | `listSalesEnquiryNotes` | `seller_crm.go` |

## /exams  (27)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/exams/gradebook` | `academics.exams.read` | `getGradebook` | `api.go` |
| GET | `/exams/hall-plan` | `academics.exams.read` | `getHallPlan` | `api.go` |
| GET | `/exams/halls` | `academics.exams.read` | `listExamHalls` | `api.go` |
| POST | `/exams/halls` | `academics.exams.read`, `academics.exams.write` | `createExamHall` | `api.go` |
| GET | `/exams/list` | `academics.exams.read` | `listExams` | `api.go` |
| POST | `/exams/marks` | `academics.exams.read`, `academics.marks.write` | `enterMarks` | `api.go` |
| GET | `/exams/moderation` | `academics.exams.approve`, `academics.exams.read` | `listMarkModeration` | `api.go` |
| POST | `/exams/moderation` | `academics.exams.approve`, `academics.exams.read` | `moderateMarks` | `api.go` |
| GET | `/exams/my-signature` | `academics.exams.read` | `getMySignature` | `api.go` |
| PUT | `/exams/my-signature` | `academics.exams.read` | `setMySignature` | `api.go` |
| GET | `/exams/question-papers` | `academics.exams.read` | `listQuestionPapers` | `api.go` |
| POST | `/exams/question-papers` | `academics.exams.read` | `submitQuestionPaper` | `api.go` |
| GET | `/exams/question-papers/slots` | `academics.exams.read` | `listPaperSlots` | `api.go` |
| GET | `/exams/report-cards` | `academics.exams.read` | `listReportCards` | `api.go` |
| POST | `/exams/report-cards/font` | `academics.exams.read`, `academics.reportcards.generate` | `setReportCardFont` | `api.go` |
| POST | `/exams/report-cards/generate` | `academics.exams.read`, `academics.reportcards.generate` | `generateReportCards` | `api.go` |
| GET | `/exams/report-cards/pending` | `academics.exams.read`, `academics.reportcards.publish` | `listPendingReportCards` | `api.go` |
| POST | `/exams/report-cards/publish` | `academics.exams.read`, `academics.reportcards.publish` | `publishReportCards` | `api.go` |
| GET | `/exams/report-cards/readiness` | `academics.exams.read` | `getReportCardReadiness` | `api.go` |
| GET | `/exams/report-cards/render` | `academics.exams.read` | `renderReportCard` | `api.go` |
| POST | `/exams/report-cards/return` | `academics.exams.read`, `academics.reportcards.publish` | `returnReportCards` | `api.go` |
| POST | `/exams/report-cards/submit` | `academics.exams.read`, `academics.reportcards.generate` | `submitReportCards` | `api.go` |
| GET | `/exams/report-cards/template` | `academics.exams.read` | `getReportCardTemplate` | `api.go` |
| POST | `/exams/report-cards/template` | `academics.exams.read`, `academics.reportcards.generate` | `saveReportCardTemplate` | `api.go` |
| POST | `/exams/report-cards/template/reset` | `academics.exams.read`, `academics.reportcards.generate` | `resetReportCardTemplate` | `api.go` |
| POST | `/exams/seats/allocate` | `academics.exams.read`, `academics.exams.write` | `allocateSeats` | `api.go` |
| GET | `/exams/subjects` | `academics.exams.read` | `listExamSubjects` | `api.go` |

## /exits  (7)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/exits` | - | `listExits` | `hr_lifecycle.go` |
| POST | `/exits` | `hr.employees.write` | `saveExit` | `hr_lifecycle.go` |
| GET | `/exits/{id}/clearances` | - | `listExitClearances` | `hr_lifecycle.go` |
| POST | `/exits/{id}/clearances` | `hr.employees.write` | `signExitClearance` | `hr_lifecycle.go` |
| POST | `/exits/{id}/interview` | `hr.employees.write` | `recordExitInterview` | `hr_lifecycle.go` |
| POST | `/exits/{id}/relieve` | `hr.employees.write` | `relieveStaff` | `hr_lifecycle.go` |
| POST | `/exits/{id}/settle` | `hr.employees.write` | `settleExit` | `hr_lifecycle.go` |

## /export  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/export` | - | `listExports` | `api.go` |
| GET | `/export/{name}` | - | `exportCSV` | `api.go` |

## /fee-engine  (16)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/fee-engine/fine-rules` | - | `listFineRules` | `fee_engine.go` |
| POST | `/fee-engine/fine-rules` | `finance.fees.write` | `saveFineRule` | `fee_engine.go` |
| DELETE | `/fee-engine/fine-rules/{id}` | `finance.fees.write` | `deleteFineRule` | `fee_engine.go` |
| POST | `/fee-engine/fines/apply` | `finance.invoices.write` | `applyFines` | `fee_engine.go` |
| GET | `/fee-engine/fines/charges` | - | `listFineCharges` | `fee_engine.go` |
| POST | `/fee-engine/fines/charges/{id}/waive` | `finance.invoices.write` | `waiveFineCharge` | `fee_engine.go` |
| GET | `/fee-engine/fines/preview` | - | `previewFines` | `fee_engine.go` |
| PUT | `/fee-engine/gst-heads/{id}` | `finance.fees.write` | `saveHeadGSTTreatment` | `fee_engine.go` |
| GET | `/fee-engine/receipt-series` | - | `getReceiptSeries` | `fee_engine.go` |
| PUT | `/fee-engine/receipt-series/{kind}` | `finance.fees.write` | `saveReceiptSeries` | `fee_engine.go` |
| GET | `/fee-engine/structures` | - | `listVersionedStructures` | `fee_engine.go` |
| GET | `/fee-engine/structures/{id}/versions` | - | `listStructureVersions` | `fee_engine.go` |
| POST | `/fee-engine/versions` | `finance.fees.write` | `saveStructureVersion` | `fee_engine.go` |
| DELETE | `/fee-engine/versions/{id}` | `finance.fees.write` | `discardStructureVersion` | `fee_engine.go` |
| POST | `/fee-engine/versions/{id}/activate` | `finance.fees.write` | `activateStructureVersion` | `fee_engine.go` |
| PUT | `/fee-engine/versions/{id}/items` | `finance.fees.write` | `setStructureVersionItems` | `fee_engine.go` |

## /fees  (15)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/fees/cheque-bounce-fine` | - | `getChequeBounceFine` | `api.go` |
| PUT | `/fees/cheque-bounce-fine` | `finance.fees.write` | `setChequeBounceFine` | `api.go` |
| GET | `/fees/concessions` | `finance.fees.read` | `listConcessions` | `api.go` |
| GET | `/fees/defaulters` | `finance.invoices.read` | `listDefaulters` | `api.go` |
| POST | `/fees/invoices/{id}/penalty` | `finance.payments.write` | `addInvoicePenalty` | `api.go` |
| POST | `/fees/payments` | `finance.payments.write` | `collectFee` | `api.go` |
| POST | `/fees/payments/{id}/bounce` | `finance.payments.write` | `bounceCheque` | `api.go` |
| POST | `/fees/payments/{id}/clear` | `finance.payments.write` | `clearCheque` | `api.go` |
| GET | `/fees/pdc` | `finance.payments.read` | `listPDC` | `api.go` |
| GET | `/fees/receipts/{id}` | `finance.payments.read` | `getReceipt` | `api.go` |
| GET | `/fees/refunds` | `finance.fees.read` | `listRefunds` | `api.go` |
| GET | `/fees/reminders/schedule` | - | `getFeeReminderSchedule` | `api.go` |
| PUT | `/fees/reminders/schedule` | `finance.fees.write` | `saveFeeReminderSchedule` | `api.go` |
| POST | `/fees/reminders/send` | `finance.fees.write` | `sendFeeReminders` | `api.go` |
| GET | `/fees/students/{id}/ledger` | - | `getStudentLedger` | `api.go` |

## /files  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/files` | - | `uploadFile` | `api.go` |
| POST | `/files/presign` | - | `presignUpload` | `api.go` |
| GET | `/files/{id}` | - | `downloadFile` | `api.go` |

## /finance  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/finance/dashboard` | `finance.invoices.read` | `getFinanceDashboard` | `api.go` |
| GET | `/finance/invoices` | `finance.invoices.read` | `listInvoices` | `api.go` |
| GET | `/finance/payments` | `finance.invoices.read` | `listPayments` | `api.go` |

## /form-fields  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| DELETE | `/form-fields/{id}` | `admissions.write` | `deleteAdmissionFormField` | `admissions_growth.go` |

## /form-sections  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| DELETE | `/form-sections/{id}` | `admissions.write` | `deleteAdmissionFormSection` | `admissions_growth.go` |

## /form-versions  (4)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/form-versions/{id}` | - | `getAdmissionFormVersion` | `admissions_growth.go` |
| POST | `/form-versions/{id}/fields` | `admissions.write` | `saveAdmissionFormField` | `admissions_growth.go` |
| POST | `/form-versions/{id}/publish` | `admissions.write` | `publishAdmissionFormVersion` | `admissions_growth.go` |
| POST | `/form-versions/{id}/sections` | `admissions.write` | `saveAdmissionFormSection` | `admissions_growth.go` |

## /forms  (5)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/forms` | - | `listAdmissionForms` | `admissions_growth.go` |
| POST | `/forms` | `admissions.write` | `createAdmissionForm` | `admissions_growth.go` |
| POST | `/forms/{id}` | `admissions.write` | `updateAdmissionForm` | `admissions_growth.go` |
| POST | `/forms/{id}/draft` | `admissions.write` | `draftAdmissionForm` | `admissions_growth.go` |
| GET | `/forms/{id}/versions` | - | `listAdmissionFormVersions` | `admissions_growth.go` |

## /grievances  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/grievances` | - | `listGrievances` | `hr_lifecycle.go` |
| POST | `/grievances` | `hr.employees.write` | `raiseGrievance` | `hr_lifecycle.go` |
| POST | `/grievances/{id}/decide` | `hr.employees.write` | `decideGrievance` | `hr_lifecycle.go` |

## /homework  (12)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/homework` | - | `listHomework` | `api.go` |
| POST | `/homework` | `academics.homework.write` | `publishHomework` | `api.go` |
| POST | `/homework/forum/posts/{id}/remove` | - | `removeForumPost` | `student_life.go` |
| GET | `/homework/forum/supervision` | - | `superviseForumThreads` | `student_life.go` |
| GET | `/homework/forum/threads` | - | `listForumThreads` | `student_life.go` |
| POST | `/homework/forum/threads` | - | `openForumThread` | `student_life.go` |
| GET | `/homework/forum/threads/{id}` | - | `getForumThread` | `student_life.go` |
| POST | `/homework/forum/threads/{id}/posts` | - | `replyToForumThread` | `student_life.go` |
| POST | `/homework/forum/threads/{id}/remove` | - | `removeForumThread` | `student_life.go` |
| POST | `/homework/forum/threads/{id}/resolve` | - | `resolveForumThread` | `student_life.go` |
| GET | `/homework/{id}/submissions` | - | `listHomeworkSubmissions` | `api.go` |
| POST | `/homework/{id}/submit` | - | `submitHomework` | `api.go` |

## /hostel  (11)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/hostel/laundry` | `operations.hostel.read` | `listLaundry` | `infirmary.go` |
| POST | `/hostel/laundry` | `operations.hostel.write` | `sendLaundry` | `infirmary.go` |
| POST | `/hostel/laundry/{id}/return` | `operations.hostel.write` | `returnLaundry` | `infirmary.go` |
| GET | `/hostel/night-study` | `operations.hostel.read` | `listNightStudy` | `infirmary.go` |
| POST | `/hostel/night-study` | `operations.hostel.write` | `markNightStudy` | `infirmary.go` |
| GET | `/hostel/room-checks` | `operations.hostel.read` | `listRoomChecks` | `infirmary.go` |
| POST | `/hostel/room-checks` | `operations.hostel.write` | `saveRoomCheck` | `infirmary.go` |
| GET | `/hostel/room-checks/{id}/items` | `operations.hostel.read` | `listRoomCheckItems` | `infirmary.go` |
| GET | `/hostel/visits` | `operations.hostel.read` | `listHostelVisits` | `infirmary.go` |
| POST | `/hostel/visits` | `operations.hostel.write` | `signHostelVisitorIn` | `infirmary.go` |
| POST | `/hostel/visits/{id}/out` | `operations.hostel.write` | `signHostelVisitorOut` | `infirmary.go` |

## /hpc  (4)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/hpc/card` | `self.profile.read` | `getHolisticCard` | `api.go` |
| GET | `/hpc/competencies` | `self.profile.read` | `listCompetencies` | `api.go` |
| GET | `/hpc/hall-ticket` | `self.profile.read` | `getHallTicket` | `api.go` |
| POST | `/hpc/observations` | `self.profile.read` | `recordObservation` | `api.go` |

## /hr  (10)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/hr/dashboard` | `hr.employees.read` | `getHRDashboard` | `api.go` |
| GET | `/hr/documents` | `hr.employees.read` | `listEmployeeDocuments` | `api.go` |
| GET | `/hr/employees` | `hr.employees.read` | `listEmployees` | `api.go` |
| GET | `/hr/employees/{id}/detail` | `hr.employees.read` | `getStaffDetail` | `api.go` |
| GET | `/hr/id-card-template` | `hr.employees.read` | `getIDCardTemplate` | `api.go` |
| GET | `/hr/leave` | - | `listLeaveRequests` | `api.go` |
| GET | `/hr/leave-types` | - | `listLeaveTypes` | `api.go` |
| POST | `/hr/letters` | `hr.employees.read`, `hr.employees.write` | `issueStaffLetter` | `api.go` |
| POST | `/hr/letters/printed` | `hr.employees.read` | `logLetterPrinted` | `api.go` |
| GET | `/hr/letters/prints` | `hr.employees.read` | `listLetterPrints` | `api.go` |

## /hr-growth  (46)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/hr-growth/appraisal/cycles` | `hr.employees.read`, `self.profile.read` | `listAppraisalCycles` | `hr_growth.go` |
| POST | `/hr-growth/appraisal/cycles` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `saveAppraisalCycle` | `hr_growth.go` |
| GET | `/hr-growth/appraisal/kpis` | `hr.employees.read`, `self.profile.read` | `listAppraisalKPIs` | `hr_growth.go` |
| PUT | `/hr-growth/appraisal/kpis` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `saveAppraisalKPIs` | `hr_growth.go` |
| GET | `/hr-growth/appraisal/records` | `hr.employees.read`, `self.profile.read` | `listAppraisals` | `hr_growth.go` |
| POST | `/hr-growth/appraisal/records` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `raiseAppraisals` | `hr_growth.go` |
| GET | `/hr-growth/appraisal/records/{id}` | `hr.employees.read`, `self.profile.read` | `getAppraisal` | `hr_growth.go` |
| POST | `/hr-growth/appraisal/records/{id}/discussion` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `recordAppraisalDiscussion` | `hr_growth.go` |
| POST | `/hr-growth/appraisal/records/{id}/moderate` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `moderateAppraisal` | `hr_growth.go` |
| POST | `/hr-growth/appraisal/records/{id}/publish` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `publishAppraisal` | `hr_growth.go` |
| POST | `/hr-growth/appraisal/records/{id}/review` | `hr.employees.read`, `self.profile.read` | `reviewAppraisal` | `hr_growth.go` |
| GET | `/hr-growth/candidates` | `hr.employees.read`, `self.profile.read` | `listCandidates` | `hr_growth.go` |
| POST | `/hr-growth/candidates` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `saveCandidate` | `hr_growth.go` |
| POST | `/hr-growth/candidates/{id}/hire` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `hireCandidate` | `hr_growth.go` |
| POST | `/hr-growth/candidates/{id}/stage` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `moveCandidateStage` | `hr_growth.go` |
| GET | `/hr-growth/designations` | `hr.employees.read`, `self.profile.read` | `listGrowthDesignations` | `hr_growth.go` |
| GET | `/hr-growth/interviews` | `hr.employees.read`, `self.profile.read` | `listInterviews` | `hr_growth.go` |
| POST | `/hr-growth/interviews` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `scheduleInterview` | `hr_growth.go` |
| POST | `/hr-growth/interviews/{id}/result` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `recordInterviewResult` | `hr_growth.go` |
| GET | `/hr-growth/me/appraisals` | `self.profile.read` | `listMyAppraisals` | `hr_growth.go` |
| GET | `/hr-growth/me/appraisals/{id}` | `self.profile.read` | `getMyAppraisal` | `hr_growth.go` |
| POST | `/hr-growth/me/appraisals/{id}/acknowledge` | `self.profile.read` | `acknowledgeAppraisal` | `hr_growth.go` |
| POST | `/hr-growth/me/appraisals/{id}/self-assessment` | `self.profile.read` | `submitSelfAssessment` | `hr_growth.go` |
| GET | `/hr-growth/me/duties` | `self.profile.read` | `listMyDuties` | `hr_growth.go` |
| GET | `/hr-growth/me/training` | `self.profile.read` | `getMyTrainingRecord` | `hr_growth.go` |
| GET | `/hr-growth/offers` | `hr.employees.read`, `self.profile.read` | `listOffers` | `hr_growth.go` |
| POST | `/hr-growth/offers` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `makeOffer` | `hr_growth.go` |
| POST | `/hr-growth/offers/{id}/respond` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `recordOfferResponse` | `hr_growth.go` |
| GET | `/hr-growth/recruitment/funnel` | `hr.employees.read`, `self.profile.read` | `getRecruitmentFunnel` | `hr_growth.go` |
| GET | `/hr-growth/roster` | `hr.employees.read`, `self.profile.read` | `listDutyRoster` | `hr_growth.go` |
| POST | `/hr-growth/roster` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `assignDuty` | `hr_growth.go` |
| GET | `/hr-growth/roster/conflicts` | `hr.employees.read`, `self.profile.read` | `listRosterConflicts` | `hr_growth.go` |
| GET | `/hr-growth/roster/fairness` | `hr.employees.read`, `self.profile.read` | `getRosterFairness` | `hr_growth.go` |
| GET | `/hr-growth/roster/shifts` | `hr.employees.read`, `self.profile.read` | `listDutyShifts` | `hr_growth.go` |
| PUT | `/hr-growth/roster/shifts` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `saveDutyShift` | `hr_growth.go` |
| POST | `/hr-growth/roster/{id}/cancel` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `cancelDuty` | `hr_growth.go` |
| GET | `/hr-growth/training/compliance` | `hr.employees.read`, `self.profile.read` | `getTrainingCompliance` | `hr_growth.go` |
| GET | `/hr-growth/training/programmes` | `hr.employees.read`, `self.profile.read` | `listTrainingProgrammes` | `hr_growth.go` |
| POST | `/hr-growth/training/programmes` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `saveTrainingProgramme` | `hr_growth.go` |
| GET | `/hr-growth/training/records` | `hr.employees.read`, `self.profile.read` | `listTrainingRecords` | `hr_growth.go` |
| POST | `/hr-growth/training/records` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `saveTrainingRecord` | `hr_growth.go` |
| GET | `/hr-growth/training/requirements` | `hr.employees.read`, `self.profile.read` | `listTrainingRequirements` | `hr_growth.go` |
| PUT | `/hr-growth/training/requirements` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `saveTrainingRequirement` | `hr_growth.go` |
| GET | `/hr-growth/vacancies` | `hr.employees.read`, `self.profile.read` | `listVacancies` | `hr_growth.go` |
| POST | `/hr-growth/vacancies` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `saveVacancy` | `hr_growth.go` |
| POST | `/hr-growth/vacancies/{id}/decide` | `hr.employees.read`, `hr.employees.write`, `self.profile.read` | `decideVacancy` | `hr_growth.go` |

## /infirmary  (10)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/infirmary/camps` | `welfare.health.read` | `listHealthCamps` | `infirmary.go` |
| POST | `/infirmary/camps` | `welfare.health.write` | `saveHealthCamp` | `infirmary.go` |
| GET | `/infirmary/camps/{id}/seen` | `welfare.health.read` | `listCampAttendance` | `infirmary.go` |
| POST | `/infirmary/camps/{id}/seen` | `welfare.health.write` | `recordCampAttendance` | `infirmary.go` |
| GET | `/infirmary/checkups` | `welfare.health.read` | `listHealthCheckups` | `infirmary.go` |
| POST | `/infirmary/checkups` | `welfare.health.write` | `saveHealthCheckup` | `infirmary.go` |
| GET | `/infirmary/medications` | `welfare.health.read` | `listMedicationRegister` | `infirmary.go` |
| POST | `/infirmary/medications` | `welfare.health.write` | `recordMedication` | `infirmary.go` |
| GET | `/infirmary/visits` | `welfare.health.read` | `listInfirmaryVisits` | `infirmary.go` |
| POST | `/infirmary/visits` | `welfare.health.write` | `recordInfirmaryVisit` | `infirmary.go` |

## /jobs  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/jobs` | `admin.jobs.enqueue` | `enqueueJob` | `api.go` |
| GET | `/jobs/queues` | `admin.jobs.read` | `queueStats` | `api.go` |
| GET | `/jobs/{id}` | `admin.jobs.read` | `jobStatus` | `api.go` |

## /leads  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/leads/{id}/lost` | `admissions.write` | `markLeadLost` | `admissions_growth.go` |
| POST | `/leads/{id}/opt-out` | `admissions.write` | `optLeadOut` | `admissions_growth.go` |
| POST | `/leads/{id}/reopen` | `admissions.write` | `reopenLead` | `admissions_growth.go` |

## /learning  (15)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/learning/courses` | - | `listMyCourses` | `student_learning.go` |
| GET | `/learning/portfolio` | - | `getPortfolio` | `student_learning.go` |
| POST | `/learning/portfolio` | - | `addPortfolioItem` | `student_learning.go` |
| DELETE | `/learning/portfolio/{id}` | - | `deletePortfolioItem` | `student_learning.go` |
| POST | `/learning/portfolio/{id}` | - | `updatePortfolioItem` | `student_learning.go` |
| GET | `/learning/resources` | - | `listMyResources` | `student_learning.go` |
| GET | `/learning/study-groups` | - | `listStudyGroups` | `student_learning.go` |
| POST | `/learning/study-groups` | - | `createStudyGroup` | `student_learning.go` |
| POST | `/learning/study-groups/{id}/join` | - | `joinStudyGroup` | `student_learning.go` |
| POST | `/learning/study-groups/{id}/leave` | - | `leaveStudyGroup` | `student_learning.go` |
| GET | `/learning/study-groups/{id}/members` | - | `listStudyGroupMembers` | `student_learning.go` |
| GET | `/learning/universities` | - | `listUniversityShortlist` | `student_learning.go` |
| POST | `/learning/universities` | - | `addUniversityEntry` | `student_learning.go` |
| DELETE | `/learning/universities/{id}` | - | `deleteUniversityEntry` | `student_learning.go` |
| POST | `/learning/universities/{id}` | - | `updateUniversityEntry` | `student_learning.go` |

## /leave  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/leave` | - | `listPortalLeave` | `portal_requests.go` |
| POST | `/leave/{id}/cancel` | - | `cancelPortalLeave` | `portal_requests.go` |

## /leave-policy  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/leave-policy` | - | `getLeavePolicy` | `hr_lifecycle.go` |
| POST | `/leave-policy` | `hr.employees.write` | `saveLeavePolicy` | `hr_lifecycle.go` |

## /leave-types  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/leave-types` | `hr.employees.write` | `saveLeaveType` | `hr_lifecycle.go` |

## /ledgers  (35)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/ledgers/account-ledger` | - | `getAccountLedger` | `ledgers.go` |
| GET | `/ledgers/accounts` | - | `listLedgerAccounts` | `ledgers.go` |
| POST | `/ledgers/accounts` | `finance.fees.write` | `saveLedgerAccount` | `ledgers.go` |
| GET | `/ledgers/assets` | - | `listFixedAssets` | `ledgers.go` |
| POST | `/ledgers/assets` | `finance.payments.write` | `saveFixedAsset` | `ledgers.go` |
| POST | `/ledgers/assets/depreciate` | `finance.payments.write` | `runDepreciation` | `ledgers.go` |
| GET | `/ledgers/audit-report` | - | `getAuditReport` | `ledgers.go` |
| GET | `/ledgers/bills` | - | `listVendorBills` | `ledgers.go` |
| POST | `/ledgers/bills` | `finance.payments.write` | `saveVendorBill` | `ledgers.go` |
| POST | `/ledgers/bills/{id}/approve` | `finance.payments.write` | `approveVendorBill` | `ledgers.go` |
| POST | `/ledgers/bills/{id}/pay` | `finance.payments.write` | `payVendorBill` | `ledgers.go` |
| GET | `/ledgers/budgets` | - | `getBudgetVariance` | `ledgers.go` |
| POST | `/ledgers/budgets` | `finance.fees.write` | `saveBudget` | `ledgers.go` |
| POST | `/ledgers/budgets/lines` | `finance.fees.write` | `saveBudgetLine` | `ledgers.go` |
| GET | `/ledgers/cashbook` | - | `getCashbook` | `ledgers.go` |
| GET | `/ledgers/daybook` | - | `getDaybook` | `ledgers.go` |
| GET | `/ledgers/expenses` | - | `getExpenseAnalysis` | `ledgers.go` |
| POST | `/ledgers/expenses` | `finance.payments.write` | `recordDirectExpense` | `ledgers.go` |
| GET | `/ledgers/fee-posting` | - | `previewFeePosting` | `ledgers.go` |
| POST | `/ledgers/fee-posting` | `finance.payments.write` | `runFeePosting` | `ledgers.go` |
| GET | `/ledgers/petty-cash` | - | `listPettyCash` | `ledgers.go` |
| POST | `/ledgers/petty-cash` | `finance.payments.write` | `raisePettyCash` | `ledgers.go` |
| POST | `/ledgers/petty-cash/{id}/decide` | `finance.payments.write` | `decidePettyCash` | `ledgers.go` |
| GET | `/ledgers/settings` | - | `getLedgerSettings` | `ledgers.go` |
| POST | `/ledgers/settings` | `finance.fees.write` | `saveLedgerSettings` | `ledgers.go` |
| GET | `/ledgers/statements` | - | `getStatements` | `ledgers.go` |
| GET | `/ledgers/tax-report` | - | `getTaxReport` | `ledgers.go` |
| GET | `/ledgers/trial-balance` | - | `getTrialBalance` | `ledgers.go` |
| GET | `/ledgers/vendors` | - | `listVendors` | `ledgers.go` |
| POST | `/ledgers/vendors` | `finance.fees.write` | `saveVendor` | `ledgers.go` |
| GET | `/ledgers/vouchers` | - | `listVouchers` | `ledgers.go` |
| POST | `/ledgers/vouchers` | `finance.payments.write` | `postJournalVoucher` | `ledgers.go` |
| GET | `/ledgers/vouchers/{id}` | - | `getVoucher` | `ledgers.go` |
| GET | `/ledgers/years` | - | `listAccountingYears` | `ledgers.go` |
| POST | `/ledgers/years/close` | `finance.payments.write` | `closeAccountingYear` | `ledgers.go` |

## /library  (4)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/library/holds` | - | `listMyHolds` | `student_learning.go` |
| POST | `/library/holds` | - | `requestBookHold` | `student_learning.go` |
| POST | `/library/holds/{id}/cancel` | - | `cancelBookHold` | `student_learning.go` |
| GET | `/library/titles` | - | `listLibraryCatalogue` | `student_learning.go` |

## /lifecycle  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/lifecycle/certificates` | `students.read` | `listCertificates` | `api.go` |
| POST | `/lifecycle/certificates` | `students.read`, `students.write` | `issueCertificate` | `api.go` |
| POST | `/lifecycle/promote` | `students.read`, `students.write` | `promoteStudents` | `api.go` |

## /live  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/live` | - | `getLiveRevision` | `portal_school_life.go` |

## /live-classes  (7)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/live-classes` | - | `listMyLiveClasses` | `student_life.go` |
| GET | `/live-classes/engagement` | - | `getHandRaiseTelemetry` | `student_life.go` |
| POST | `/live-classes/hands/{id}/call-on` | - | `callOnRaisedHand` | `student_life.go` |
| GET | `/live-classes/my-engagement` | - | `getMyHandRaiseHistory` | `student_life.go` |
| POST | `/live-classes/{id}/hand` | - | `raiseHand` | `student_life.go` |
| POST | `/live-classes/{id}/hand/lower` | - | `lowerHand` | `student_life.go` |
| GET | `/live-classes/{id}/hands` | - | `listRaisedHands` | `student_life.go` |

## /lop  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/lop` | - | `getLOPRegister` | `hr_lifecycle.go` |

## /lost-leads  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/lost-leads` | - | `listLostLeads` | `admissions_growth.go` |
| GET | `/lost-leads/analysis` | - | `getLostLeadAnalysis` | `admissions_growth.go` |
| GET | `/lost-leads/reasons` | - | `listLostReasonOptions` | `admissions_growth.go` |

## /master-timetable  (5)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/master-timetable/drafts/{id}/entries` | `academics.timetable.write` | `placeMasterDraftPeriod` | `master_timetable.go` |
| DELETE | `/master-timetable/drafts/{id}/entries/{entryID}` | `academics.timetable.write` | `clearMasterDraftPeriod` | `master_timetable.go` |
| PUT | `/master-timetable/drafts/{id}/entries/{entryID}` | `academics.timetable.write` | `moveMasterDraftPeriod` | `master_timetable.go` |
| GET | `/master-timetable/drafts/{id}/publish-preview` | - | `previewMasterPublish` | `master_timetable.go` |
| GET | `/master-timetable/overview` | - | `getMasterTimetableOverview` | `master_timetable.go` |

## /materials  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/materials` | - | `listTeachingMaterials` | `teaching.go` |
| POST | `/materials` | - | `createTeachingMaterial` | `teaching.go` |
| PUT | `/materials/{id}` | - | `updateTeachingMaterial` | `teaching.go` |

## /mdm-register  (6)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/mdm-register/context` | - | `getMDMRegisterContext` | `mdm.go` |
| GET | `/mdm-register/days` | - | `listMDMRegisterDays` | `mdm.go` |
| POST | `/mdm-register/days` | `institution.write` | `saveMDMRegisterDay` | `mdm.go` |
| GET | `/mdm-register/days/{id}` | - | `getMDMRegisterDay` | `mdm.go` |
| POST | `/mdm-register/days/{id}/close` | `institution.write` | `closeMDMRegisterDay` | `mdm.go` |
| POST | `/mdm-register/days/{id}/reopen` | `institution.write` | `reopenMDMRegisterDay` | `mdm.go` |

## /me  (4)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/me/child-bus` | `self.profile.read` | `getChildBus` | `bus_tracking_views.go` |
| POST | `/me/child-bus/prefs` | `self.profile.read` | `saveWatchPrefs` | `bus_tracking_views.go` |
| GET | `/me/pay` | - | `getMyPay` | `api.go` |
| GET | `/me/student` | `self.attendance.read` | `getMyStudent` | `api.go` |

## /medical-fitness  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/medical-fitness` | - | `listMedicalFitness` | `hr_lifecycle.go` |
| POST | `/medical-fitness` | `hr.employees.write` | `recordMedicalFitness` | `hr_lifecycle.go` |

## /messages  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/messages` | - | `listPortalMessages` | `portal_requests.go` |
| POST | `/messages` | - | `sendPortalMessage` | `portal_requests.go` |
| GET | `/messages/teachers` | - | `listReachableTeachers` | `portal_requests.go` |

## /messaging  (23)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/messaging/dispatch` | `comms.messages.send` | `dispatchMessages` | `messaging.go` |
| GET | `/messaging/log` | - | `listMessageLog` | `messaging.go` |
| GET | `/messaging/plans` | `institution.read` | `listReminderPlans` | `message_rules.go` |
| POST | `/messaging/plans` | `institution.settings.write` | `saveReminderPlan` | `message_rules.go` |
| DELETE | `/messaging/plans/{id}` | `institution.settings.write` | `deleteReminderPlan` | `message_rules.go` |
| POST | `/messaging/plans/{id}/preview` | - | `previewReminderPlan` | `message_rules.go` |
| POST | `/messaging/plans/{id}/run` | `comms.messages.send` | `runReminderPlan` | `message_rules.go` |
| GET | `/messaging/providers` | `institution.read` | `listMessagingProviders` | `messaging.go` |
| DELETE | `/messaging/providers/{channel}` | `institution.integrations.write` | `forgetMessagingProvider` | `messaging.go` |
| PUT | `/messaging/providers/{channel}` | `institution.integrations.write` | `saveMessagingProvider` | `messaging.go` |
| POST | `/messaging/providers/{channel}/test` | `institution.integrations.write` | `testMessagingProvider` | `messaging.go` |
| GET | `/messaging/recipients` | `institution.read` | `getRecipientPolicy` | `whatsapp.go` |
| POST | `/messaging/recipients` | `institution.integrations.write` | `addAllowedRecipient` | `whatsapp.go` |
| PUT | `/messaging/recipients/mode` | `institution.integrations.write` | `setRecipientMode` | `whatsapp.go` |
| DELETE | `/messaging/recipients/{id}` | `institution.integrations.write` | `removeAllowedRecipient` | `whatsapp.go` |
| POST | `/messaging/send` | `comms.messages.send` | `sendOneMessage` | `messaging.go` |
| GET | `/messaging/templates` | `institution.read` | `listMessageTemplates` | `messaging.go` |
| PUT | `/messaging/templates` | `institution.settings.write` | `saveMessageTemplate` | `messaging.go` |
| GET | `/messaging/test-link` | `institution.integrations.write` | `getMessageTestLink` | `whatsapp.go` |
| GET | `/messaging/triggers` | `institution.read` | `listTriggerRules` | `messaging.go` |
| POST | `/messaging/triggers` | `institution.settings.write` | `saveTriggerRule` | `messaging.go` |
| POST | `/messaging/triggers/run` | `comms.messages.send` | `runTriggerSweep` | `messaging.go` |
| DELETE | `/messaging/triggers/{id}` | `institution.settings.write` | `deleteTriggerRule` | `messaging.go` |

## /notifications  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/notifications` | - | `listFamilyNotifications` | `portal_school_life.go` |
| POST | `/notifications/read-all` | - | `markAllNotificationsRead` | `portal_school_life.go` |
| POST | `/notifications/{id}/read` | - | `markNotificationRead` | `portal_school_life.go` |

## /office  (12)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/office/appointments` | `office.front_desk.read` | `listAppointments` | `api.go` |
| POST | `/office/appointments` | `office.front_desk.read`, `office.front_desk.write` | `saveAppointment` | `api.go` |
| GET | `/office/blocklist` | `office.front_desk.read` | `listBlocklist` | `api.go` |
| POST | `/office/blocklist` | `office.front_desk.read`, `office.front_desk.write` | `addToBlocklist` | `api.go` |
| GET | `/office/calls` | `office.front_desk.read` | `listCalls` | `api.go` |
| POST | `/office/calls` | `office.front_desk.read`, `office.front_desk.write` | `saveCall` | `api.go` |
| GET | `/office/courier` | `office.front_desk.read` | `listCourier` | `api.go` |
| POST | `/office/courier` | `office.front_desk.read`, `office.front_desk.write` | `saveCourier` | `api.go` |
| GET | `/office/staff` | `office.front_desk.read` | `listDeskStaff` | `api.go` |
| GET | `/office/visitors` | `office.front_desk.read` | `listVisitors` | `api.go` |
| POST | `/office/visitors` | `office.front_desk.read`, `office.front_desk.write` | `signVisitorIn` | `api.go` |
| POST | `/office/visitors/{id}/out` | `office.front_desk.read`, `office.front_desk.write` | `signVisitorOut` | `api.go` |

## /onboarding  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/onboarding` | - | `listOnboarding` | `hr_lifecycle.go` |
| POST | `/onboarding` | `hr.employees.write` | `saveOnboarding` | `hr_lifecycle.go` |

## /online-tests  (5)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/online-tests` | - | `listOnlineTests` | `teaching.go` |
| POST | `/online-tests` | - | `createOnlineTest` | `teaching.go` |
| GET | `/online-tests/{id}` | - | `getOnlineTest` | `teaching.go` |
| PUT | `/online-tests/{id}` | - | `updateOnlineTest` | `teaching.go` |
| PUT | `/online-tests/{id}/questions` | - | `setOnlineTestQuestions` | `teaching.go` |

## /operations  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/operations/dashboard` | - | `getOperationsDashboard` | `api.go` |

## /ops  (52)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/ops/health/students` | `welfare.health.read` | `listHealthRecords` | `api.go` |
| POST | `/ops/hostel/allocate` | `operations.hostel.write` | `allocateHostelBed` | `api.go` |
| GET | `/ops/hostel/complaints` | `operations.hostel.read` | `listHostelComplaints` | `api.go` |
| POST | `/ops/hostel/complaints` | - | `raiseHostelComplaint` | `api.go` |
| POST | `/ops/hostel/complaints/{id}/resolve` | `operations.hostel.write` | `resolveHostelComplaint` | `api.go` |
| GET | `/ops/hostel/mess` | - | `listMessMenu` | `api.go` |
| PUT | `/ops/hostel/mess` | `operations.hostel.write` | `setMessMenu` | `api.go` |
| GET | `/ops/hostel/occupancy` | `operations.hostel.read` | `listHostelOccupancy` | `api.go` |
| GET | `/ops/hostel/outpasses` | - | `listOutpasses` | `api.go` |
| POST | `/ops/hostel/outpasses` | - | `createOutpass` | `api.go` |
| POST | `/ops/hostel/outpasses/{id}/decide` | - | `decideOutpass` | `api.go` |
| GET | `/ops/hostel/rooms/{id}/boarders` | `operations.hostel.read` | `listRoomBoarders` | `api.go` |
| POST | `/ops/inventory/movements` | `operations.inventory.write` | `moveStock` | `api.go` |
| GET | `/ops/inventory/stock` | `operations.inventory.read` | `listStock` | `api.go` |
| GET | `/ops/library/audits` | `operations.library.read` | `listStockAudits` | `api.go` |
| POST | `/ops/library/audits` | `operations.library.write` | `saveStockAudit` | `api.go` |
| GET | `/ops/library/audits/{id}/missing` | `operations.library.read` | `listAuditMissing` | `api.go` |
| POST | `/ops/library/audits/{id}/scan` | `operations.library.write` | `recordAuditScan` | `api.go` |
| GET | `/ops/library/indents` | `operations.library.read` | `listTextbookIndents` | `api.go` |
| POST | `/ops/library/indents` | `operations.library.write` | `saveTextbookIndent` | `api.go` |
| POST | `/ops/library/issue` | `operations.library.write` | `issueBook` | `api.go` |
| GET | `/ops/library/loans` | `operations.library.read` | `listLibraryLoans` | `api.go` |
| POST | `/ops/library/loans/{id}/return` | `operations.library.write` | `returnBook` | `api.go` |
| GET | `/ops/library/reservations` | `operations.library.read` | `listReservations` | `api.go` |
| POST | `/ops/library/reservations` | `operations.library.write` | `placeReservation` | `api.go` |
| POST | `/ops/library/reservations/{id}/decide` | `operations.library.write` | `decideReservation` | `api.go` |
| GET | `/ops/library/titles` | `operations.library.read` | `listLibraryTitles` | `api.go` |
| GET | `/ops/library/titles/{id}/copies` | `operations.library.read` | `listTitleCopies` | `api.go` |
| GET | `/ops/transport/allocations` | `operations.transport.read` | `listTransportAllocations` | `api.go` |
| POST | `/ops/transport/allocations` | `operations.transport.write` | `allocateTransport` | `api.go` |
| GET | `/ops/transport/assignable-staff` | `operations.transport.read` | `listAssignableStaff` | `api.go` |
| GET | `/ops/transport/attendance` | `operations.transport.read` | `listBusAttendance` | `api.go` |
| POST | `/ops/transport/attendance` | `operations.transport.write` | `markBusAttendance` | `api.go` |
| GET | `/ops/transport/checks` | `operations.transport.read` | `listTripChecks` | `api.go` |
| POST | `/ops/transport/checks` | `operations.transport.write` | `recordTripCheck` | `api.go` |
| GET | `/ops/transport/incidents` | `operations.transport.read` | `listTransportIncidents` | `api.go` |
| POST | `/ops/transport/incidents` | `operations.transport.write` | `saveTransportIncident` | `api.go` |
| GET | `/ops/transport/logs` | `operations.transport.read` | `listVehicleLogs` | `api.go` |
| POST | `/ops/transport/logs` | `operations.transport.write` | `recordVehicleLog` | `api.go` |
| GET | `/ops/transport/policy` | `operations.transport.read` | `getTrackingPolicy` | `api.go` |
| PUT | `/ops/transport/policy` | `operations.transport.write` | `saveTrackingPolicy` | `api.go` |
| GET | `/ops/transport/routes` | `operations.transport.read` | `listRoutes` | `api.go` |
| POST | `/ops/transport/routes` | `operations.transport.write` | `saveRoute` | `api.go` |
| DELETE | `/ops/transport/routes/{id}` | `operations.transport.write` | `deleteRoute` | `api.go` |
| PUT | `/ops/transport/routes/{id}` | `operations.transport.write` | `saveRoute` | `api.go` |
| GET | `/ops/transport/routes/{id}/stops` | `operations.transport.read` | `listRouteStops` | `api.go` |
| GET | `/ops/transport/staff` | `operations.transport.read` | `listTransportStaff` | `api.go` |
| POST | `/ops/transport/staff` | `operations.transport.write` | `saveTransportStaff` | `api.go` |
| GET | `/ops/transport/vehicles` | `operations.transport.read` | `listVehicles` | `api.go` |
| POST | `/ops/transport/vehicles` | `operations.transport.write` | `createVehicle` | `api.go` |
| PUT | `/ops/transport/vehicles/{id}` | `operations.transport.write` | `updateVehicle` | `api.go` |
| PUT | `/ops/transport/vehicles/{id}/route` | `operations.transport.write` | `setVehicleRoute` | `api.go` |

## /parent-forum  (14)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/parent-forum/boards` | - | `listParentForumBoards` | `parent_forum.go` |
| GET | `/parent-forum/moderation/queue` | `comms.announcements.write` | `listParentForumQueue` | `parent_forum.go` |
| GET | `/parent-forum/moderation/reports` | `comms.announcements.write` | `listParentForumReports` | `parent_forum.go` |
| POST | `/parent-forum/posts/{id}/moderate` | `comms.announcements.write` | `moderateParentForumPost` | `parent_forum.go` |
| POST | `/parent-forum/posts/{id}/report` | - | `reportParentForumPost` | `parent_forum.go` |
| GET | `/parent-forum/settings` | `comms.announcements.write` | `getParentForumSettings` | `parent_forum.go` |
| PUT | `/parent-forum/settings` | `comms.announcements.write` | `saveParentForumSettings` | `parent_forum.go` |
| GET | `/parent-forum/threads` | - | `listParentForumThreads` | `parent_forum.go` |
| POST | `/parent-forum/threads` | - | `openParentForumThread` | `parent_forum.go` |
| GET | `/parent-forum/threads/{id}` | - | `getParentForumThread` | `parent_forum.go` |
| GET | `/parent-forum/threads/{id}/history` | `comms.announcements.write` | `listParentForumHistory` | `parent_forum.go` |
| POST | `/parent-forum/threads/{id}/moderate` | `comms.announcements.write` | `moderateParentForumThread` | `parent_forum.go` |
| POST | `/parent-forum/threads/{id}/posts` | - | `replyToParentForumThread` | `parent_forum.go` |
| POST | `/parent-forum/threads/{id}/report` | - | `reportParentForumThread` | `parent_forum.go` |

## /payroll  (21)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/payroll/bank-file` | `hr.payroll.read` | `getBankFile` | `api.go` |
| GET | `/payroll/components` | `hr.payroll.read` | `listSalaryComponents` | `api.go` |
| POST | `/payroll/components` | `hr.payroll.read`, `hr.payroll.write` | `saveSalaryComponent` | `api.go` |
| GET | `/payroll/contractor-bills` | `hr.payroll.read` | `listContractorBills` | `api.go` |
| POST | `/payroll/contractor-bills` | `hr.payroll.read`, `hr.payroll.write` | `saveContractorBill` | `api.go` |
| GET | `/payroll/ctc` | `hr.payroll.read` | `getCTCBreakup` | `api.go` |
| GET | `/payroll/declarations` | `hr.payroll.read` | `listDeclarations` | `api.go` |
| POST | `/payroll/declarations` | `hr.payroll.read`, `hr.payroll.write` | `saveDeclaration` | `api.go` |
| GET | `/payroll/ecr` | `hr.payroll.read` | `getECRFile` | `api.go` |
| GET | `/payroll/gratuity` | `hr.payroll.read` | `getGratuityLiability` | `api.go` |
| GET | `/payroll/loans` | `hr.payroll.read` | `listStaffLoans` | `api.go` |
| POST | `/payroll/loans` | `hr.payroll.read`, `hr.payroll.write` | `saveStaffLoan` | `api.go` |
| GET | `/payroll/payslips` | `hr.payroll.read` | `listPayslips` | `api.go` |
| POST | `/payroll/run` | `hr.payroll.read`, `hr.payroll.write` | `runPayroll` | `api.go` |
| GET | `/payroll/settings` | `hr.payroll.read` | `getPayrollSettings` | `api.go` |
| PUT | `/payroll/settings` | `hr.payroll.read`, `hr.payroll.write` | `savePayrollSettings` | `api.go` |
| POST | `/payroll/state` | `hr.payroll.read`, `hr.payroll.write` | `setPayrollState` | `api.go` |
| GET | `/payroll/statutory` | `hr.payroll.read` | `getStatutoryRegister` | `api.go` |
| GET | `/payroll/structures` | `hr.payroll.read` | `listSalaryStructures` | `api.go` |
| POST | `/payroll/structures` | `hr.payroll.read`, `hr.payroll.write` | `saveSalaryStructure` | `api.go` |
| GET | `/payroll/tax` | `hr.payroll.read` | `getTaxComputation` | `api.go` |

## /people  (9)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/people/group-fields` | `students.read` | `getGroupFields` | `person_groups.go` |
| GET | `/people/groups` | `students.read` | `listPersonGroups` | `person_groups.go` |
| POST | `/people/groups` | `students.write` | `savePersonGroup` | `person_groups.go` |
| DELETE | `/people/groups/{id}` | `students.write` | `deletePersonGroup` | `person_groups.go` |
| PUT | `/people/groups/{id}` | `students.write` | `savePersonGroup` | `person_groups.go` |
| GET | `/people/groups/{id}/members` | `students.read` | `listGroupMembers` | `person_groups.go` |
| POST | `/people/groups/{id}/members` | `students.write` | `addGroupMembers` | `person_groups.go` |
| DELETE | `/people/groups/{id}/members/{personID}` | `students.write` | `removeGroupMember` | `person_groups.go` |
| GET | `/people/search` | `students.read` | `searchPeople` | `api.go` |

## /pickup  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/pickup` | - | `listPickupAuthorisations` | `portal_requests.go` |
| POST | `/pickup` | - | `authorisePickup` | `portal_requests.go` |
| POST | `/pickup/{id}/revoke` | - | `revokePickup` | `portal_requests.go` |

## /platform  (47)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/platform/adoption` | `platform.tenants.write` | `getAdoptionMetrics` | `platform_config.go` |
| GET | `/platform/auth-policy` | `access.roles.read` | `getAuthPolicy` | `platform_config.go` |
| PUT | `/platform/auth-policy` | `access.roles.write` | `setAuthPolicy` | `platform_config.go` |
| GET | `/platform/backups` | `institution.read` | `getBackupPosture` | `platform_config.go` |
| PUT | `/platform/backups` | `institution.settings.write` | `setBackupPolicy` | `platform_config.go` |
| GET | `/platform/backups/fleet` | `platform.tenants.write` | `getBackupFleet` | `platform_config.go` |
| POST | `/platform/backups/runs` | `platform.tenants.write` | `recordBackupRun` | `platform_config.go` |
| GET | `/platform/board-affiliation` | `institution.read` | `getBoardAffiliation` | `platform_config.go` |
| PUT | `/platform/board-affiliation` | `institution.write` | `setBoardAffiliation` | `platform_config.go` |
| POST | `/platform/board-affiliation/documents` | `institution.write` | `saveBoardDisclosure` | `platform_config.go` |
| DELETE | `/platform/board-affiliation/documents/{id}` | `institution.write` | `deleteBoardDisclosure` | `platform_config.go` |
| GET | `/platform/board-config` | `institution.read` | `listBoardConfigurations` | `platform_config.go` |
| POST | `/platform/board-config` | `institution.settings.write` | `saveBoardConfiguration` | `platform_config.go` |
| DELETE | `/platform/board-config/{id}` | `institution.settings.write` | `deleteBoardConfiguration` | `platform_config.go` |
| GET | `/platform/branding` | `institution.read` | `listBrandingProfiles` | `platform_config.go` |
| PUT | `/platform/branding` | `institution.settings.write` | `saveBrandingProfile` | `platform_config.go` |
| POST | `/platform/branding/{id}/verify-domain` | `platform.tenants.write` | `verifyBrandingDomain` | `platform_config.go` |
| GET | `/platform/calendar-model` | `institution.read` | `getCalendarModel` | `platform_config.go` |
| PUT | `/platform/calendar-model` | `institution.settings.write` | `setCalendarModel` | `platform_config.go` |
| GET | `/platform/campus-classification` | `institution.read` | `listCampusClassification` | `platform_config.go` |
| GET | `/platform/entitlements` | `platform.plans.write` | `getEntitlementMatrix` | `platform_config.go` |
| PUT | `/platform/entitlements` | `platform.plans.write` | `setEntitlement` | `platform_config.go` |
| GET | `/platform/franchise` | `institution.read` | `getOwnFranchise` | `platform_config.go` |
| GET | `/platform/franchises` | `platform.tenants.write` | `listFranchises` | `platform_config.go` |
| POST | `/platform/franchises` | `platform.tenants.write` | `saveFranchise` | `platform_config.go` |
| POST | `/platform/franchises/members` | `platform.tenants.write` | `saveFranchiseMember` | `platform_config.go` |
| DELETE | `/platform/franchises/members/{id}` | `platform.tenants.write` | `removeFranchiseMember` | `platform_config.go` |
| GET | `/platform/health` | `platform.tenants.write` | `getInstanceHealth` | `platform_config.go` |
| GET | `/platform/impersonation` | - | `listImpersonationGrants` | `platform_config.go` |
| POST | `/platform/impersonation` | `platform.tenants.write` | `openImpersonation` | `platform_config.go` |
| GET | `/platform/impersonation/{id}/activity` | - | `getImpersonationActivity` | `platform_config.go` |
| POST | `/platform/impersonation/{id}/end` | - | `endImpersonation` | `platform_config.go` |
| GET | `/platform/locations` | - | `listLocationCodes` | `platform_config.go` |
| POST | `/platform/locations` | `platform.tenants.write` | `saveLocationCode` | `platform_config.go` |
| DELETE | `/platform/locations/{id}` | `platform.tenants.write` | `retireLocationCode` | `platform_config.go` |
| GET | `/platform/numbering` | `institution.read` | `getNumberingAndTemplates` | `platform_config.go` |
| POST | `/platform/numbering` | `institution.settings.write` | `saveNumberingScheme` | `platform_config.go` |
| DELETE | `/platform/numbering/{id}` | `institution.settings.write` | `deleteNumberingScheme` | `platform_config.go` |
| GET | `/platform/seller/tickets` | `platform.tenants.write` | `listVendorTickets` | `platform_config.go` |
| POST | `/platform/seller/tickets/{id}` | `platform.tenants.write` | `updateVendorTicket` | `platform_config.go` |
| GET | `/platform/sqaa` | - | `getSQAAFramework` | `platform_config.go` |
| POST | `/platform/sqaa/frameworks` | `platform.tenants.write` | `saveSQAAFramework` | `platform_config.go` |
| POST | `/platform/sqaa/standards` | `platform.tenants.write` | `saveSQAAStandard` | `platform_config.go` |
| DELETE | `/platform/sqaa/standards/{id}` | `platform.tenants.write` | `deleteSQAAStandard` | `platform_config.go` |
| GET | `/platform/support/tickets` | `institution.read` | `listOwnVendorTickets` | `platform_config.go` |
| POST | `/platform/support/tickets` | `institution.settings.write` | `raiseVendorTicket` | `platform_config.go` |
| POST | `/platform/templates` | `institution.settings.write` | `savePlatformCertificateTemplate` | `platform_config.go` |

## /platform-notices  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/platform-notices` | - | `listLiveBroadcasts` | `api.go` |

## /portal  (13)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/portal/attendance` | `self.profile.read` | `listPortalAttendance` | `api.go` |
| GET | `/portal/comms/achievements` | `self.profile.read` | `listPortalShowcase` | `comms.go` |
| GET | `/portal/comms/grievances/{id}` | `self.profile.read` | `getPortalFeedback` | `comms.go` |
| POST | `/portal/comms/grievances/{id}/satisfaction` | `self.profile.read` | `rateFeedbackResolution` | `comms.go` |
| GET | `/portal/fees` | `self.profile.read` | `getFamilyFees` | `api.go` |
| POST | `/portal/fees/pay` | `self.profile.read` | `portalSimulatedPay` | `api.go` |
| GET | `/portal/notes` | `self.profile.read` | `listDisciplineNotes` | `api.go` |
| GET | `/portal/remarks` | `self.profile.read` | `listChildRemarks` | `api.go` |
| GET | `/portal/results` | `self.profile.read` | `getFamilyResults` | `api.go` |
| GET | `/portal/results/card` | `self.profile.read` | `renderFamilyReportCard` | `api.go` |
| GET | `/portal/students` | `self.profile.read` | `listMyStudents` | `api.go` |
| GET | `/portal/students/everywhere` | `self.profile.read` | `listMyChildrenEverywhere` | `api.go` |
| GET | `/portal/summary` | `self.profile.read` | `getPortalSummary` | `api.go` |

## /preferences  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/preferences/display` | - | `getDisplayPreferences` | `student_life.go` |
| PUT | `/preferences/display` | - | `saveDisplayPreferences` | `student_life.go` |

## /principal  (4)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/principal/attendance-shortage` | `admin.reports.read` | `getAttendanceShortage` | `api.go` |
| GET | `/principal/attendance-trend` | `admin.reports.read` | `getAttendanceTrend` | `api.go` |
| GET | `/principal/dashboard` | `admin.reports.read` | `getPrincipalDashboard` | `api.go` |
| GET | `/principal/staff-workload` | `admin.reports.read` | `getStaffWorkload` | `api.go` |

## /profile  (5)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/profile` | `self.profile.read` | `getProfile` | `api.go` |
| PUT | `/profile` | `self.profile.write` | `updateProfile` | `api.go` |
| GET | `/profile/parent-id-card` | - | `getParentIDCard` | `portal_school_life.go` |
| POST | `/profile/password` | `self.profile.write` | `changePassword` | `api.go` |
| GET | `/profile/student-id-card` | - | `getStudentIDCard` | `portal_school_life.go` |

## /ptm-notes  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/ptm-notes` | - | `listPTMNotes` | `faculty_comms.go` |
| POST | `/ptm-notes` | - | `savePTMNote` | `faculty_comms.go` |

## /public  (8)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/public/admissions/forms/{slug}` | - | `getPublicAdmissionForm` | `admissions_growth.go` |
| POST | `/public/admissions/forms/{slug}` | - | `submitPublicAdmissionForm` | `admissions_growth.go` |
| POST | `/public/bus-tracker/claim` | - | `claimBusTrackerPairCode` | `bus_tracker.go` |
| POST | `/public/bus-tracker/driver-signin` | - | `signInBusDriver` | `bus_tracker.go` |
| POST | `/public/bus-tracker/enrol` | - | `enrolBusTracker` | `bus_tracker.go` |
| POST | `/public/message-test` | - | `sendPublicTestMessage` | `api.go` |
| POST | `/public/sms-gateway/claim` | - | `claimSMSGatewayPairCode` | `sms_gateway.go` |
| POST | `/public/sms-gateway/enrol` | - | `enrolSMSGateway` | `sms_gateway.go` |

## /qualifications  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/qualifications` | - | `listQualifications` | `hr_lifecycle.go` |
| POST | `/qualifications` | `hr.employees.write` | `saveQualification` | `hr_lifecycle.go` |

## /question-bank  (6)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/question-bank` | - | `listBankQuestions` | `teaching.go` |
| POST | `/question-bank` | - | `createBankQuestion` | `teaching.go` |
| GET | `/question-bank/summary` | - | `getBankSummary` | `teaching.go` |
| DELETE | `/question-bank/{id}` | - | `retireBankQuestion` | `teaching.go` |
| GET | `/question-bank/{id}` | - | `getBankQuestion` | `teaching.go` |
| PUT | `/question-bank/{id}` | - | `updateBankQuestion` | `teaching.go` |

## /receipts  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/receipts` | - | `listPortalReceipts` | `portal_requests.go` |
| GET | `/receipts/{id}` | - | `getPortalReceipt` | `portal_requests.go` |

## /recognitions  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/recognitions` | - | `listRecognitions` | `hr_lifecycle.go` |
| POST | `/recognitions` | `hr.employees.write` | `recordRecognition` | `hr_lifecycle.go` |

## /ref-data  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/ref-data` | - | `getRefData` | `api.go` |

## /remarks  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/remarks` | - | `listRemarks` | `faculty_comms.go` |
| POST | `/remarks` | - | `createRemark` | `faculty_comms.go` |
| PUT | `/remarks/{id}` | - | `updateRemark` | `faculty_comms.go` |

## /report-builder  (10)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/report-builder/definitions` | `admin.reports.read` | `listReportDefinitions` | `report_builder.go` |
| POST | `/report-builder/definitions` | `admin.reports.read` | `saveReportDefinition` | `report_builder.go` |
| DELETE | `/report-builder/definitions/{id}` | `admin.reports.read` | `deleteReportDefinition` | `report_builder.go` |
| GET | `/report-builder/definitions/{id}` | `admin.reports.read` | `getReportDefinition` | `report_builder.go` |
| GET | `/report-builder/definitions/{id}/run` | `admin.reports.read` | `runReportDefinition` | `report_builder.go` |
| GET | `/report-builder/definitions/{id}/runs` | `admin.reports.read` | `listReportRuns` | `report_builder.go` |
| POST | `/report-builder/definitions/{id}/shares` | `admin.reports.read` | `shareReportDefinition` | `report_builder.go` |
| DELETE | `/report-builder/definitions/{id}/shares/{role}` | `admin.reports.read` | `unshareReportDefinition` | `report_builder.go` |
| POST | `/report-builder/preview` | `admin.reports.read` | `previewReport` | `report_builder.go` |
| GET | `/report-builder/schema` | `admin.reports.read` | `getReportSchema` | `report_builder.go` |

## /report-remarks  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/report-remarks` | - | `listReportRemarks` | `faculty_comms.go` |
| PUT | `/report-remarks` | - | `saveReportRemark` | `faculty_comms.go` |

## /requests  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/requests` | - | `listPortalRequests` | `portal_requests.go` |
| POST | `/requests` | - | `raisePortalRequest` | `portal_requests.go` |
| GET | `/requests/types` | - | `listPortalRequestTypes` | `portal_requests.go` |

## /rollups  (19)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/rollups/departments/academics` | `admin.reports.read` | `getDeptAcademics` | `admin_rollups.go` |
| GET | `/rollups/departments/reports` | `admin.reports.read` | `getDeptReports` | `admin_rollups.go` |
| GET | `/rollups/fees/ageing` | `finance.invoices.read` | `getFeeAgeing` | `admin_rollups.go` |
| GET | `/rollups/fees/collections` | `finance.payments.read` | `getCollectionSummary` | `admin_rollups.go` |
| GET | `/rollups/fees/collections/by-collector` | `finance.payments.read` | `getCollectionByCollector` | `admin_rollups.go` |
| GET | `/rollups/fees/collections/by-head` | `finance.payments.read` | `getCollectionByHead` | `admin_rollups.go` |
| GET | `/rollups/fees/collections/tie-out` | `finance.payments.read` | `getCollectionTieOut` | `admin_rollups.go` |
| GET | `/rollups/fees/concessions` | `finance.invoices.read` | `getFeeConcessions` | `admin_rollups.go` |
| GET | `/rollups/fees/overview` | `finance.invoices.read` | `getFeeOverview` | `admin_rollups.go` |
| GET | `/rollups/hr/attendance` | `hr.employees.read` | `getHRAttendance` | `admin_rollups.go` |
| GET | `/rollups/hr/expiries` | `hr.employees.read` | `getHRExpiries` | `admin_rollups.go` |
| GET | `/rollups/hr/headcount` | `hr.employees.read` | `getHRHeadcount` | `admin_rollups.go` |
| GET | `/rollups/hr/movement` | `hr.employees.read` | `getHRMovement` | `admin_rollups.go` |
| GET | `/rollups/hr/workload` | `hr.employees.read` | `getHRWorkload` | `admin_rollups.go` |
| GET | `/rollups/performance/at-risk` | `admin.reports.read` | `getPerfAtRisk` | `admin_rollups.go` |
| GET | `/rollups/performance/distribution` | `admin.reports.read` | `getPerfDistribution` | `admin_rollups.go` |
| GET | `/rollups/performance/subjects` | `admin.reports.read` | `getPerfSubjects` | `admin_rollups.go` |
| GET | `/rollups/performance/trend` | `admin.reports.read` | `getPerfTrend` | `admin_rollups.go` |
| GET | `/rollups/today` | `admin.reports.read` | `getToday` | `admin_rollups.go` |

## /school-life  (9)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/school-life/calendar` | - | `getFamilyCalendar` | `portal_school_life.go` |
| GET | `/school-life/event-passes` | - | `listEventPasses` | `portal_school_life.go` |
| POST | `/school-life/event-passes` | - | `claimEventPass` | `portal_school_life.go` |
| GET | `/school-life/gallery` | - | `listGalleryAlbums` | `portal_school_life.go` |
| GET | `/school-life/gallery/{id}` | - | `getGalleryAlbum` | `portal_school_life.go` |
| POST | `/school-life/ptm/book` | - | `bookPTMSlot` | `portal_school_life.go` |
| GET | `/school-life/ptm/bookings` | - | `listPTMBookings` | `portal_school_life.go` |
| GET | `/school-life/ptm/slots` | - | `listPTMSlots` | `portal_school_life.go` |
| POST | `/school-life/ptm/{id}/cancel` | - | `cancelPTMBooking` | `portal_school_life.go` |

## /seller  (18)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/seller/broadcasts` | `platform.tenants.write` | `listPlatformBroadcasts` | `api.go` |
| POST | `/seller/broadcasts` | `platform.tenants.write` | `raisePlatformBroadcast` | `api.go` |
| DELETE | `/seller/broadcasts/{id}` | `platform.tenants.write` | `retirePlatformBroadcast` | `api.go` |
| PUT | `/seller/costs` | `platform.tenants.write` | `setPlatformCosts` | `api.go` |
| GET | `/seller/enquiries` | `platform.tenants.write` | `listSalesEnquiries` | `api.go` |
| GET | `/seller/events` | `platform.tenants.write` | `listPlatformEvents` | `api.go` |
| GET | `/seller/limits` | `platform.tenants.write` | `listTenantLimits` | `api.go` |
| PUT | `/seller/limits` | `platform.tenants.write` | `setTenantLimits` | `api.go` |
| GET | `/seller/plans` | `platform.tenants.write` | `listPlans` | `api.go` |
| POST | `/seller/plans` | `platform.tenants.write` | `createPlan` | `api.go` |
| DELETE | `/seller/plans/{code}` | `platform.tenants.write` | `retirePlan` | `api.go` |
| PUT | `/seller/plans/{code}` | `platform.tenants.write` | `updatePlan` | `api.go` |
| GET | `/seller/tenants` | `platform.tenants.write` | `listTenants` | `api.go` |
| POST | `/seller/tenants` | `platform.tenants.write` | `provisionTenant` | `api.go` |
| POST | `/seller/tenants/{id}/reset-admin` | `platform.tenants.write` | `resetTenantAdmin` | `api.go` |
| PUT | `/seller/tenants/{id}/subscription` | `platform.tenants.write` | `setSubscription` | `api.go` |
| GET | `/seller/tickets` | `platform.tenants.write` | `listTickets` | `api.go` |
| GET | `/seller/usage` | `platform.tenants.write` | `getPlatformUsage` | `api.go` |

## /seniority  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/seniority` | - | `listSeniority` | `hr_lifecycle.go` |

## /service-book  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/service-book` | - | `listServiceBook` | `hr_lifecycle.go` |
| POST | `/service-book` | `hr.employees.write` | `addServiceBookEntry` | `hr_lifecycle.go` |
| POST | `/service-book/{id}/attest` | `hr.employees.write` | `attestServiceBookEntry` | `hr_lifecycle.go` |

## /service-certificates  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/service-certificates` | - | `listServiceCertificates` | `hr_lifecycle.go` |

## /session  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/session` | - | `getSession` | `api.go` |

## /setup  (57)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/setup/academic-years` | `academics.write` | `createAcademicYear` | `api.go` |
| PATCH | `/setup/academic-years/{id}` | `academics.write` | `updateAcademicYear` | `api.go` |
| POST | `/setup/assign-teacher` | `academics.write` | `assignTeacher` | `api.go` |
| GET | `/setup/biometric-devices` | `hr.employees.read` | `listBiometricDevices` | `api.go` |
| POST | `/setup/biometric-devices` | `hr.employees.write` | `saveBiometricDevice` | `api.go` |
| GET | `/setup/biometric-devices/unclaimed` | `hr.employees.read` | `listUnresolvedPunches` | `api.go` |
| GET | `/setup/boards` | `institution.read` | `listBoardPresets` | `api.go` |
| POST | `/setup/boards/apply` | `institution.settings.write` | `applyBoardPreset` | `api.go` |
| GET | `/setup/campuses` | `institution.read` | `listCampuses` | `api.go` |
| POST | `/setup/campuses` | `institution.write` | `createCampus` | `api.go` |
| PUT | `/setup/campuses/{id}` | `institution.write` | `updateCampus` | `api.go` |
| GET | `/setup/class-subjects` | `academics.read` | `listClassSubjects` | `api.go` |
| PUT | `/setup/class-subjects` | `academics.write` | `setClassSubjects` | `api.go` |
| POST | `/setup/class-teacher` | `academics.write` | `setClassTeacher` | `api.go` |
| POST | `/setup/classes` | `academics.write` | `createClass` | `api.go` |
| DELETE | `/setup/classes/{id}` | `academics.write` | `deleteClass` | `api.go` |
| PATCH | `/setup/classes/{id}` | `academics.write` | `updateClass` | `api.go` |
| POST | `/setup/employees` | `hr.employees.write` | `createEmployee` | `api.go` |
| PATCH | `/setup/employees/{id}` | `hr.employees.write` | `updateEmployee` | `api.go` |
| POST | `/setup/employees/{id}/login` | `hr.employees.write` | `issueStaffLogin` | `api.go` |
| POST | `/setup/employees/{id}/pin` | `hr.employees.write` | `issueStaffPIN` | `api.go` |
| POST | `/setup/exams` | `academics.exams.write` | `createExam` | `api.go` |
| DELETE | `/setup/exams/{id}` | `academics.exams.write` | `deleteExam` | `api.go` |
| PATCH | `/setup/exams/{id}` | `academics.exams.write` | `updateExam` | `api.go` |
| GET | `/setup/fee-classes` | `finance.fees.read` | `listClasses` | `api.go` |
| GET | `/setup/fee-heads` | `finance.fees.read` | `listFeeHeads` | `api.go` |
| POST | `/setup/fee-heads` | `finance.fees.write` | `createFeeHead` | `api.go` |
| DELETE | `/setup/fee-heads/{id}` | `finance.fees.write` | `deleteFeeHead` | `api.go` |
| PATCH | `/setup/fee-heads/{id}` | `finance.fees.write` | `updateFeeHead` | `api.go` |
| GET | `/setup/fee-structures` | `finance.fees.read` | `listFeeStructures` | `api.go` |
| POST | `/setup/fee-structures` | `finance.fees.write` | `createFeeStructure` | `api.go` |
| GET | `/setup/grading-scales` | `academics.exams.read` | `listGradingScales` | `api.go` |
| POST | `/setup/grading-scales` | `academics.exams.write` | `createGradingScale` | `api.go` |
| DELETE | `/setup/grading-scales/{id}` | `academics.exams.write` | `deleteGradingScale` | `api.go` |
| GET | `/setup/import/history` | - | `listImportRuns` | `api.go` |
| GET | `/setup/import/history/{id}/content` | - | `getImportContent` | `api.go` |
| POST | `/setup/import/history/{id}/undo` | - | `undoImport` | `api.go` |
| POST | `/setup/import/{entity}` | - | `bulkImport` | `api.go` |
| GET | `/setup/import/{entity}/fields` | - | `getImportFields` | `api.go` |
| GET | `/setup/import/{entity}/template` | - | `getBulkTemplate` | `api.go` |
| GET | `/setup/institution` | `institution.read` | `getInstitution` | `api.go` |
| PUT | `/setup/institution` | `institution.write` | `updateInstitution` | `api.go` |
| GET | `/setup/institution/options` | `institution.read` | `getInstitutionOptions` | `api.go` |
| POST | `/setup/logins/bulk` | - | `issueLoginsInBulk` | `api.go` |
| POST | `/setup/logins/import` | `hr.employees.write` | `importStaffLogins` | `api.go` |
| GET | `/setup/option-kinds` | `institution.read` | `listCustomisableKinds` | `api.go` |
| GET | `/setup/options` | `institution.read` | `listOptions` | `api.go` |
| POST | `/setup/options` | `institution.settings.write` | `addOption` | `api.go` |
| DELETE | `/setup/options/{id}` | `institution.settings.write` | `retireOption` | `api.go` |
| PUT | `/setup/periods` | `academics.write` | `setPeriods` | `api.go` |
| POST | `/setup/sections` | `academics.write` | `createSection` | `api.go` |
| DELETE | `/setup/sections/{id}` | `academics.write` | `deleteSection` | `api.go` |
| PATCH | `/setup/sections/{id}` | `academics.write` | `updateSection` | `api.go` |
| GET | `/setup/status` | `institution.read` | `getSetupStatus` | `api.go` |
| POST | `/setup/subjects` | `academics.write` | `createSubject` | `api.go` |
| DELETE | `/setup/subjects/{id}` | `academics.write` | `deleteSubject` | `api.go` |
| PATCH | `/setup/subjects/{id}` | `academics.write` | `updateSubject` | `api.go` |

## /sms-gateway  (8)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/sms-gateway` | `institution.read` | `getSMSGatewayOverview` | `sms_gateway.go` |
| PUT | `/sms-gateway/devices/{id}` | `institution.integrations.write` | `updateSMSGatewayDevice` | `sms_gateway.go` |
| POST | `/sms-gateway/devices/{id}/approve` | `institution.integrations.write` | `approveSMSGatewayDevice` | `sms_gateway.go` |
| POST | `/sms-gateway/devices/{id}/revoke` | `institution.integrations.write` | `revokeSMSGatewayDevice` | `sms_gateway.go` |
| POST | `/sms-gateway/heartbeat` | - | `smsGatewayHeartbeat` | `sms_gateway.go` |
| GET | `/sms-gateway/outbox` | - | `smsGatewayOutbox` | `sms_gateway.go` |
| POST | `/sms-gateway/pair` | `institution.integrations.write` | `pairSMSGatewayDevice` | `sms_gateway.go` |
| POST | `/sms-gateway/receipts` | - | `smsGatewayReceipts` | `sms_gateway.go` |

## /staff-messages  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/staff-messages` | - | `listStaffMessages` | `api.go` |
| POST | `/staff-messages` | - | `sendStaffMessage` | `api.go` |
| GET | `/staff-messages/threads` | - | `listStaffThreads` | `api.go` |

## /staff-remarks  (3)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/staff-remarks` | - | `listStaffRemarks` | `api.go` |
| POST | `/staff-remarks` | - | `createStaffRemark` | `api.go` |
| GET | `/staff-remarks/teachers` | - | `listRemarkableTeachers` | `api.go` |

## /statutory  (39)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/statutory/child-info/differences` | `admin.reports.read` | `listChildInfoDifferences` | `statutory.go` |
| POST | `/statutory/child-info/differences/{id}/resolve` | `students.write` | `resolveChildInfoDifference` | `statutory.go` |
| POST | `/statutory/child-info/import` | `students.write` | `importChildInfoExtract` | `statutory.go` |
| GET | `/statutory/child-info/imports` | `admin.reports.read` | `listChildInfoImports` | `statutory.go` |
| GET | `/statutory/child-info/resolutions` | `admin.reports.read` | `listChildInfoResolutions` | `statutory.go` |
| DELETE | `/statutory/child-info/resolutions/{id}` | `students.write` | `forgetChildInfoResolution` | `statutory.go` |
| GET | `/statutory/loc/subject-rules` | `admin.reports.read` | `listLOCSubjectRules` | `statutory.go` |
| POST | `/statutory/loc/subject-rules` | `academics.exams.write` | `saveLOCSubjectRule` | `statutory.go` |
| DELETE | `/statutory/loc/subject-rules/{id}` | `academics.exams.write` | `deleteLOCSubjectRule` | `statutory.go` |
| GET | `/statutory/loc/submissions` | `admin.reports.read` | `listLOCSubmissions` | `statutory.go` |
| POST | `/statutory/loc/submissions` | `academics.exams.write` | `createLOCSubmission` | `statutory.go` |
| GET | `/statutory/loc/submissions/{id}` | `admin.reports.read` | `getLOCSubmission` | `statutory.go` |
| GET | `/statutory/loc/submissions/{id}/export` | `admin.reports.read` | `exportLOCSubmission` | `statutory.go` |
| POST | `/statutory/loc/submissions/{id}/file` | `academics.exams.write` | `fileLOCSubmission` | `statutory.go` |
| POST | `/statutory/loc/submissions/{id}/validate` | `academics.exams.write` | `validateLOCSubmission` | `statutory.go` |
| GET | `/statutory/portal/connectors` | `platform.tenants.write` | `listChildInfoConnectors` | `statutory.go` |
| POST | `/statutory/portal/connectors` | `platform.tenants.write` | `saveChildInfoConnector` | `statutory.go` |
| DELETE | `/statutory/portal/connectors/{id}` | `platform.tenants.write` | `deleteChildInfoConnector` | `statutory.go` |
| POST | `/statutory/portal/connectors/{id}/runs` | `platform.tenants.write` | `recordChildInfoRun` | `statutory.go` |
| GET | `/statutory/portal/export` | `platform.tenants.write` | `exportChildInfoRoster` | `statutory.go` |
| GET | `/statutory/portal/runs` | `platform.tenants.write` | `listChildInfoRuns` | `statutory.go` |
| GET | `/statutory/sqaa/actions` | `admin.reports.read` | `listSQAAActions` | `statutory.go` |
| POST | `/statutory/sqaa/actions` | `institution.write` | `saveSQAAAction` | `statutory.go` |
| GET | `/statutory/sqaa/assessments` | `admin.reports.read` | `listSQAAAssessments` | `statutory.go` |
| POST | `/statutory/sqaa/assessments` | `institution.write` | `createSQAAAssessment` | `statutory.go` |
| GET | `/statutory/sqaa/assessments/{id}` | `admin.reports.read` | `getSQAAAssessment` | `statutory.go` |
| PUT | `/statutory/sqaa/assessments/{id}/entries` | `institution.write` | `saveSQAAEntry` | `statutory.go` |
| POST | `/statutory/sqaa/assessments/{id}/submit` | `institution.write` | `submitSQAAAssessment` | `statutory.go` |
| POST | `/statutory/sqaa/entries/{id}/evidence` | `institution.write` | `addSQAAEvidence` | `statutory.go` |
| DELETE | `/statutory/sqaa/evidence/{id}` | `institution.write` | `removeSQAAEvidence` | `statutory.go` |
| GET | `/statutory/sqaa/frameworks` | `admin.reports.read` | `listSQAASchoolFrameworks` | `statutory.go` |
| GET | `/statutory/working-days` | `admin.reports.read` | `getWorkingDays` | `statutory.go` |
| GET | `/statutory/working-days/adjustments` | `admin.reports.read` | `listWorkingDayAdjustments` | `statutory.go` |
| POST | `/statutory/working-days/adjustments` | `academics.write` | `saveWorkingDayAdjustment` | `statutory.go` |
| DELETE | `/statutory/working-days/adjustments/{id}` | `academics.write` | `deleteWorkingDayAdjustment` | `statutory.go` |
| GET | `/statutory/working-days/norms` | `admin.reports.read` | `listInstructionalNorms` | `statutory.go` |
| PUT | `/statutory/working-days/norms` | `academics.write` | `saveInstructionalNorm` | `statutory.go` |
| GET | `/statutory/working-days/returns` | `admin.reports.read` | `listWorkingDaysReturns` | `statutory.go` |
| POST | `/statutory/working-days/returns` | `institution.write` | `fileWorkingDaysReturn` | `statutory.go` |

## /students  (20)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/students` | `students.read` | `listStudents` | `api.go` |
| POST | `/students` | `students.read`, `students.write` | `createStudent` | `api.go` |
| GET | `/students/counts` | `students.read` | `studentCounts` | `api.go` |
| GET | `/students/fee-preview` | `students.read` | `admissionFeePreview` | `api.go` |
| POST | `/students/import` | `students.read`, `students.write` | `importStudents` | `api.go` |
| GET | `/students/import/template` | `students.read` | `getImportTemplate` | `api.go` |
| GET | `/students/notes` | `students.read` | `listDisciplineNotes` | `api.go` |
| POST | `/students/notes` | `welfare.discipline.write`, `students.read` | `recordDisciplineNote` | `api.go` |
| POST | `/students/photos/import` | `students.read`, `students.write` | `importStudentPhotos` | `api.go` |
| GET | `/students/support-plans` | `students.read` | `listSupportPlans` | `api.go` |
| PUT | `/students/support-plans` | `students.read`, `students.write` | `saveSupportPlan` | `api.go` |
| DELETE | `/students/{id}` | `students.read`, `students.write` | `deleteStudent` | `api.go` |
| GET | `/students/{id}` | `students.read` | `getStudent` | `api.go` |
| PUT | `/students/{id}` | `students.read`, `students.write` | `updateStudent` | `api.go` |
| GET | `/students/{id}/detail` | `students.read` | `getStudentDetail` | `api.go` |
| POST | `/students/{id}/exit` | `students.read`, `students.write` | `recordStudentExit` | `api.go` |
| PUT | `/students/{id}/photo` | `students.read`, `students.write` | `setStudentPhoto` | `api.go` |
| GET | `/students/{id}/profile` | `students.read` | `getStudentProfile` | `api.go` |
| POST | `/students/{id}/readmit` | `students.read`, `students.write` | `readmitStudent` | `api.go` |
| POST | `/students/{id}/suspend` | `students.read`, `students.write` | `suspendStudent` | `api.go` |

## /subjects  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/subjects` | - | `listTeachingSubjects` | `teaching.go` |

## /syllabus  (5)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/syllabus/coverage` | - | `getSyllabusCoverage` | `api.go` |
| GET | `/syllabus/lesson-plans` | - | `listLessonPlans` | `api.go` |
| POST | `/syllabus/lesson-plans` | - | `saveLessonPlan` | `api.go` |
| GET | `/syllabus/units` | - | `listSyllabusUnits` | `api.go` |
| PUT | `/syllabus/units` | `academics.write` | `setSyllabusUnits` | `api.go` |

## /tally  (14)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/tally/connector` | `platform.tenants.write` | `getTallyConnector` | `tally.go` |
| PUT | `/tally/connector` | `platform.tenants.write` | `saveTallyConnector` | `tally.go` |
| GET | `/tally/connector/accounts` | `platform.tenants.write` | `listTallyMappableAccounts` | `tally.go` |
| GET | `/tally/connector/gateway` | `platform.tenants.write` | `getTallyGateway` | `tally.go` |
| PUT | `/tally/connector/gateway` | `platform.tenants.write` | `saveTallyGateway` | `tally.go` |
| PUT | `/tally/connector/mappings` | `platform.tenants.write` | `saveTallyMappings` | `tally.go` |
| PUT | `/tally/connector/voucher-types` | `platform.tenants.write` | `saveTallyVoucherTypes` | `tally.go` |
| POST | `/tally/connector/voucher-types/defaults` | `platform.tenants.write` | `seedTallyVoucherTypes` | `tally.go` |
| POST | `/tally/export` | `finance.export` | `createTallyExport` | `tally.go` |
| GET | `/tally/runs` | - | `listTallyExportRuns` | `tally.go` |
| POST | `/tally/runs/{id}/confirm` | `finance.export` | `confirmTallyExport` | `tally.go` |
| GET | `/tally/runs/{id}/file` | `finance.export` | `downloadTallyExport` | `tally.go` |
| GET | `/tally/settings` | - | `getTallyExportSettings` | `tally.go` |
| GET | `/tally/validate` | `finance.export` | `validateTallyExport` | `tally.go` |

## /teaching  (7)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/teaching/classes` | `academics.timetable.read` | `listMyClasses` | `api.go` |
| GET | `/teaching/hod-dashboard` | `academics.timetable.read` | `getHODDashboard` | `api.go` |
| GET | `/teaching/my-work` | `academics.timetable.read` | `getMyWork` | `api.go` |
| GET | `/teaching/parent-messages` | `academics.timetable.read` | `listTeacherParentThreads` | `api.go` |
| GET | `/teaching/parent-messages/thread` | `academics.timetable.read` | `listTeacherParentMessages` | `api.go` |
| GET | `/teaching/progress` | `academics.timetable.read` | `listStudentProgress` | `api.go` |
| GET | `/teaching/today` | `academics.timetable.read` | `listTodaysClasses` | `api.go` |

## /terms  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/terms` | - | `listTeachingTerms` | `faculty_comms.go` |

## /timetable  (4)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/timetable/bell-schedules` | `academics.timetable.read` | `listBellSchedules` | `api.go` |
| GET | `/timetable/entries` | `academics.timetable.read` | `listTimetableEntries` | `api.go` |
| GET | `/timetable/periods` | `academics.timetable.read` | `listPeriods` | `api.go` |
| GET | `/timetable/teachers` | `academics.timetable.read` | `listTeachers` | `api.go` |

## /timetable-admin  (1)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| POST | `/timetable-admin/substitutions` | `academics.timetable.write` | `createSubstitution` | `api.go` |

## /timetable-cover  (6)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/timetable-cover/my-periods` | - | `listCoverablePeriods` | `timetable_ops.go` |
| GET | `/timetable-cover/requests` | - | `listCoverRequests` | `timetable_ops.go` |
| POST | `/timetable-cover/requests` | - | `createCoverRequest` | `timetable_ops.go` |
| GET | `/timetable-cover/requests/{id}` | - | `getCoverRequest` | `timetable_ops.go` |
| POST | `/timetable-cover/requests/{id}/cancel` | - | `cancelCoverRequest` | `timetable_ops.go` |
| POST | `/timetable-cover/requests/{id}/decide` | `academics.timetable.write` | `decideCoverRequest` | `timetable_ops.go` |

## /timetable-optimizer  (10)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/timetable-optimizer/drafts` | - | `listTimetableDrafts` | `timetable_ops.go` |
| POST | `/timetable-optimizer/drafts` | `academics.timetable.write` | `generateTimetableDraft` | `timetable_ops.go` |
| GET | `/timetable-optimizer/drafts/{id}` | - | `getTimetableDraft` | `timetable_ops.go` |
| POST | `/timetable-optimizer/drafts/{id}/discard` | `academics.timetable.write` | `discardTimetableDraft` | `timetable_ops.go` |
| POST | `/timetable-optimizer/drafts/{id}/publish` | `academics.timetable.write` | `publishTimetableDraft` | `timetable_ops.go` |
| GET | `/timetable-optimizer/inputs` | - | `getOptimizerInputs` | `timetable_ops.go` |
| PUT | `/timetable-optimizer/load-rules` | `academics.timetable.write` | `saveTeacherLoadRule` | `timetable_ops.go` |
| PUT | `/timetable-optimizer/requirements` | `academics.timetable.write` | `saveSubjectRequirement` | `timetable_ops.go` |
| POST | `/timetable-optimizer/unavailability` | `academics.timetable.write` | `saveTeacherUnavailability` | `timetable_ops.go` |
| DELETE | `/timetable-optimizer/unavailability/{id}` | `academics.timetable.write` | `deleteTeacherUnavailability` | `timetable_ops.go` |

## /tour  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/tour` | - | `getTour` | `api.go` |
| POST | `/tour` | - | `setTour` | `api.go` |

## /transfers  (2)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/transfers` | - | `listTransfers` | `hr_lifecycle.go` |
| POST | `/transfers` | `hr.employees.write` | `saveTransfer` | `hr_lifecycle.go` |

## /transport  (11)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/transport/live` | `operations.transport.read` | `listLiveVehicles` | `bus_tracking_views.go` |
| GET | `/transport/safety-events` | `operations.transport.read` | `listSafetyEvents` | `bus_tracking_views.go` |
| POST | `/transport/safety-events/{id}/review` | `operations.transport.write` | `reviewSafetyEvent` | `bus_tracking_views.go` |
| GET | `/transport/stop-events` | `operations.transport.read` | `listStopEvents` | `bus_tracker_admin.go` |
| GET | `/transport/trackers` | `operations.transport.read` | `listTrackers` | `bus_tracker_admin.go` |
| POST | `/transport/trackers/pair` | `operations.transport.write` | `pairBusTracker` | `bus_tracker.go` |
| PUT | `/transport/trackers/{id}` | `operations.transport.write` | `updateTracker` | `bus_tracker_admin.go` |
| POST | `/transport/trackers/{id}/approve` | `operations.transport.write` | `approveBusTracker` | `bus_tracker.go` |
| POST | `/transport/trackers/{id}/revoke` | `operations.transport.write` | `revokeTracker` | `bus_tracker_admin.go` |
| GET | `/transport/tracking-policy` | `operations.transport.read` | `getTrackingPolicy` | `bus_tracker_admin.go` |
| PUT | `/transport/tracking-policy` | `operations.transport.write` | `saveTrackingPolicy` | `bus_tracker_admin.go` |

## /virtual-classes  (5)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/virtual-classes` | - | `listVirtualClasses` | `teaching.go` |
| POST | `/virtual-classes` | - | `scheduleVirtualClass` | `teaching.go` |
| GET | `/virtual-classes/providers` | - | `listVirtualClassProviders` | `teaching.go` |
| PUT | `/virtual-classes/{id}` | - | `updateVirtualClass` | `teaching.go` |
| POST | `/virtual-classes/{id}/launch` | - | `launchVirtualClass` | `teaching.go` |

## /whatsapp  (9)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/whatsapp/log` | - | `listWhatsAppLog` | `whatsapp.go` |
| DELETE | `/whatsapp/settings` | `institution.integrations.write` | `forgetWhatsAppSettings` | `whatsapp.go` |
| GET | `/whatsapp/settings` | `institution.read` | `getWhatsAppSettings` | `whatsapp.go` |
| PUT | `/whatsapp/settings` | `institution.integrations.write` | `saveWhatsAppSettings` | `whatsapp.go` |
| GET | `/whatsapp/templates` | `institution.read` | `listWhatsAppTemplates` | `whatsapp.go` |
| PUT | `/whatsapp/templates` | `institution.settings.write` | `saveWhatsAppTemplate` | `whatsapp.go` |
| POST | `/whatsapp/templates/submit` | `institution.integrations.write` | `submitWhatsAppTemplates` | `whatsapp.go` |
| POST | `/whatsapp/templates/{code}/submit` | `institution.integrations.write` | `submitWhatsAppTemplates` | `whatsapp.go` |
| POST | `/whatsapp/test` | `comms.messages.send` | `testWhatsApp` | `whatsapp.go` |

## /workflow  (6)

| Method | Path | Permissions | Handler | File |
| --- | --- | --- | --- | --- |
| GET | `/workflow/approvals` | - | `getApprovals` | `api.go` |
| POST | `/workflow/concessions/{id}/decide` | `finance.fees.write` | `decideConcession` | `api.go` |
| POST | `/workflow/leave` | - | `applyForLeave` | `api.go` |
| POST | `/workflow/leave/{id}/decide` | - | `decideLeave` | `api.go` |
| POST | `/workflow/staff-attendance` | `hr.attendance.write` | `markStaffAttendance` | `api.go` |
| GET | `/workflow/staff-register` | `hr.attendance.write` | `getStaffRegister` | `api.go` |
