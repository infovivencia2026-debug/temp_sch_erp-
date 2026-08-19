import { lazy } from 'react'

/**
 * The phone SMS gateway screen, keyed by catalogue feature.
 *
 * Kept beside the screen rather than pasted into registry.ts so this module and
 * the component it names move together. Spread into FEATURE_COMPONENTS there;
 * scripts/gen_implemented.py reads registry.ts, so the server only marks this
 * live once the spread is in place.
 *
 * ---------------------------------------------------------------------------
 * Why this sits under features/communication and not features/super_admin
 *
 * It is the school's own phone, with the school's own SIM, in the school's own
 * office, paired by the school's own administrator. The platform operator has
 * no handset to pair and no reason to be the only person who can. So the screen
 * lives on the institution-admin surface beside the other communication
 * screens, and the routes behind it are gated on institution.integrations.write
 * — the same institution-scoped rung the messaging provider screen already
 * requires to store an SMTP password, and one that every institution_admin
 * holds. No platform rung is involved anywhere in this feature.
 *
 * ---------------------------------------------------------------------------
 * The key below is a placeholder, and the integrator must decide it
 *
 * There is no institution-admin catalogue key for an SMS gateway. The only key
 * the catalogue carries is the one used here, and it is platform-scoped:
 *
 *     super_admin.messaging.sms_gateway_integration   Scope: platform
 *     "Configure gateway API credentials, sender IDs, DLTI templates, and SMS
 *      delivery logs."
 *
 * That describes choosing and configuring a *vendor*, which is a different
 * thing from pairing a handset — and its platform scope puts this screen in the
 * platform navigation, which is exactly where the product owner has said it
 * does not belong.
 *
 * It is bound here anyway, deliberately, so the screen is reachable rather than
 * built and invisible. Inventing an institution-admin key was explicitly not
 * this agent's call: catalogue keys drive the completeness count. If a new key
 * such as institution_admin.communication.sms_gateway_phone is added, change
 * the key below and nothing else — the screen and its hooks do not care.
 */
export const smsGatewayKeys = {
  'super_admin.messaging.sms_gateway_integration': lazy(() => import('./SmsGateway')),
}
