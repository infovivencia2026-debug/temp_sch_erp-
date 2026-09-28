/* The boot call and the menu. internal/api/session.go, catalog.go. */

export interface SessionResponse {
  authenticated: boolean
  user?: {
    id: string
    full_name: string
    roles: string[]
    platform_admin: boolean
    /** Still on the password the office issued — their own phone number. */
    must_change_password?: boolean
    /** Signed in with the teachers' day code on a shared screen; the
        password form is hidden because the API refuses it. */
    day_code?: boolean
    /** The file id of their photograph, absent if they have none. Carried on
        the session so every surface that shows who is signed in can draw it,
        rather than each one fetching /profile for a single string. */
    avatar_key?: string
  }
  institution?: {
    id: string; name: string; short_name: string; slug: string
    primary_color: string; timezone: string; locale: string
    // The white-label overrides, folded in by the session. Empty on a school
    // that has set no branding.
    display_name?: string; tagline?: string
    logo_key?: string; favicon_key?: string; accent_color?: string
    // The school's UPI address for fees, absent when none is set -- and then
    // no screen offers a UPI code. The payee name is already defaulted to the
    // school's name by the server.
    upi_vpa?: string; upi_payee_name?: string
    /** The no-money test payment is offered only where the server allows
        it -- never in production, where the endpoint is 404. */
    simulated_pay?: boolean
    /** What a printed document's letterhead carries under the name: the main
        campus's postal address, and the school's phone and email (the
        branding contact first, the campus's own otherwise). Absent when the
        school has not entered them. */
    address?: string; phone?: string; email?: string
    /** Board affiliation or UDISE code, for the letterhead's small print. */
    affiliation?: string
  }
  permissions: string[]
  modules?: { module: string; enabled: boolean }[]
  /** What the school has bought, and whether it is paid up. Absent for
   *  platform staff, who are not customers and have nothing to buy. */
  subscription?: Subscription
}

export interface Subscription {
  active: boolean
  /** none | expired | past_due | suspended | cancelled — for branching on the
   *  reason without parsing the prose in `reason`. */
  code?: string
  reason?: string
  plan_code?: string
  plan_name?: string
  status?: string
  trial_ends_on?: string
  modules: string[]
  /** Whether this pack may link the school's own SMS/WhatsApp vendor account.
   *  Decides what the messaging screen offers; the gate is on the server. */
  custom_integration?: boolean
}

/** GET /session answers even when nobody is signed in: authenticated false. */
export interface SessionApi {
  'GET /session': { res: SessionResponse }
}
