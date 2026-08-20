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

.PHONY: deploy deploy-app deploy-ui logs status
deploy: dist deploy-app deploy-ui ## Full deploy to $(FQDN)
	@echo "deployed: https://$(FQDN)"

deploy-app: ## Upload binaries, run migrations, restart services
	ssh $(HOST) 'mkdir -p /tmp/$(SERVICE)-dist'
	rsync -az $(DIST)/web $(DIST)/worker $(DIST)/migrate $(HOST):/tmp/$(SERVICE)-dist/
	rsync -az scripts/deploy.sh $(HOST):/tmp/$(SERVICE)-dist/
	ssh $(HOST) 'FQDN=$(FQDN) APP_DIR=$(REMOTE_DIR) SERVICE=$(SERVICE) WEBROOT=$(WEBROOT) \
		bash /tmp/$(SERVICE)-dist/deploy.sh'

deploy-server: ## Build and deploy ON the server from git (no local toolchain needed)
	@# Everything happens on the box: git pull, go build, npm build, migrate,
	@# restart. The only local requirement is ssh, which is the point --
	@# cross-compiling meant whoever deployed also had to carry a Go toolchain
	@# and whatever was in their working tree.
	ssh $(HOST) 'BRANCH=$(or $(BRANCH),main) bash -s' < scripts/build-on-server.sh

deploy-ui: ## Upload the SPA bundle
	ssh $(HOST) 'mkdir -p $(WEBROOT)'
	rsync -az --delete web/dist/ $(HOST):$(WEBROOT)/

logs: ## Tail remote logs
	ssh $(HOST) 'journalctl -u $(SERVICE)-web -u $(SERVICE)-worker -f -n 50'

status: ## Remote service status
	ssh $(HOST) 'systemctl status $(SERVICE)-web $(SERVICE)-worker --no-pager | head -30; \
		curl -s -o /dev/null -w "https probe: %{http_code}\n" https://$(FQDN)/healthz'
