package httpx

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// Envelope shapes every successful response. Lists carry Page so a client never
// has to guess whether there is more.
type Envelope struct {
	Data any   `json:"data"`
	Page *Page `json:"page,omitempty"`
}

type Page struct {
	Limit      int    `json:"limit"`
	Total      int64  `json:"total"`
	NextCursor string `json:"next_cursor,omitempty"`
}

type errorBody struct {
	Error struct {
		Code      string         `json:"code"`
		Message   string         `json:"message"`
		Details   map[string]any `json:"details,omitempty"`
		RequestID string         `json:"request_id"`
	} `json:"error"`
}

func OK(c *gin.Context, data any)      { c.JSON(http.StatusOK, Envelope{Data: data}) }
func Created(c *gin.Context, data any) { c.JSON(http.StatusCreated, Envelope{Data: data}) }
func NoContent(c *gin.Context)         { c.Status(http.StatusNoContent) }

func List(c *gin.Context, data any, page Page) {
	c.JSON(http.StatusOK, Envelope{Data: data, Page: &page})
}

// Fail writes the error envelope and records the cause in the request log. It is
// the only place an error becomes a response, which is what keeps stack traces
// and driver messages off the wire.
func Fail(c *gin.Context, err error) {
	e := AsError(err)
	requestID := RequestID(c)

	logger := slog.With("request_id", requestID, "code", e.Code, "path", c.FullPath())
	switch {
	case e.Status >= 500:
		logger.Error("request failed", "error", e.Error())
	case e.Status == http.StatusForbidden || e.Status == http.StatusUnauthorized:
		// Authorization failures are a security signal, not noise: they are what
		// an alert on "auth failure spike" watches.
		logger.Warn("request denied", "error", e.Error(), "user_id", UserIDOrEmpty(c))
	default:
		logger.Info("request rejected", "error", e.Error())
	}

	var body errorBody
	body.Error.Code = e.Code
	body.Error.Message = e.Message
	body.Error.Details = e.Details
	body.Error.RequestID = requestID

	c.AbortWithStatusJSON(e.Status, body)
}

// Pagination reads limit and cursor with sane bounds. An unbounded list endpoint
// is a denial-of-service waiting for a school with 100,000 students.
func Pagination(c *gin.Context, defaultLimit, maxLimit int) (limit int, cursor string) {
	limit = defaultLimit
	if raw := c.Query("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	return limit, c.Query("cursor")
}
