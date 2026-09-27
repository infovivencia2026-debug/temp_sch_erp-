/* The bell. internal/api/portal_notifications.go. */

export interface Notification {
  id: string
  kind: string
  title: string
  body?: string
  link?: string
  student_id?: string
  student_name?: string
  /** IST, "YYYY-MM-DD HH:MM". */
  created_at: string
  read_at?: string
}

export interface NotificationsApi {
  'GET /portal/notifications': { query: { student_id?: string }; res: { items: Notification[]; unread: number } }
}
