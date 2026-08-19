/* The parent community forum, keyed by catalogue entry.

   The key below was checked against internal/catalog/catalog_gen.go before it
   was written:

     parent.messages.parent_community_discussion_forum
       Scope("children"), Tier("optional")
       "Participate in moderated class-level parent forums for event
        coordination."

   A key the catalogue does not carry renders the honest "catalogued, not
   implemented" placeholder instead of the screen, and the screen is then
   unreachable without a single error to say why.

   Merged into FEATURE_COMPONENTS in web/src/features/registry.ts, which this
   agent does not own; the integration lead splices it in beside familyKeys and
   parentKeys and runs `make catalog` so internal/api/implemented_gen.go agrees
   with it.

   ONE key, deliberately, and no second entry for the moderator's view. The
   moderation queue, the report list, the settings and the conversion route all
   exist on the server under the same /portal/parent-forum prefix and are gated
   on comms.announcements.write, but they are a staff screen and a staff screen
   belongs to a staff catalogue entry. Registering the parent's component under
   a second parent key so that "moderation" appears in a parent's menu is the
   mistake Reminders and My day made before they were split: two menu entries
   opening the same screen is how a family concludes the app is broken.

   The screen is class-scoped and says so on its face. A parent reads the
   boards of the classes their own children are enrolled in; the server
   computes that list per request from active enrolments and refuses any
   section id the client names outside it. */
/* The forum was removed from the parent catalogue: a school portal had five
   separate places a parent could write to somebody, and the request was for
   one. The server routes under /portal/parent-forum are untouched, so the
   feature can be restored by putting its catalogue row back. */
export const forumKeys = {}
