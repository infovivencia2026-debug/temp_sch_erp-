import { screen } from '@/lib/screen'

/* The two AI & Automation rows that could be built honestly, keyed by
   catalogue feature and spread into FEATURE_COMPONENTS in registry.ts.

   Neither is a model. Dropout risk is three rules a school already applies,
   counted per school; the cash outlook is what falls due times the share of
   last year's demand that was actually collected. The other rows of that
   section — sentiment on feedback, question translation — need an NLP or
   translation service this deployment does not have, and are left
   unimplemented rather than faked. */
export const signalsKeys = {
  'super_admin.ai_automation.predictive_dropout_risk_engine': screen(() => import('./DropoutRisk')),
  'super_admin.ai_automation.smart_fee_cash_flow_predictor': screen(() => import('./CashOutlook')),
}
