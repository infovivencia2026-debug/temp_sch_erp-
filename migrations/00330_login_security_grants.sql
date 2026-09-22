-- +goose Up
/* The grants 00324 and 00328 forgot.

   Tables are created by erp_owner and read by app_user, and the default
   privileges only cover tables the owner role creates in the baseline's
   session. Without these, the first sign-in after the deploy died on
   "permission denied for table session_policies", which is the worst
   possible place for a missing grant. */
GRANT SELECT, INSERT, UPDATE, DELETE ON session_screens   TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON login_events      TO app_user;
GRANT USAGE, SELECT ON SEQUENCE login_events_id_seq       TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON login_throttle    TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON session_policies  TO app_user;

-- +goose Down
REVOKE ALL ON session_policies  FROM app_user;
REVOKE ALL ON login_throttle    FROM app_user;
REVOKE ALL ON SEQUENCE login_events_id_seq FROM app_user;
REVOKE ALL ON login_events      FROM app_user;
REVOKE ALL ON session_screens   FROM app_user;
