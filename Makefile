.PHONY: install dev dev-api dev-web test test-api test-web lint format

install:
	cd apps/api && uv sync
	npm install

# Run both servers: make -j2 dev
dev: dev-api dev-web

dev-api:
	cd apps/api && uv run fastapi dev --port 8000

dev-web:
	cd apps/web && npm run dev

test: test-api test-web

test-api:
	cd apps/api && uv run pytest -q

test-web:
	cd apps/web && npm test

lint:
	cd apps/api && uv run ruff check . && uv run ruff format --check .
	npm run format:check && npm run lint && npm run typecheck

format:
	cd apps/api && uv run ruff format .
	npm run format
