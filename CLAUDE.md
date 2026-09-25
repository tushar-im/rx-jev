# rx-jev

Finds what an official US drug label says about a question, such as pregnancy or diabetes,
and quotes it verbatim. Uses TypeSafe Jev for bounded judgments over label text.

Read [PLAN.md](PLAN.md) before starting any work. It holds the milestones, gates, question
catalog, and answer categories.

## Layout

npm workspaces:

- `apps/worker`: the API Worker on Cloudflare. Hono, TypeScript strict, zod, Drizzle ORM on
  D1, KV, a Durable Object rate limiter, the TypeSafe JS SDK. Node tools in `scripts/`.
- `apps/web`: Vite, React 19, TypeScript strict, zod, plus the web Worker in `worker/` that
  serves the build and passes `/api/*` to the API Worker.
- `packages/contract`: the zod schemas of every API request and response, and `suggest`.
  Both apps import them; never redefine an API shape elsewhere.
- `fixtures/`: recorded RxNorm and openFDA responses, and the golden files from Python.
- `apps/api`: the Python FastAPI app, kept as the reference until the M6.11 cutover. Do not
  add features to it.
- Root `Makefile` wraps every common command. Deployment: `docs/deploy-cloudflare.md`.

## Commands

```bash
make install       # npm install + uv sync
make db-local      # local D1: migrations, then import apps/api/rx_jev.db
make -j2 dev       # API Worker on :8787, web on :5173 with /api proxied
make test          # Worker (workerd + Node) + web + Python tests
make lint          # biome format + oxlint + tsc, and ruff for Python
make format        # biome format + ruff format
make golden        # regenerate the Python golden files
```

## Product guardrails, non-negotiable

- Never produce or display "safe", "allowed", "OK to take", or any individual advice.
  Headings say "What the label says about X".
- Never generate or paraphrase label text. Jev selects a candidate sentence by ID and the UI
  shows that sentence verbatim.
- When a candidate has a `lead_in` (the text a bullet item hangs off, such as "contraindicated
  in patients with:"), show it with the candidate, both verbatim. Never show the item alone.
- Keep `not_mentioned` and `no_known_issue` as separate categories everywhere: model
  questions, storage, API schema, UI.
- Low confidence shows the "couldn't find a clear answer" state, never the top guess.
- Every answer carries label `set_id`, `version`, `effective_time`, and a DailyMed link.

## TypeSafe Jev rules

- Load the `typesafe-ai` skill and read the live docs before changing any judgment code.
- Code decides which label sections are candidates. Jev only judges what it is given.
- All questions for one label go in one request, unless that request is over Jev's input
  limit. Then split by whole questions (`buildRequest` in `apps/worker/src/judge.ts`), never
  by truncating text.
- Stored runs are keyed by prompt hash. The request builder must stay byte-identical to the
  golden files in `fixtures/golden/`; a change there is a deliberate prompt change that
  re-judges every stored label. Keep Python's whitespace and JSON rules (`src/python.ts`).
- Store full probability distributions, plus prompt hash and model version. Derive verdicts
  at read time.
- Thresholds come from the Gate 1 review, never from cookbook defaults.
- `TYPESAFE_API_KEY` stays server-side. Request `jev-latest`; runs record the reported version.

## Code conventions

- TypeScript: format with Biome (`biome.json`), never Prettier. Strict, no `any`, no
  `as unknown as X`, named exports only except files a framework requires to default-export
  such as `vite.config.ts` or a Worker entry. Explicit return types.
- Storage through Drizzle only; no raw SQL. Schema changes: edit `src/db/schema.ts`, then
  `npx drizzle-kit generate` in `apps/worker`.
- Every external payload is validated with zod: upstream APIs, Jev answers, env vars,
  request bodies, stored JSON, and every response in the browser.
- Every error response is RFC 7807 Problem Details: throw `ProblemError`, `UpstreamError` or
  `JudgeError` from `apps/worker/src/problems.ts`.
- Routes get their clients, store and limiter from `c.var.services`, so tests can swap them.

## Testing

- TDD: write the failing test first. Never edit an assertion to make a test pass.
- Unit tests never hit the network. openFDA and RxNorm responses are recorded as JSON
  fixtures under `fixtures/`, replayed by `apps/worker/test/recorded.ts`; Jev is faked by
  `test/jev.ts`. Worker tests run in workerd with a fresh D1, KV and Durable Objects per
  test; tests of the Node tools and the store golden check run in Node (`test/node/`).
- Test fixtures must contain only public label data. No patient data, real or fake.

## Workflow

- Work on `task/<slug>`, `milestone/<slug>` or `gate/<slug>` branches. Never commit to `main`.
- Commit after each passing story with its ID, for example `M1.2: canonical label selection`.
- Max three fix cycles per story, then write the blocker to `blocked.md` and stop.
- Stop at every GATE in PLAN.md and wait for a human.
