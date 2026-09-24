.PHONY: install dev dev-api dev-web dev-worker test test-api test-web test-worker lint format golden

install:
	cd apps/api && uv sync
	npm install

# Run both servers: make -j2 dev
dev: dev-api dev-web

dev-api:
	cd apps/api && uv run fastapi dev --port 8000

dev-web:
	cd apps/web && npm run dev

# The API Worker on :8787 with local D1, KV and Durable Objects
dev-worker:
	cd apps/worker && npx wrangler dev --port 8787

test: test-api test-web test-worker

test-api:
	cd apps/api && uv run pytest -q

test-web:
	cd apps/web && npm test

test-worker:
	cd apps/worker && npm test

lint:
	cd apps/api && uv run ruff check . && uv run ruff format --check .
	npm run format:check && npm run lint && npm run typecheck

format:
	cd apps/api && uv run ruff format .
	npm run format

# Golden files the TypeScript port must match: fixtures.json (committed) and store.jsonl (local)
golden:
	cd apps/api && PYTHONPATH=. uv run python scripts/write_golden.py
