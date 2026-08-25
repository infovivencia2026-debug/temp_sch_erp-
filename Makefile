# School ERP — build, test, deploy.
#
# The server has 1 vCPU and very little free disk, so it carries no Go or Node
# toolchain: everything is cross-compiled here and uploaded. `make deploy` is
# the whole pipeline.

SHELL := /bin/bash
.DEFAULT_GOAL := help

HOST        ?= root@187.127.178.100
FQDN        ?= temperp.187-127-178-100.sslip.io
REMOTE_DIR  ?= /opt/temperp
SERVICE     ?= temperp
WEBROOT     ?= /var/www/temperp
APKDIR      ?= /var/lib/temperp/apk
DIST        := dist

# Static binaries: the target box should need no libc compatibility, and
# -trimpath keeps local paths out of the shipped artifact.
GOFLAGS := CGO_ENABLED=0 GOOS=linux GOARCH=amd64
LDFLAGS := -s -w

TEST_DATABASE_URL ?= postgres://app_user:devapp@127.0.0.1:5432/school_erp?sslmode=disable

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

## --- development ----------------------------------------------------------

.PHONY: dev
dev: ## Run web + worker locally (Ctrl-C stops both)
	@trap 'kill 0' EXIT INT TERM; \
	go run ./cmd/web & go run ./cmd/worker & wait

.PHONY: web worker
web: ## Run just the web server
	go run ./cmd/web
worker: ## Run just the worker
	go run ./cmd/worker

.PHONY: ui
ui: ## Run the Vite dev server (proxies /api to :8090)
	cd web && npm run dev

.PHONY: migrate seed admin
migrate: ## Apply pending migrations
	go run ./cmd/migrate up
seed: ## Upsert permissions and system roles
	go run ./cmd/migrate seed
admin: ## Create an admin: make admin EMAIL=.. PASSWORD=.. [INSTITUTION=..]
	go run ./cmd/migrate create-admin -email "$(EMAIL)" -password "$(PASSWORD)" \
		$(if $(INSTITUTION),-institution "$(INSTITUTION)")

.PHONY: catalog docs demo matrix
catalog: ## Regenerate the feature catalog + implemented list from the CSV and registry
	python3 scripts/gen_catalog.py
	python3 scripts/gen_implemented.py
	@# The assistant's precomputed answers come from the same catalogue. Run
	@# here rather than as its own target so they cannot drift from it: help
	@# that names a screen the product no longer has is worse than none.
	python3 scripts/gen_answers.py
	gofmt -w internal/catalog internal/api

docs: catalog ## Regenerate docs/FEATURES.md
	python3 scripts/gen_docs.py

matrix: ## Drive every built feature as its own role; write the two evidence CSVs
	@# Needs a running server with demo data: it signs in as all ten personas
	@# and does a school day's work, so the results are observations rather
	@# than assertions about what the code ought to do.
	python3 scripts/gen_matrix.py
	python3 scripts/simulate.py $(or $(BASE_URL),http://127.0.0.1:8090)

demo: ## Seed demo data and one signed-in-able user per role
	go run ./cmd/migrate demo-data
	go run ./cmd/migrate demo-users -password "$(or $(DEMO_PASSWORD),9)"

## --- quality --------------------------------------------------------------

.PHONY: test test-all lint
test: ## Unit tests (no database needed)
	go test ./internal/...
test-all: ## Unit + integration tests (needs Postgres)
	TEST_DATABASE_URL="$(TEST_DATABASE_URL)" DEMO_PASSWORD="$(or $(DEMO_PASSWORD),9)" go test ./...

test-roles: ## Role-based end-to-end tests against a running server
	TEST_BASE_URL="$(or $(TEST_BASE_URL),http://127.0.0.1:8090)" \
	TEST_DATABASE_URL="$(TEST_DATABASE_URL)" DEMO_PASSWORD="$(or $(DEMO_PASSWORD),9)" go test ./tests/ -v
lint: ## vet + gofmt check + frontend typecheck
	go vet ./...
	@out=$$(gofmt -l ./cmd ./internal ./tests); \
	  if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi
	cd web && npx tsc --noEmit

## --- build ----------------------------------------------------------------

.PHONY: build build-ui dist clean
build: ## Cross-compile the three binaries into dist/
	@mkdir -p $(DIST)
	$(GOFLAGS) go build -trimpath -ldflags '$(LDFLAGS)' -o $(DIST)/web     ./cmd/web
	$(GOFLAGS) go build -trimpath -ldflags '$(LDFLAGS)' -o $(DIST)/worker  ./cmd/worker
	$(GOFLAGS) go build -trimpath -ldflags '$(LDFLAGS)' -o $(DIST)/migrate ./cmd/migrate
	@ls -lh $(DIST)

build-ui: ## Build the SPA bundle
	cd web && npm ci --silent && npm run build

dist: build build-ui ## Build everything

clean: ## Remove build output
	rm -rf $(DIST) web/dist

## --- deploy ---------------------------------------------------------------

.PHONY: deploy deploy-app deploy-ui publish-apk logs status
deploy: dist deploy-app deploy-ui ## Full deploy to $(FQDN)
	@echo "deployed: https://$(FQDN)"

deploy-app: ## Upload binaries, run migrations, restart services
	ssh $(HOST) 'mkdir -p /tmp/$(SERVICE)-dist'
	rsync -az $(DIST)/web $(DIST)/worker $(DIST)/migrate $(HOST):/tmp/$(SERVICE)-dist/
	rsync -az scripts/deploy.sh $(HOST):/tmp/$(SERVICE)-dist/
	ssh $(HOST) 'FQDN=$(FQDN) APP_DIR=$(REMOTE_DIR) SERVICE=$(SERVICE) WEBROOT=$(WEBROOT) \
		bash /tmp/$(SERVICE)-dist/deploy.sh'

deploy-server: ## Build and deploy ON the server from git: make deploy-server [COMMIT=abc1234]
	@# Everything happens on the box: git pull, go build, npm build, migrate,
	@# restart, queue check. The only local requirement is ssh, which is the
	@# point -- cross-compiling meant whoever deployed also had to carry a Go
	@# toolchain and whatever was in their working tree.
	@#
	@# COMMIT pins the deploy to one revision. "deploy main" is not repeatable:
	@# it means whatever the branch pointed at that second, so a rollback has
	@# no command. With COMMIT it does -- the same target with the old hash.
	@# The hash must be an ancestor of $(BRANCH); the server refuses otherwise.
	ssh $(HOST) 'BRANCH=$(or $(BRANCH),main) COMMIT=$(COMMIT) bash -s' < scripts/build-on-server.sh

## --- queue ----------------------------------------------------------------

.PHONY: queue-status queue-doctor queue-failed queue-retry queue-unstick queue-restart
QUEUE_MAINT = SERVICE=$(SERVICE) bash /opt/$(SERVICE)-src/scripts/queue-maint.sh

queue-status: ## Queue depths per queue
	ssh $(HOST) "$(QUEUE_MAINT) status"

queue-doctor: ## Health verdict for the queue; exits non-zero if unhealthy
	ssh $(HOST) "$(QUEUE_MAINT) doctor"

queue-failed: ## Show archived (dead) tasks and their errors
	ssh $(HOST) "$(QUEUE_MAINT) failed $(or $(N),20)"

queue-retry: ## Requeue archived+retrying tasks: make queue-retry [Q=bulk]
	ssh $(HOST) "$(QUEUE_MAINT) retry $(or $(Q),all) --yes"

queue-unstick: ## Requeue tasks orphaned by a worker restart: make queue-unstick [Q=bulk]
	ssh $(HOST) "$(QUEUE_MAINT) unstick $(or $(Q),all) --yes"

queue-restart: ## Restart the worker, then report queue health
	ssh $(HOST) "$(QUEUE_MAINT) restart"

deploy-ui: ## Upload the SPA bundle
	ssh $(HOST) 'mkdir -p $(WEBROOT)'
	rsync -az --delete web/dist/ $(HOST):$(WEBROOT)/

publish-apk: ## Upload one Android build: make publish-apk APK=path/to/bus-tracker-1.0.0.apk
	@# The APK is not built here and is not built on the server -- Android needs
	@# a toolchain neither box carries. It is built wherever Android Studio is,
	@# and this target only puts a finished file where /apps can serve it.
	@#
	@# The name is the contract: "<slug>-<version>.apk", slug being bus-tracker
	@# or sms-gateway. internal/api/apps.go reads the version out of it, and a
	@# file named anything else is ignored rather than served as version "".
	@test -n "$(APK)" || { echo "set APK=path/to/<slug>-<version>.apk"; exit 1; }
	@echo "$$(basename $(APK))" | grep -Eq '^(bus-tracker|sms-gateway)-v?[0-9]+(\.[0-9]+)*\.apk$$' \
		|| { echo "name must be <slug>-<version>.apk, e.g. bus-tracker-1.0.0.apk"; exit 1; }
	ssh $(HOST) 'mkdir -p $(APKDIR)'
	rsync -az --progress $(APK) $(HOST):$(APKDIR)/
	@echo "published — https://$(FQDN)/apps"
	@echo "sha256 (local): $$(sha256sum $(APK) | cut -d' ' -f1)"

logs: ## Tail remote logs
	ssh $(HOST) 'journalctl -u $(SERVICE)-web -u $(SERVICE)-worker -f -n 50'

status: ## Remote service status
	ssh $(HOST) 'systemctl status $(SERVICE)-web $(SERVICE)-worker --no-pager | head -30; \
		curl -s -o /dev/null -w "https probe: %{http_code}\n" https://$(FQDN)/healthz'
