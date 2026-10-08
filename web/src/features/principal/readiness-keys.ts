import { screen } from '@/lib/screen'

/* The screens a school needs in its first month and every month after:
   the rules it sets once, the move from MyClassBoard, and what the returns
   still need. Spread into FEATURE_COMPONENTS in registry.ts. */
export const readinessKeys = {
  'institution_admin.getting_started.rules': screen(() => import('./Rules')),
  'institution_admin.getting_started.move_from_myclassboard': screen(() => import('./MoveFromMCB')),
  'institution_admin.standard.returns_readiness': screen(() => import('./ReturnsReadiness')),
}
