-- +goose Up

/* A staff session could be written and never read back.

   device_staff_sessions carried the only tenant_isolation policy in this
   schema with no platform escape:

       USING (institution_id = app_current_institution())

   Every other table pairs that with app_is_platform_admin(), and for good
   reason. readStaffSession has to run as platform: it is handed a token and
   nothing else, and which school the session belongs to is the question it is
   answering, not something it can assert beforehand. Under a platform scope
   app_current_institution() is null, the row was invisible, the lookup
   returned no rows, and the middleware reported "sign in before starting a
   run" to a driver who had signed in seconds earlier.

   The effect was total: no staff session has ever been readable on this
   installation, so Start Run has never once succeeded for anybody, and
   vehicle_trips has no rows at all. It survived because the write path and
   the read path fail in opposite directions, and each looked correct on its
   own.

   Read only. The WITH CHECK is deliberately left alone: a platform scope must
   still not be able to mint a session into a school, which is the property
   the original policy was reaching for and the one worth keeping. Writers
   already run inside the tenant. */

DROP POLICY IF EXISTS device_staff_sessions_tenant ON device_staff_sessions;

CREATE POLICY device_staff_sessions_tenant ON device_staff_sessions
    USING (app_is_platform_admin() OR institution_id = app_current_institution())
    WITH CHECK (institution_id = app_current_institution());

-- +goose Down

DROP POLICY IF EXISTS device_staff_sessions_tenant ON device_staff_sessions;

CREATE POLICY device_staff_sessions_tenant ON device_staff_sessions
    USING (institution_id = app_current_institution())
    WITH CHECK (institution_id = app_current_institution());
