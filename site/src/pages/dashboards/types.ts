import type { DashboardConfig, IndustryDef } from '@/industries/types'
import type { Derived } from './data'

/** Every layout receives the same three things and nothing else. */
export interface LayoutProps {
  cfg: DashboardConfig
  d: Derived
  industry: IndustryDef
}
