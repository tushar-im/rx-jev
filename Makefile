.PHONY: install dev dev-worker dev-web test test-worker test-web lint format \
	db-local db-remote deploy smoke

install:
	npm install

# Run the API Worker and the web app: make -j2 dev
dev: dev-worker dev-web

# The API Worker on :8787 with local D1, KV and Durable Objects. Secrets: apps/worker/.dev.vars
dev-worker:
	cd apps/worker && npx wrangler dev --port 8787

# Vite on :5173, /api proxied to the API Worker
dev-web:
	cd apps/web && npm run dev < /dev/null

test: test-worker test-web

test-worker:
	cd apps/worker && npm test

test-web:
	cd apps/web && npm test

lint:
	npm run format:check && npm run lint && npm run typecheck

format:
	npm run format

# Local D1 for the Worker: apply migrations. STORE=path/to/rx_jev.db also imports an old
# Python judgment store.
db-local:
	cd apps/worker && npm run db:migrate:local
	$(if $(STORE),cd apps/worker && npm run db:import -- $(abspath $(STORE)))

# The deployed D1 (after wrangler login): apply migrations, and import STORE if given
db-remote:
	cd apps/worker && npx wrangler d1 migrations apply DB --remote
	$(if $(STORE),cd apps/worker && npm run db:import -- $(abspath $(STORE)) --remote)

# Deploy the API Worker, then the web Worker that calls it
deploy:
	cd apps/worker && npx wrangler deploy
	cd apps/web && npm run deploy

# Smoke-test a deployment: make smoke URL=https://your-site (ACCESS_CLIENT_ID/SECRET behind Access)
smoke:
	cd apps/worker && node scripts/smoke.ts $(URL)
