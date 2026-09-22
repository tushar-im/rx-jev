# rx-jev

Finds what an official US drug label says about a question, such as pregnancy or diabetes,
and quotes it verbatim. Uses TypeSafe Jev for bounded judgments over label text.

Read [PLAN.md](PLAN.md) before starting any work. It holds the milestones, gates, question
catalog, and answer categories.

## Layout

- `apps/api`: FastAPI, Python 3.13, managed with uv. Package `rx_jev_api` under `src/`.
- `apps/web`: Vite, React 19, TypeScript strict, zod.
- Root `Makefile` wraps every common command.

## Commands

```bash
make install       # uv sync + npm install
make -j2 dev       # API on :8000, web on :5173 with /api proxied
make test          # pytest + vitest
make lint          # ruff check/format + oxlint + tsc
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
- All questions for one label go in one request.
- Store full probability distributions, plus prompt hash and model version. Derive verdicts
  at read time.
- Thresholds come from the Gate 1 pharmacist review, never from cookbook defaults.
- `TYPESAFE_API_KEY` stays server-side. Pin the model version in config per deployment.

## Code conventions

- Python: `Annotated` for params and dependencies, return types on every route, `def` unless
  the body truly awaits, routers carry their own `prefix` and `tags`, HTTPX for HTTP,
  SQLModel for storage. No raw SQL.
- TypeScript: strict, no `any`, no `as unknown as X`, named exports only except files a
  framework requires to default-export such as `vite.config.ts`. Explicit return types.
- Every external payload is validated: Pydantic on the backend, zod in the browser.
- Every error response is RFC 7807 Problem Details. Use `problem()` in `problems.py`.

## Testing

- TDD: write the failing test first. Never edit an assertion to make a test pass.
- Unit tests never hit the network. openFDA, RxNorm and TypeSafe responses are recorded
  as JSON fixtures under `apps/api/tests/fixtures/`. Re-record with the scripts in
  `apps/api/scripts/`; tests replay them through `tests/recorded.py`.
- Test fixtures must contain only public label data. No patient data, real or fake.

## Workflow

- Work on `task/<slug>` or `milestone/<slug>` branches. Never commit to `main`.
- Commit after each passing story with its ID, for example `M1.2: canonical label selection`.
- Max three fix cycles per story, then write the blocker to `blocked.md` and stop.
- Stop at every GATE in PLAN.md and wait for a human.
