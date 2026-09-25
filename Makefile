.PHONY: install dev dev-worker dev-web dev-api test test-worker test-web test-api lint format \
	golden db-local db-remote deploy smoke

install:
	npm install
	cd apps/api && uv sync

# Run the API Worker and the web app: make -j2 dev
dev: dev-worker dev-web

# The API Worker on :8787 with local D1, KV and Durable Objects. Secrets: apps/worker/.dev.vars
dev-worker:
	cd apps/worker && npx wrangler dev --port 8787

# Vite on :5173, /api proxied to the API Worker (API_URL=http://127.0.0.1:8000 for Python)
dev-web:
	cd apps/web && npm run dev < /dev/null

# The Python API on :8000, the reference until cutover (M6.11)
dev-api:
	cd apps/api && uv run fastapi dev --port 8000

test: test-worker test-web test-api

test-worker:
	cd apps/worker && npm test

test-web:
	cd apps/web && npm test

test-api:
	cd apps/api && uv run pytest -q

lint:
	npm run format:check && npm run lint && npm run typecheck
	cd apps/api && uv run ruff check . && uv run ruff format --check .

format:
	npm run format
	cd apps/api && uv run ruff format .

# Golden files the TypeScript port must match: fixtures.json (committed) and store.jsonl (local)
golden:
	cd apps/api && PYTHONPATH=. uv run python scripts/write_golden.py

# Local D1 for the Worker: apply migrations, then import apps/api/rx_jev.db
db-local:
	cd apps/worker && npm run db:migrate:local && npm run db:import

# The deployed D1: apply migrations, then import apps/api/rx_jev.db (after wrangler login)
db-remote:
	cd apps/worker && npx wrangler d1 migrations apply DB --remote && npm run db:import -- --remote

# Deploy the API Worker, then the web Worker that calls it
deploy:
	cd apps/worker && npx wrangler deploy
	cd apps/web && npm run deploy

# Smoke-test a deployment: make smoke URL=https://your-site (ACCESS_CLIENT_ID/SECRET behind Access)
smoke:
	cd apps/worker && node scripts/smoke.ts $(URL)
