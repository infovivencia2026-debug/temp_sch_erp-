/* The API contract between web/ and worker/. Types only.

   `Api` maps "METHOD /path" (the path as the Worker registers it, under
   /api/v1, with {placeholders}) to what goes in and comes out. The Worker
   registers these with `r.typed(...)` (worker/src/router.ts) and the web
   calls them with `api.call(...)` (web/src/lib/api.ts), so both are compiled
   against the same shape. Routes not listed here still work through r.get /
   api.get; scripts/check-api-contract.mjs lists them. */
export * from './contract'
export * from './session'
export * from './catalog'
export * from './students'
export * from './attendance'
export * from './timetable'
export * from './fees'
export * from './exams'
export * from './staff'
export * from './notifications'
export * from './messages'
export * from './dashboards'

import type { SessionApi } from './session'
import type { CatalogApi } from './catalog'
import type { StudentsApi } from './students'
import type { AttendanceApi } from './attendance'
import type { TimetableApi } from './timetable'
import type { FeesApi } from './fees'
import type { ExamsApi } from './exams'
import type { StaffApi } from './staff'
import type { NotificationsApi } from './notifications'
import type { MessagesApi } from './messages'
import type { DashboardsApi } from './dashboards'

export interface Api extends SessionApi, CatalogApi, StudentsApi, AttendanceApi, TimetableApi, FeesApi, ExamsApi,
  StaffApi, NotificationsApi, MessagesApi, DashboardsApi {}
