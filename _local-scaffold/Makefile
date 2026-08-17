.PHONY: help setup migrate seed run worker test test-unit test-integration lint fmt tidy reset check

DB_ADMIN_URL ?= postgres:///schoolerp?host=/var/run/postgresql
TEST_DB_NAME ?= schoolerp_test
ADMIN_CONN   ?= postgres:///postgres?host=/var/run/postgresql

export TEST_DB_ADMIN_URL ?= postgres:///$(TEST_DB_NAME)?host=/var/run/postgresql
export TEST_DATABASE_URL ?= postgres://schoolerp_app:schoolerp_dev_password@127.0.0.1:5432/$(TEST_DB_NAME)?sslmode=disable

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## Create the local database and the unprivileged application role
	./scripts/dev-setup.sh

migrate: ## Apply migrations (as the database owner, not the app role)
	DATABASE_URL="$(DB_ADMIN_URL)" go run ./cmd/api migrate

seed: ## Load development data
	DATABASE_URL="$(DB_ADMIN_URL)" go run ./cmd/api seed

run: ## Start the API
	go run ./cmd/api serve

worker: ## Start the background worker
	go run ./cmd/worker

test: test-unit test-integration ## Everything

test-unit: ## Tests with no external dependencies
	go test ./pkg/... ./internal/...

test-integration: ## Tests against a real PostgreSQL and Redis
	@psql "$(ADMIN_CONN)" -tAc "SELECT 1 FROM pg_database WHERE datname='$(TEST_DB_NAME)'" | grep -q 1 || \
		( psql "$(ADMIN_CONN)" -q -c "CREATE DATABASE $(TEST_DB_NAME)" && \
		  psql "$(ADMIN_CONN)" -q -c "GRANT CONNECT ON DATABASE $(TEST_DB_NAME) TO schoolerp_app" )
	go test ./tests/... -count=1

reset: ## Drop and rebuild both databases from scratch
	./scripts/dev-setup.sh --reset
	psql "$(ADMIN_CONN)" -q -c "DROP DATABASE IF EXISTS $(TEST_DB_NAME) WITH (FORCE)"
	$(MAKE) migrate seed

check: fmt tidy test ## What CI runs

fmt:
	go fmt ./...

tidy:
	go mod tidy

lint: ## Requires golangci-lint
	golangci-lint run ./...
