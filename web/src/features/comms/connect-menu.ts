import {
  BarChart3, Bot, CalendarDays, FileText, LayoutDashboard, Megaphone, MessagesSquare, NotebookPen, ScrollText, Send, Settings, Users,
  type LucideIcon,
} from 'lucide-react'

/* Yajur Connect's screens, by the original app's names and in its menu order
   and groups (owner, 2026-11-23). Shared by the main menu, which shows them as
   Yajur Connect's own group, and by the screen, which shows the one asked for.
   Line icons from the same set as the rest of the menu (owner: "within our
   theme"). 'campaigns' and 'scheduled' stay valid keys so old links open
   Notice history. */
export type ConnectTabKey = 'overview' | 'chats' | 'send' | 'workbooks' | 'people' | 'templates' | 'history' | 'campaigns' | 'scheduled' | 'log' | 'insights' | 'events' | 'rules' | 'settings'

export const CONNECT_MENU: { key: ConnectTabKey; label: string; group: string; icon: LucideIcon; reader?: boolean }[] = [
  { key: 'overview', label: 'Overview', group: 'Communication', icon: LayoutDashboard, reader: true },
  { key: 'chats', label: 'Parent inbox', group: 'Communication', icon: MessagesSquare, reader: true },
  { key: 'send', label: 'Send a notice', group: 'Communication', icon: Send },
  { key: 'workbooks', label: 'Daily workbooks', group: 'Communication', icon: NotebookPen },
  { key: 'people', label: 'Students & parents', group: 'School directory', icon: Users },
  { key: 'templates', label: 'Message templates', group: 'School directory', icon: FileText, reader: true },
  { key: 'history', label: 'Notice history', group: 'Activity', icon: Megaphone },
  { key: 'log', label: 'Delivery log', group: 'Activity', icon: ScrollText, reader: true },
  { key: 'insights', label: 'Insights', group: 'Activity', icon: BarChart3, reader: true },
  { key: 'events', label: 'Events & reminders', group: 'Activity', icon: CalendarDays },
  { key: 'rules', label: 'Auto-replies', group: 'Workspace', icon: Bot },
  { key: 'settings', label: 'Settings', group: 'Workspace', icon: Settings },
]

/** The feature slug the main menu lifts out of Communication into its own group. */
export const CONNECT_SLUG = 'yajur_connect'
