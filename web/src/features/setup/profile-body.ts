/* What the school-profile form is allowed to send back.

   GET /api/v1/setup/institution answers with everything the profile knows,
   including fields the school does not edit here (timezone). The form used to
   spread that whole answer into its PUT, and the server decodes with
   DisallowUnknownFields, so the round trip died with "malformed JSON body"
   the moment the GET carried one key the update struct did not -- which it
   did, and the admin saw it the first time they saved a UPI ID.

   The body is built from this list and nothing else. It is the update
   struct's field list (internal/api/setup_profile.go, institutionUpdate),
   kept here in the same order so a diff between the two is a one-screen
   check; add a field to both or to neither. */

export const PROFILE_EDITABLE = [
  'name',
  'short_name',
  'udise_code',
  'affiliation_board',
  'affiliation_no',
  'state',
  'district',
  'mandal',
  'village_or_ward',
  'school_category',
  'management_type',
  'child_info_code',
  'mid_day_meal',
  'upi_vpa',
  'upi_payee_name',
] as const

export type ProfileEditableKey = (typeof PROFILE_EDITABLE)[number]

/** The PUT body: only the editable keys, only where the value is set. */
export function profileBody(
  // `object`, not Record<string, unknown>: an interface such as Profile has
  // no index signature and is not assignable to the latter.
  ...layers: (object | null | undefined)[]
): Partial<Record<ProfileEditableKey, unknown>> {
  const merged = Object.assign({}, ...layers.map((l) => l ?? {})) as Record<string, unknown>
  const out: Partial<Record<ProfileEditableKey, unknown>> = {}
  for (const k of PROFILE_EDITABLE) {
    if (merged[k] !== undefined) out[k] = merged[k]
  }
  return out
}
