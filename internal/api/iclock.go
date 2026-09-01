package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/school-erp/erp/internal/httpx"
)

/* The fingerprint reader, talking to us.

   This is ADMS — the protocol a ZK reader speaks when it is configured with a
   server address instead of being polled on port 4370. The device is the
   client: it dials out on a schedule it keeps itself, so nothing has to run at
   the school and nothing has to be reachable through the school's router.

   Everything unusual about this file follows from the device being a
   nineteen-year-old embedded HTTP client:

     It cannot authenticate. No header, no token, no certificate — it sends a
     serial number in a query string and nothing else. The serial IS the
     credential, which is why these endpoints are mounted outside the API's
     session middleware and why they are written to give nothing away. A
     forged serial that happens to be right can post attendance rows; it can
     never read a name, a number, a roll or even a confirmation that the
     school exists.

     It does not speak JSON. Requests are tab-separated lines in a bare body;
     replies are plain text in a shape the firmware parses by position. "OK"
     means something specific and so does "OK: 12"; neither may be dressed up.

     It re-sends. A reader that loses its connection mid-upload replays the
     batch, and one whose clock is wrong replays yesterday. Nothing here may
     assume it sees a punch once.

     It must never see a 500. A ZK device treats an unparseable reply as a
     failed upload and retries the same batch forever, which is how one
     misconfigured reader turns into a request per second until somebody
     unplugs it. Every path below answers 200 with a body the firmware
     understands, including the paths where we are refusing it.
*/

// mountDeviceProtocol hangs the ADMS endpoints off the root router.
//
// Deliberately not under /api/v1: everything there requires a session, and the
// whole point of this is a client that has none.
// MountDeviceProtocol is called from the root router, not from Routes().
func (s *Server) MountDeviceProtocol(r chi.Router) {
	r.Get("/iclock/cdata", s.deviceHandshake)
	r.Post("/iclock/cdata", s.devicePush)
	r.Get("/iclock/getrequest", s.deviceCommands)
	r.Post("/iclock/devicecmd", s.deviceCommandResult)
	// Some firmware asks with a trailing slash, some without, and a 404 is a
	// retry loop rather than an error message.
	r.Get("/iclock/ping", s.devicePing)
}

// text answers the device in the only dialect it understands.
//
// Always 200. A ZK reader treats any other status, and any body it cannot
// parse, as a failed upload and replays the batch — forever, on a timer, until
// somebody walks over and unplugs it.
func text(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
}

// deviceOf resolves a serial to a registered, active device.
//
// Returns institution and device id, or false. The caller must answer the same
// way whether the serial is unknown, inactive or malformed: a device that is
// told "no such serial" is a device that can be used to enumerate serials.
func (s *Server) deviceOf(r *http.Request) (instID, devID string, ok bool) {
	sn := strings.TrimSpace(r.URL.Query().Get("SN"))
	if sn == "" || len(sn) > 64 {
		return "", "", false
	}
	// Read as platform, because there is no session to scope by and the serial
	// is what decides the tenant. This is the one query in the product that
	// legitimately crosses institutions, and it returns nothing but two ids.
	err := s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			SELECT institution_id::text, id::text
			  FROM biometric_devices
			 WHERE serial = $1 AND is_active`, sn).Scan(&instID, &devID)
	})
	if err != nil {
		return "", "", false
	}
	return instID, devID, true
}

/*
deviceHandshake answers the device's opening GET with its operating parameters.

	The reply is positional and the firmware is unforgiving about it. Stamp is
	the watermark the device sends back on its next upload; answering 0 asks
	for everything it holds, which is what a newly attached reader should give
	us. Realtime=1 is the setting that makes this live: with it the device
	pushes each punch as it happens rather than batching to TransTimes.
*/
func (s *Server) deviceHandshake(w http.ResponseWriter, r *http.Request) {
	sn := strings.TrimSpace(r.URL.Query().Get("SN"))
	instID, devID, ok := s.deviceOf(r)
	if !ok {
		/* An unregistered reader is told to go quiet, not told it is wrong.

		   ErrorDelay is the firmware's own backoff. Sending a large one turns
		   a device somebody pointed here by mistake — or on purpose — into a
		   request every ten minutes rather than one every ten seconds, without
		   revealing whether the serial means anything. */
		text(w, "GET OPTION FROM: "+sn+"\r\nErrorDelay=600\r\nDelay=600\r\n")
		return
	}

	_ = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(),
			`UPDATE biometric_devices SET last_seen_at = now() WHERE id = $1`, devID)
		return err
	})
	_ = instID

	text(w, strings.Join([]string{
		"GET OPTION FROM: " + sn,
		// Zero: send everything you have. The punch table is idempotent on
		// content, so a full replay costs nothing and a missed day costs a
		// payroll query nobody can answer.
		"Stamp=0",
		"OpStamp=0",
		"ErrorDelay=30",
		"Delay=10",
		"TransTimes=00:00;12:00",
		"TransInterval=1",
		"TransFlag=1111000000",
		// The whole reason for choosing push: each punch arrives as it
		// happens, so "who is in today" is answerable at any moment rather
		// than after the evening batch.
		"Realtime=1",
		"Encrypt=0",
		"TimeZone=5.5",
	}, "\r\n")+"\r\n")
}

/*
devicePush takes a batch of records and answers with how many it accepted.

	"OK: n" is the contract. The firmware reads the number and advances its own
	watermark by it, so undercounting makes it re-send and overcounting makes
	it skip. Rows we cannot use — an unknown device user, an unparseable
	timestamp — are counted as accepted deliberately: they are stored raw and
	they are the school's problem to resolve, not the device's to retry.
*/
func (s *Server) devicePush(w http.ResponseWriter, r *http.Request) {
	instID, devID, ok := s.deviceOf(r)
	if !ok {
		// Accepted and discarded. Refusing makes it retry; this makes it move
		// on, and tells it nothing.
		text(w, "OK: 0")
		return
	}
	table := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("table")))

	// 2 MB is thousands of punches. A reader that sends more than that is not
	// a reader.
	body := make([]byte, 0, 4096)
	buf := make([]byte, 32*1024)
	for len(body) < 2<<20 {
		n, err := r.Body.Read(buf)
		body = append(body, buf[:n]...)
		if err != nil {
			break
		}
	}

	if table != "ATTLOG" && table != "" {
		// OPERLOG, USERINFO and the rest are acknowledged and dropped. Storing
		// them without knowing what a school would do with them is how a table
		// grows for two years and is read by nothing.
		_ = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(),
				`UPDATE biometric_devices SET last_seen_at = now() WHERE id = $1`, devID)
			return err
		})
		text(w, "OK: "+strconv.Itoa(len(strings.Fields(string(body)))))
		return
	}

	accepted := 0
	_ = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		for _, line := range strings.Split(string(body), "\n") {
			line = strings.TrimRight(line, "\r")
			if strings.TrimSpace(line) == "" {
				continue
			}
			accepted++

			/* user, time, status, verify, workcode ...

			   Tab-separated in the specification and space-separated in some
			   firmware, and the timestamp contains a space of its own, so the
			   fields cannot simply be split on whitespace. Tabs first; falling
			   back to reading the first token as the id and the next nineteen
			   characters as the timestamp, which is the shape every ZK model
			   agrees on. */
			cols := strings.Split(line, "\t")
			if len(cols) < 2 {
				cols = splitLoose(line)
			}
			if len(cols) < 2 {
				continue
			}
			uid, err := strconv.Atoi(strings.TrimSpace(cols[0]))
			if err != nil || uid <= 0 {
				continue
			}
			at, err := parsePunchTime(strings.TrimSpace(cols[1]))
			if err != nil {
				continue
			}
			statusCode, verify := 0, 0
			if len(cols) > 2 {
				statusCode, _ = strconv.Atoi(strings.TrimSpace(cols[2]))
			}
			if len(cols) > 3 {
				verify, _ = strconv.Atoi(strings.TrimSpace(cols[3]))
			}

			/* Resolved here, and kept even when it resolves to nobody.

			   A punch from an id no employee claims is not noise: it is how a
			   school finds out somebody enrolled a finger at the machine
			   without telling the office. Dropping it would hide exactly the
			   thing worth seeing. */
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO biometric_punches
				    (institution_id, device_id, device_user_id, employee_id,
				     punched_at, status_code, verify_mode, raw)
				VALUES ($1::uuid, $2::uuid, $3,
				        (SELECT id FROM employees
				          WHERE institution_id = $1::uuid AND device_user_id = $3),
				        $4, $5, $6, $7)
				ON CONFLICT (device_id, device_user_id, punched_at) DO NOTHING`,
				instID, devID, uid, at, statusCode, verify, line); err != nil {
				return err
			}
		}
		_, err := tx.Exec(r.Context(),
			`UPDATE biometric_devices SET last_seen_at = now(), last_push_at = now()
			  WHERE id = $1`, devID)
		return err
	})

	// Rolling the day up here rather than on a timer, so the register is
	// correct the moment the punch lands, which is what "live" was asked for.
	s.rollUpPunches(r, instID)

	text(w, fmt.Sprintf("OK: %d", accepted))
}

// splitLoose reads "1042 2026-09-01 09:14:02 0 1" — the space-separated
// variant, where the timestamp itself contains a space.
func splitLoose(line string) []string {
	f := strings.Fields(line)
	if len(f) < 3 {
		return nil
	}
	out := []string{f[0], f[1] + " " + f[2]}
	return append(out, f[3:]...)
}

// parsePunchTime accepts the three shapes ZK firmware sends.
func parsePunchTime(v string) (time.Time, error) {
	loc := indiaTZ()
	for _, layout := range []string{
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04",
	} {
		if t, err := time.ParseInLocation(layout, v, loc); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognised punch time %q", v)
}

/*
rollUpPunches turns punches into a day's attendance.

	First punch of the day is the arrival, last is the departure. That is the
	whole rule, and it is deliberately the whole rule: a reader by one door
	records a teacher stepping out for lunch as two more punches, and any
	cleverer pairing would turn that into a half day. Earliest and latest is
	the reading a school can check against its own eyes.

	Only rows this device wrote are touched. A day HR corrected by hand keeps
	the correction — source tells them apart, and a machine must not overwrite
	a person's judgement about a person.
*/
func (s *Server) rollUpPunches(r *http.Request, instID string) {
	_ = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `
			WITH days AS (
			  SELECT p.employee_id,
			         (p.punched_at AT TIME ZONE 'Asia/Kolkata')::date AS on_date,
			         min(p.punched_at) AS first_seen,
			         max(p.punched_at) AS last_seen
			    FROM biometric_punches p
			   WHERE p.institution_id = $1::uuid
			     AND p.employee_id IS NOT NULL
			     AND p.punched_at >= now() - interval '7 days'
			   GROUP BY 1, 2
			)
			INSERT INTO staff_attendance
			    (institution_id, user_id, on_date, status, check_in, check_out,
			     source, device_ref)
			SELECT $1::uuid, e.user_id, d.on_date, 'present',
			       d.first_seen,
			       -- One punch is an arrival, not a nought-hour day. Leaving
			       -- check_out null says "still in, or never punched out",
			       -- which is true; stamping it equal to check_in would say
			       -- they left the moment they came, which is not.
			       CASE WHEN d.last_seen > d.first_seen THEN d.last_seen END,
			       'biometric', 'device'
			  FROM days d
			  JOIN employees e ON e.id = d.employee_id AND e.user_id IS NOT NULL
			ON CONFLICT (user_id, on_date) DO UPDATE
			   SET check_in  = LEAST(staff_attendance.check_in, EXCLUDED.check_in),
			       check_out = GREATEST(staff_attendance.check_out, EXCLUDED.check_out),
			       status    = 'present'
			 WHERE staff_attendance.source = 'biometric'`, instID)
		return err
	})
}

/*
deviceCommands answers the device's poll for work.

	Nothing is queued yet — enrolling a user or setting the clock from here is
	a later job — so this is a bare OK. It exists because the firmware polls
	whether or not there is anything to say, and a 404 is a retry loop.
*/
func (s *Server) deviceCommands(w http.ResponseWriter, r *http.Request) {
	if _, devID, ok := s.deviceOf(r); ok {
		_ = s.DB.AsPlatform(r.Context(), func(tx pgx.Tx) error {
			_, err := tx.Exec(r.Context(),
				`UPDATE biometric_devices SET last_seen_at = now() WHERE id = $1`, devID)
			return err
		})
	}
	text(w, "OK")
}

// deviceCommandResult acknowledges a command reply. Nothing issues commands
// yet, so there is nothing to record; the endpoint exists so the firmware is
// never left retrying against a 404.
func (s *Server) deviceCommandResult(w http.ResponseWriter, r *http.Request) {
	text(w, "OK")
}

// devicePing is what an installer curls to check the address is right.
// It says nothing about whether the serial is known.
func (s *Server) devicePing(w http.ResponseWriter, r *http.Request) {
	text(w, "OK")
}

/* Registering a reader, from inside the school.

   A device is registered before it is trusted: is_active starts false, so a
   serial typed wrong does not quietly begin accepting somebody else's punches
   while nobody is watching. Turning it on is a second, deliberate press.
*/

type biometricDevice struct {
	ID         string  `json:"id"`
	Serial     string  `json:"serial"`
	Name       string  `json:"name"`
	IsActive   bool    `json:"is_active"`
	LastSeenAt *string `json:"last_seen_at,omitempty"`
	LastPushAt *string `json:"last_push_at,omitempty"`
	Note       *string `json:"note,omitempty"`
	// What the school actually asks: is it still talking to us, and is anybody
	// coming through it.
	PunchesToday int `json:"punches_today"`
	Unresolved   int `json:"unresolved"`
}

func (s *Server) listBiometricDevices(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT d.id::text, d.serial, d.name, d.is_active,
		       to_char(d.last_seen_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       to_char(d.last_push_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
		       d.note,
		       (SELECT count(*)::int FROM biometric_punches p
		         WHERE p.device_id = d.id
		           AND (p.punched_at AT TIME ZONE 'Asia/Kolkata')::date = CURRENT_DATE),
		       -- Punches from an id no employee claims. This is how a school
		       -- finds out somebody enrolled a finger without telling the
		       -- office, so it is on the device card rather than in a report.
		       (SELECT count(DISTINCT p.device_user_id)::int FROM biometric_punches p
		         WHERE p.device_id = d.id AND p.employee_id IS NULL)
		  FROM biometric_devices d
		 ORDER BY d.name`,
		nil,
		func(rows pgx.Rows) (biometricDevice, error) {
			var v biometricDevice
			return v, rows.Scan(&v.ID, &v.Serial, &v.Name, &v.IsActive,
				&v.LastSeenAt, &v.LastPushAt, &v.Note, &v.PunchesToday, &v.Unresolved)
		})
	respond(w, r, items, err)
}

type biometricDeviceRequest struct {
	Serial   string `json:"serial"`
	Name     string `json:"name"`
	IsActive *bool  `json:"is_active,omitempty"`
	Note     string `json:"note,omitempty"`
}

func (s *Server) saveBiometricDevice(w http.ResponseWriter, r *http.Request) {
	id := httpx.IdentityFrom(r.Context())
	var req biometricDeviceRequest
	if !httpx.Decode(w, r, &req) {
		return
	}
	req.Serial = strings.TrimSpace(req.Serial)
	req.Name = strings.TrimSpace(req.Name)
	if req.Serial == "" || req.Name == "" {
		httpx.BadRequest(w, r,
			"a serial and a name — the serial is printed on the back of the reader and is what identifies it to us")
		return
	}

	var newID string
	err := s.DB.InTenant(r.Context(), tenantScope(id), func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `
			INSERT INTO biometric_devices (institution_id, serial, name, is_active, note)
			VALUES ($1, $2, $3, COALESCE($4, false), NULLIF($5,''))
			ON CONFLICT (serial) DO UPDATE
			   SET name = EXCLUDED.name,
			       is_active = COALESCE($4, biometric_devices.is_active),
			       note = COALESCE(EXCLUDED.note, biometric_devices.note)
			 WHERE biometric_devices.institution_id = $1
			RETURNING id::text`,
			id.InstitutionID, req.Serial, req.Name, req.IsActive, req.Note).Scan(&newID)
	})
	if err != nil {
		if err == pgx.ErrNoRows {
			// The ON CONFLICT ... WHERE matched nothing, which means the serial
			// belongs to another school. Said plainly: a serial is unique
			// across the platform because it is the only thing telling one
			// school's reader from another's.
			httpx.BadRequest(w, r,
				"that serial is already registered to another school. Check it against the label on the reader")
			return
		}
		httpx.Internal(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": newID,
		"note": "Set the reader's server address to this host, port 80 or 443, and leave the " +
			"path blank — it appends /iclock itself. Activate the device here once it appears as seen.",
	})
}

// listUnresolvedPunches names the device ids nobody claims, with how often and
// how recently, so the office can match them to people.
func (s *Server) listUnresolvedPunches(w http.ResponseWriter, r *http.Request) {
	items, err := collect(s, r, `
		SELECT p.device_user_id,
		       count(*)::int,
		       to_char(min(p.punched_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI'),
		       to_char(max(p.punched_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')
		  FROM biometric_punches p
		 WHERE p.employee_id IS NULL
		 GROUP BY 1 ORDER BY 2 DESC, 1`,
		nil,
		func(rows pgx.Rows) (map[string]any, error) {
			var uid, n int
			var first, last string
			if err := rows.Scan(&uid, &n, &first, &last); err != nil {
				return nil, err
			}
			return map[string]any{
				"device_user_id": uid, "punches": n,
				"first_seen": first, "last_seen": last,
			}, nil
		})
	respond(w, r, items, err)
}
