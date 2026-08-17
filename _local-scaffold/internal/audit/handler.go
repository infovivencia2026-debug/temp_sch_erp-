package audit

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/school-erp/erp/pkg/httpx"
	"github.com/school-erp/erp/pkg/rbac"
)

type Handler struct {
	reader *Reader
}

func NewHandler(reader *Reader) *Handler { return &Handler{reader: reader} }

func (h *Handler) Register(r *gin.RouterGroup) {
	r.GET("/audit-logs", httpx.RequirePermission(rbac.AuditRead), h.list)
}

func (h *Handler) list(c *gin.Context) {
	limit, _ := httpx.Pagination(c, 50, 200)

	f := ListFilter{
		EntityKind: c.Query("entity_kind"),
		Action:     c.Query("action"),
		Limit:      limit,
	}
	if raw := c.Query("entity_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			httpx.Fail(c, httpx.BadRequest("INVALID_ID", "That identifier is not valid."))
			return
		}
		f.EntityID = &id
	}
	if raw := c.Query("actor_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			httpx.Fail(c, httpx.BadRequest("INVALID_ID", "That identifier is not valid."))
			return
		}
		f.ActorID = &id
	}

	records, err := h.reader.List(c.Request.Context(), httpx.CurrentActor(c), f)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.List(c, records, httpx.Page{Limit: limit, Total: int64(len(records))})
}
