# syntax=docker/dockerfile:1
#
# One image for the whole ERP on Cloud Run (asia-south1): the three Go binaries
# and the built SPA, in a distroless base with nothing else in it.
#
# Why one image and not three: web, worker and migrate are built from the same
# commit and must ship together -- a worker that predates the web's queue
# payloads, or a schema behind the binaries reading it, is precisely the
# mismatch build-on-server.sh exists to prevent. Building them once and
# choosing the process at deploy time keeps the guarantee.
#
#   docker build -f deploy/cloudrun/Dockerfile --build-arg COMMIT=$(git rev-parse --short HEAD) -t erp .
#
# The image's default command is the web server. The other two run from the
# same image with the command overridden:
#
#   web       (Cloud Run service)   ENTRYPOINT as is; set WEB_DIST=/app/web so
#                                   the binary serves the SPA itself -- there is
#                                   no nginx here. PORT is honoured automatically.
#   worker    (Cloud Run worker pool / always-on service)
#                                   --command=/app/worker
#   migrate   (Cloud Run job, before each web/worker rollout)
#                                   --command=/app/migrate --args=up
#                                   then                    --args=seed
#
# Build context is the repository root, not this directory: the SPA lives in
# web/ and the Go module at the top, and .dockerignore at the root keeps
# node_modules, mobile/ and the rest out of the upload.

# ---- SPA -------------------------------------------------------------------
# npm ci rather than install: the lockfile is what was tested. The bundle is
# built before Go so a TypeScript error fails fast, before the longer compile.
FROM node:20-alpine AS spa
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- Go --------------------------------------------------------------------
# Static binaries: CGO off, so nothing in the final image needs libc, and the
# same -trimpath/-ldflags as build-on-server.sh so the two builds are
# byte-for-byte the same code. COMMIT is stamped into main.version, which the
# binaries print and log; "dev" means somebody built without passing it.
FROM golang:1.25-alpine AS build
ARG COMMIT=dev
WORKDIR /src
# Modules first, on their own layer: go.mod changes far less often than the
# source, so a code change does not re-download the dependency set.
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${COMMIT}" -o /out/web     ./cmd/web \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${COMMIT}" -o /out/worker  ./cmd/worker \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${COMMIT}" -o /out/migrate ./cmd/migrate

# ---- Runtime ---------------------------------------------------------------
# distroless/static: CA certificates and a timezone database (the worker's cron
# runs in Asia/Kolkata) and nothing else -- no shell, no package manager, so
# there is nothing on the image to exploit and nothing to patch. The nonroot
# tag runs as uid 65532, which is fine: the binaries write only to what the
# environment points them at.
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/web /out/worker /out/migrate /app/
COPY --from=spa /src/web/dist /app/web
# Nothing else is copied on purpose: migrations, templates and /static/ are
# embedded in the binaries (migrations.FS, templates.Parse, static.FS), so the
# migrate job needs no files beside it.
ENV WEB_DIST=/app/web
# Cloud Run sets PORT itself and the config honours it; 8080 is its default and
# is what a local `docker run -p 8080:8080` reaches.
EXPOSE 8080
ENTRYPOINT ["/app/web"]
