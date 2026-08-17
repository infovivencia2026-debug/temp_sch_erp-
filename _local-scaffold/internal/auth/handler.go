package auth

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/school-erp/erp/pkg/auth"
	"github.com/school-erp/erp/pkg/httpx"
)

type Handler struct {
	svc      *Service
	sessions *auth.SessionStore
	ttl      time.Duration
	secure   bool
}

func NewHandler(svc *Service, sessions *auth.SessionStore, ttl time.Duration, secure bool) *Handler {
	return &Handler{svc: svc, sessions: sessions, ttl: ttl, secure: secure}
}

func (h *Handler) Register(r *gin.RouterGroup, authenticated gin.HandlerFunc) {
	r.POST("/auth/login", h.login)
	r.POST("/auth/logout", authenticated, h.logout)
	r.GET("/auth/session", authenticated, h.session)
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// sessionResponse is what the frontend needs to render permission-aware UI. The
// permission list here is a convenience for the client; it is never what the
// server trusts.
type sessionResponse struct {
	User struct {
		ID       string `json:"id"`
		FullName string `json:"full_name"`
		Email    string `json:"email"`
	} `json:"user"`
	OrganizationID string   `json:"organization_id"`
	Roles          []string `json:"roles"`
	Schools        []string `json:"schools"`
	Permissions    []string `json:"permissions"`
}

func (h *Handler) login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, httpx.BadRequest("MALFORMED_JSON", "The request body could not be read."))
		return
	}

	result, err := h.svc.Login(c.Request.Context(), LoginInput{
		Email:     req.Email,
		Password:  req.Password,
		IP:        c.ClientIP(),
		UserAgent: c.Request.UserAgent(),
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}

	h.setSessionCookie(c, result.Token)
	httpx.OK(c, buildSessionResponse(result.Actor))
}

func (h *Handler) logout(c *gin.Context) {
	token, _ := c.Cookie(auth.CookieName(h.secure))
	if err := h.svc.Logout(c.Request.Context(), token, httpx.CurrentActor(c)); err != nil {
		httpx.Fail(c, err)
		return
	}
	h.clearSessionCookie(c)
	httpx.NoContent(c)
}

func (h *Handler) session(c *gin.Context) {
	httpx.OK(c, buildSessionResponse(httpx.CurrentActor(c)))
}

// Authenticate resolves the session cookie into an actor. It reloads permissions
// from the database on every request, so a revoked role stops working
// immediately rather than at the next login.
func (h *Handler) Authenticate() gin.HandlerFunc {
	return func(c *gin.Context) {
		token, err := c.Cookie(auth.CookieName(h.secure))
		if err != nil || token == "" {
			httpx.Fail(c, httpx.ErrUnauthenticated)
			return
		}

		sess, err := h.sessions.Get(c.Request.Context(), token)
		if err != nil {
			if errors.Is(err, auth.ErrSessionNotFound) {
				h.clearSessionCookie(c)
				httpx.Fail(c, httpx.ErrSessionExpired)
				return
			}
			httpx.Fail(c, httpx.Internal(err))
			return
		}

		actor, err := h.svc.ResolveActor(c.Request.Context(), sess)
		if err != nil {
			httpx.Fail(c, err)
			return
		}

		// An active session's life extends on use; an idle one still expires.
		_ = h.sessions.Touch(c.Request.Context(), token)

		httpx.SetActor(c, actor)
		c.Next()
	}
}

func (h *Handler) setSessionCookie(c *gin.Context, token string) {
	// In production the cookie carries the __Host- prefix, which the browser
	// enforces: Secure, Path=/, no Domain — so no subdomain can overwrite the
	// session. Over plain HTTP a browser *rejects* a __Host- cookie outright
	// rather than ignoring the prefix, which is why development uses the plain
	// name and why staging must be HTTPS to exercise the real path.
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     auth.CookieName(h.secure),
		Value:    token,
		Path:     "/",
		MaxAge:   int(h.ttl.Seconds()),
		HttpOnly: true,
		Secure:   h.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handler) clearSessionCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     auth.CookieName(h.secure),
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func buildSessionResponse(a *httpx.Actor) sessionResponse {
	var resp sessionResponse
	if a == nil {
		return resp
	}
	resp.User.ID = a.UserID.String()
	resp.User.FullName = a.FullName
	resp.User.Email = a.Email
	resp.OrganizationID = a.OrganizationID.String()
	resp.Roles = a.Roles
	resp.Permissions = a.Permissions()
	resp.Schools = make([]string, 0, len(a.SchoolAccess))
	for _, id := range a.SchoolAccess {
		resp.Schools = append(resp.Schools, id.String())
	}
	return resp
}
