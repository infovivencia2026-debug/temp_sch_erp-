package tenancy

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/school-erp/erp/internal/audit"
	"github.com/school-erp/erp/pkg/httpx"
	"github.com/school-erp/erp/pkg/rbac"
)

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler { return &Handler{svc: svc} }

// Register mounts the routes. Every one declares its permission here, next to
// the path, so an unprotected route is visible in review — and the route
// coverage test fails the build if one slips through anyway.
func (h *Handler) Register(r *gin.RouterGroup) {
	schools := r.Group("/schools")
	{
		schools.GET("", httpx.RequirePermission(rbac.SchoolRead), h.list)
		schools.POST("", httpx.RequirePermission(rbac.SchoolCreate), h.create)
		schools.GET("/:id", httpx.RequirePermission(rbac.SchoolRead), h.get)
		schools.PATCH("/:id", httpx.RequirePermission(rbac.SchoolUpdate), h.update)
		schools.DELETE("/:id", httpx.RequirePermission(rbac.SchoolArchive), h.archive)
	}
}

func (h *Handler) list(c *gin.Context) {
	limit, _ := httpx.Pagination(c, 50, 200)
	schools, total, err := h.svc.List(c.Request.Context(), httpx.CurrentActor(c), ListInput{
		Search:          c.Query("search"),
		IncludeArchived: c.Query("include_archived") == "true",
		Limit:           limit,
	})
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.List(c, schools, httpx.Page{Limit: limit, Total: total})
}

func (h *Handler) get(c *gin.Context) {
	id, err := pathUUID(c, "id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	school, err := h.svc.Get(c.Request.Context(), httpx.CurrentActor(c), id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, school)
}

func (h *Handler) create(c *gin.Context) {
	var in CreateInput
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, httpx.BadRequest("MALFORMED_JSON", "The request body could not be read."))
		return
	}
	school, err := h.svc.Create(c.Request.Context(), httpx.CurrentActor(c), auditMeta(c), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, school)
}

func (h *Handler) update(c *gin.Context) {
	id, err := pathUUID(c, "id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in UpdateInput
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, httpx.BadRequest("MALFORMED_JSON", "The request body could not be read."))
		return
	}
	school, err := h.svc.Update(c.Request.Context(), httpx.CurrentActor(c), auditMeta(c), id, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, school)
}

func (h *Handler) archive(c *gin.Context) {
	id, err := pathUUID(c, "id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body)

	if err := h.svc.Archive(c.Request.Context(), httpx.CurrentActor(c), auditMeta(c), id, body.Reason); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

func pathUUID(c *gin.Context, name string) (uuid.UUID, error) {
	id, err := uuid.Parse(c.Param(name))
	if err != nil {
		return uuid.Nil, httpx.BadRequest("INVALID_ID", "That identifier is not valid.")
	}
	return id, nil
}

// auditMeta captures the who and the where once per request so services only
// have to describe the what.
func auditMeta(c *gin.Context) audit.Entry {
	return audit.FromActor(httpx.CurrentActor(c), httpx.RequestID(c),
		c.ClientIP(), c.Request.UserAgent())
}
