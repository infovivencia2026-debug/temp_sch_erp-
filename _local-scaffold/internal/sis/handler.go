package sis

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/school-erp/erp/internal/audit"
	"github.com/school-erp/erp/pkg/httpx"
	"github.com/school-erp/erp/pkg/rbac"
)

type Handler struct {
	students  *StudentService
	guardians *GuardianService
	academics *AcademicsService
}

func NewHandler(students *StudentService, guardians *GuardianService, academics *AcademicsService) *Handler {
	return &Handler{students: students, guardians: guardians, academics: academics}
}

func (h *Handler) Register(r *gin.RouterGroup) {
	students := r.Group("/students")
	{
		students.GET("", httpx.RequirePermission(rbac.StudentRead), h.listStudents)
		students.POST("", httpx.RequirePermission(rbac.StudentCreate), h.createStudent)
		students.GET("/:id", httpx.RequirePermission(rbac.StudentRead), h.getStudent)
		students.PATCH("/:id", httpx.RequirePermission(rbac.StudentUpdate), h.updateStudent)

		students.GET("/:id/guardians", httpx.RequirePermission(rbac.GuardianRead), h.listGuardians)
		students.POST("/:id/guardians", httpx.RequirePermission(rbac.GuardianLink), h.linkGuardian)
		students.POST("/:id/enrollment", httpx.RequirePermission(rbac.EnrollmentManage), h.enrol)
	}

	r.POST("/guardians", httpx.RequirePermission(rbac.GuardianManage), h.createGuardian)
	r.GET("/grades", httpx.RequirePermission(rbac.GradeRead), h.listGrades)
	r.GET("/sections", httpx.RequirePermission(rbac.SectionRead), h.listSections)
	r.POST("/sections", httpx.RequirePermission(rbac.SectionManage), h.createSection)
	r.PUT("/sections/:id/class-teacher", httpx.RequirePermission(rbac.AllocationManage), h.assignClassTeacher)
}

// ------------------------------------------------------------- students ----

func (h *Handler) listStudents(c *gin.Context) {
	limit, _ := httpx.Pagination(c, 50, 200)

	in := ListStudentsInput{
		Search: c.Query("search"),
		Status: c.Query("status"),
		Limit:  limit,
	}
	for _, spec := range []struct {
		query string
		dest  **uuid.UUID
	}{
		{"section_id", &in.SectionID},
		{"grade_id", &in.GradeID},
		{"school_id", &in.SchoolID},
	} {
		if raw := c.Query(spec.query); raw != "" {
			id, err := uuid.Parse(raw)
			if err != nil {
				httpx.Fail(c, httpx.BadRequest("INVALID_ID", "That identifier is not valid."))
				return
			}
			*spec.dest = &id
		}
	}

	students, total, err := h.students.List(c.Request.Context(), httpx.CurrentActor(c), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.List(c, students, httpx.Page{Limit: limit, Total: total})
}

func (h *Handler) getStudent(c *gin.Context) {
	id, err := pathUUID(c, "id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	student, err := h.students.Get(c.Request.Context(), httpx.CurrentActor(c), id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, student)
}

func (h *Handler) createStudent(c *gin.Context) {
	var in CreateStudentInput
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, httpx.BadRequest("MALFORMED_JSON", "The request body could not be read."))
		return
	}
	student, err := h.students.Create(c.Request.Context(), httpx.CurrentActor(c), auditMeta(c), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, student)
}

func (h *Handler) updateStudent(c *gin.Context) {
	id, err := pathUUID(c, "id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in UpdateStudentInput
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, httpx.BadRequest("MALFORMED_JSON", "The request body could not be read."))
		return
	}
	student, err := h.students.Update(c.Request.Context(), httpx.CurrentActor(c), auditMeta(c), id, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, student)
}

func (h *Handler) enrol(c *gin.Context) {
	id, err := pathUUID(c, "id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in EnrolInput
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, httpx.BadRequest("MALFORMED_JSON", "The request body could not be read."))
		return
	}
	placement, err := h.students.Enrol(c.Request.Context(), httpx.CurrentActor(c), auditMeta(c), id, in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, placement)
}

// ------------------------------------------------------------ guardians ----

func (h *Handler) listGuardians(c *gin.Context) {
	id, err := pathUUID(c, "id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	guardians, err := h.guardians.ListForStudent(c.Request.Context(), httpx.CurrentActor(c), id)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, guardians)
}

func (h *Handler) createGuardian(c *gin.Context) {
	var in CreateGuardianInput
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, httpx.BadRequest("MALFORMED_JSON", "The request body could not be read."))
		return
	}
	guardian, err := h.guardians.Create(c.Request.Context(), httpx.CurrentActor(c), auditMeta(c), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, guardian)
}

func (h *Handler) linkGuardian(c *gin.Context) {
	id, err := pathUUID(c, "id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var in LinkGuardianInput
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, httpx.BadRequest("MALFORMED_JSON", "The request body could not be read."))
		return
	}
	if err := h.guardians.Link(c.Request.Context(), httpx.CurrentActor(c), auditMeta(c), id, in); err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.NoContent(c)
}

// ------------------------------------------------------------ academics ----

func (h *Handler) listGrades(c *gin.Context) {
	var schoolID *uuid.UUID
	if raw := c.Query("school_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			httpx.Fail(c, httpx.BadRequest("INVALID_ID", "That identifier is not valid."))
			return
		}
		schoolID = &id
	}
	grades, err := h.academics.ListGrades(c.Request.Context(), httpx.CurrentActor(c), schoolID)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, grades)
}

func (h *Handler) listSections(c *gin.Context) {
	var in ListSectionsInput
	for _, spec := range []struct {
		query string
		dest  **uuid.UUID
	}{
		{"school_id", &in.SchoolID},
		{"grade_id", &in.GradeID},
		{"academic_year_id", &in.AcademicYearID},
	} {
		if raw := c.Query(spec.query); raw != "" {
			id, err := uuid.Parse(raw)
			if err != nil {
				httpx.Fail(c, httpx.BadRequest("INVALID_ID", "That identifier is not valid."))
				return
			}
			*spec.dest = &id
		}
	}
	sections, err := h.academics.ListSections(c.Request.Context(), httpx.CurrentActor(c), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.OK(c, sections)
}

func (h *Handler) createSection(c *gin.Context) {
	var in CreateSectionInput
	if err := c.ShouldBindJSON(&in); err != nil {
		httpx.Fail(c, httpx.BadRequest("MALFORMED_JSON", "The request body could not be read."))
		return
	}
	section, err := h.academics.CreateSection(c.Request.Context(), httpx.CurrentActor(c), auditMeta(c), in)
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	httpx.Created(c, section)
}

func (h *Handler) assignClassTeacher(c *gin.Context) {
	id, err := pathUUID(c, "id")
	if err != nil {
		httpx.Fail(c, err)
		return
	}
	var body struct {
		UserID uuid.UUID `json:"user_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.UserID == uuid.Nil {
		httpx.Fail(c, httpx.ErrValidation.WithDetails(map[string]any{
			"fields": map[string]any{"user_id": "Choose the teacher to assign."}}))
		return
	}
	if err := h.academics.AssignClassTeacher(c.Request.Context(), httpx.CurrentActor(c),
		auditMeta(c), id, body.UserID); err != nil {
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

func auditMeta(c *gin.Context) audit.Entry {
	return audit.FromActor(httpx.CurrentActor(c), httpx.RequestID(c),
		c.ClientIP(), c.Request.UserAgent())
}
