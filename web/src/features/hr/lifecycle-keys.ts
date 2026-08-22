
/**
 * The staff lifecycle screens, keyed by catalogue feature.
 *
 * Kept beside the screens rather than pasted into registry.ts so this module
 * and the four components it names move together. Spread into
 * FEATURE_COMPONENTS there; scripts/gen_implemented.py reads registry.ts, so
 * the server only marks these live once the spread is in place.
 *
 * Four components, fifteen keys. The catalogue splits by feature because that
 * is how a school buys; the screens are grouped by the conversation somebody
 * actually has — one about joining and leaving, one about the records an
 * inspection asks for, one about welfare, one about leave rules. Fifteen
 * separate screens would each show a fifteenth of an answer.
 */
export const hrLifecycleKeys = {
}
