# rx-jev plan

## Product

A person types a drug name, picks a question like "pregnancy" or "diabetes", and sees
**what the official label says about it**, quoted word for word, with a link to the full
label.

It is a search tool over the label. The label is the authority. rx-jev never says a drug is
safe, allowed, or right for anyone.

### Non-goals

- Personal advice, "is this safe for me", or dosing for an individual.
- Multi-drug interaction checking.
- Labels outside the US. openFDA and DailyMed are US-only.
- Rewriting or summarising label text. The UI only shows verbatim sentences.

## How an answer is produced

1. **Resolve the name.** RxNorm turns "Advil" into an ingredient and an RxCUI.
2. **Pick one canonical label per product type.** openFDA returns hundreds of labels per
   ingredient, one per repackager: 907 OTC ibuprofen labels, 338 prescription metformin
   labels at time of writing. Some drugs, such as ibuprofen, have both an OTC and a
   prescription label; the API returns one of each and the UI lets the person switch. For
   each type: the label's ingredient list must match exactly (salt forms allowed), the
   label must have an application number (which excludes homeopathic products), prefer
   the original packager and fall back to repackagers, then take the latest
   `effective_time`. openFDA stores only product-level RxCUIs, so the search uses
   ingredient names, not the ingredient RxCUI.
3. **Map the question to sections.** Code, not the model, decides which label sections can
   answer each question. See the catalog below.
4. **Split those sections into sentences.** These are the only candidates Jev may pick from.
5. **Ask Jev, one request per label, all questions at once.** Two judgments per question:
   - **Stance**, a Choice over the five answer categories.
   - **Evidence**, a Choice over candidate sentence IDs plus `none`. Select, never generate.
6. **Store the full probability distributions**, keyed by label `set_id` and `version`.
7. **Serve from the store, compute on a miss.** A miss means no stored judgments exist for
   this label `set_id`, `version`, prompt hash and model version. On a miss, the API runs
   step 5 for all standard questions in one request, stores the result, then serves it.
   Answers not yet checked by a human reviewer carry `reviewed: false`. If Jev fails, the API
   returns a 503 Problem Details response and stores nothing. It never serves a partial or
   guessed answer. Custom questions always call Jev live and are never stored as reviewed.

### Answer categories

Fixed for every question:

| Category | Meaning |
|---|---|
| `warns_against` | The label says do not use, or contraindicated |
| `caution` | The label says ask a doctor, use caution, or monitor |
| `dose_change` | The label gives a different dose for this group |
| `no_known_issue` | The label explicitly says no problem is known |
| `not_mentioned` | The label does not address this at all |

`no_known_issue` and `not_mentioned` must never be merged. Silence is not reassurance.

### Display rules

- Headings read "What the label says about pregnancy", never "Is it safe in pregnancy".
- No green ticks or red crosses. Neutral icons plus the quoted sentence.
- Every answer shows the label version and date, and links to the DailyMed page.
- An answer shows its category only when the API marks it `confident`: stance and
  evidence confidence both at least 0.9 (`display_min_confidence` in config, agreed at
  Gate 1). Otherwise, or when evidence is `none`, it shows "We couldn't find a clear
  answer. Read the full label or ask a pharmacist." It never shows a guess.
- A persistent "Ask your pharmacist" link on every result.

### Question catalog, v1

Section names are real openFDA fields, listed in priority order. The code in
[catalog.py](apps/api/src/rx_jev_api/catalog.py) is the source of truth. The mapper picks the
column by the sections a label actually has, not its product type metadata. Older
prescription labels lack `warnings_and_cautions`, so `warnings` and `precautions` stand in
(shown in italics below).

| Group | Question | OTC sections | Prescription sections |
|---|---|---|---|
| Who | Pregnancy | `pregnancy_or_breast_feeding` | `pregnancy`, `use_in_specific_populations` |
| Who | Breastfeeding | `pregnancy_or_breast_feeding` | `nursing_mothers`, `use_in_specific_populations` |
| Who | Children | `do_not_use`, `dosage_and_administration` | `pediatric_use` |
| Who | Older adults | `ask_doctor`, `dosage_and_administration` | `geriatric_use` |
| Conditions | Diabetes, high blood pressure, kidney, liver, heart, asthma, glaucoma, enlarged prostate, stomach ulcers | `do_not_use`, `ask_doctor`, `warnings` | `contraindications`, `warnings_and_cautions`, _`warnings`_, _`precautions`_, `use_in_specific_populations` |
| Combinations | Alcohol | `warnings`, `when_using` | `warnings_and_cautions`, _`warnings`_, _`precautions`_, `drug_interactions` |
| Combinations | Blood thinners | `ask_doctor_or_pharmacist` | `drug_interactions` |
| Daily life | Drowsiness and driving | `when_using` | `warnings_and_cautions`, _`warnings`_, _`precautions`_, `information_for_patients` |
| Daily life | Take with food | `dosage_and_administration` | `dosage_and_administration` |
| Serious | Boxed warning present | n/a | `boxed_warning` |
| Serious | Allergy warnings | `do_not_use`, `warnings` | `contraindications` |

## Architecture

```
apps/web  (Vite + React, zod)
   |  /api proxy
apps/api  (FastAPI)
   |-- rxnorm client      name -> ingredient, RxCUI
   |-- openfda client     RxCUI -> canonical label JSON
   |-- label parser       sections -> candidate sentences
   |-- judge              TypeSafe Jev, one request per label
   |-- store              SQLite via SQLModel
```

- **Storage.** SQLite through SQLModel for v1. Tables: `label` (set_id, version, raw JSON,
  fetched_at), `judge_run` (one Jev request: set_id, version, prompt_hash, requested model,
  reported model_version, latency, tokens), `judgment` (run, question_id, kind `stance` or
  `evidence`, full distribution, confidence, `reviewed`). Verdicts are derived at read time so
  thresholds can change without re-running inference.
- **Jev request shape.** The state holds only the sections some question uses, each
  candidate keyed by its ID. Evidence options are those IDs plus `none`. A Choice holds at
  most 255 options, so evidence with more candidates is asked as several chunk questions in
  the same request, then decided by one more request over the top five sentences of each
  chunk plus `none` (3 of 121 review-set labels, such as aripiprazole's 343 condition
  sentences). A question with no candidate sections is skipped and served with a status
  saying why. Nothing is ever truncated.
- **Keys.** `TYPESAFE_API_KEY` lives only in the backend environment. The browser never sees it.
- **Model version.** Request `jev-latest`. Stored runs are keyed by that requested name,
  not by the version Jev reports, so a new Jev release does not re-judge stored labels:
  they keep answers from the version they were judged with (`jev-1.13.0` for the Gate 1
  set). Only labels judged after a release use the new version. Each run records the
  reported version, and the batch script lists every label judged by a version other than
  `validated_model_version` (config, `jev-1.13.0`), whose thresholds were never checked.
  To move stored labels to a new version, re-check the thresholds on it, then re-judge.
- **External data.** Every openFDA, RxNorm and Jev response is parsed with Pydantic on the
  way in. Every API response is parsed with zod in the browser.
- **Errors.** RFC 7807 Problem Details everywhere.

## Milestones

Each milestone ends with tests green and a commit tagged with its ID. Stop at every gate.

### M0 Scaffold (done)

Monorepo, FastAPI health route, Problem Details handlers, React shell with zod client,
tests and lint green on both sides.

### M1 Label ingestion, no AI (done)

- M1.1 RxNorm client: name to ingredient and RxCUI, with recorded fixtures.
- M1.2 openFDA client: canonical label selection rule, with recorded fixtures.
- M1.3 Section mapper: question ID to section fields for OTC and prescription.
- M1.4 Sentence splitter: sections to numbered candidate sentences.
- M1.5 `GET /api/labels/{rxcui}` returns parsed sections and candidates.

Live lookups take 4 to 6 seconds, mostly openFDA search pages. The M2 store absorbs this for
repeat lookups. A name search endpoint for the UI is left to M3.1.

### M2 Jev judgments (done)

- M2.1 Judge module: builds stance and evidence questions from the catalog.
- M2.2 Store module: persist distributions keyed by label version.
- M2.3 `GET /api/labels/{rxcui}/answers` serves stored judgments. On a miss it computes
  and stores all standard questions for that label version, with `reviewed: false`, as
  defined in step 7 above. A Jev failure returns 503 Problem Details.
- M2.4 Batch script: precompute the review set of 100 common drugs
  (`scripts/precompute_review_set.py`, draft list in `scripts/review_set.txt`).

All four stories are tested against a fake Jev. The first live run (74 of 100 drugs, all
`jev-1.13.0`) took 0.4 to 1.5 s and 6K to 62K input tokens per label. Before Gate 1: finish
the batch with `TYPESAFE_MODEL=jev-latest` and check the report.

### GATE 1 Label-reading review

No pharmacist is available yet, so the project owner reviews the stored answers for the 100
drugs. The review checks what the label says, not clinical judgment: is the category right
for the label's text, and is the quoted sentence the one that shows it. Work happens on
`gate/1-label-review`.

- G1.1 Review rules: when each category is correct, and when a quote is correct, written
  from the answer categories above so every row is judged the same way.
- G1.2 Review sheet (`scripts/build_review_sheet.py`): every `no_known_issue` answer and
  every stance that disagrees with its evidence, plus up to 60 other answers from each
  confidence band (below 0.5, 0.5 to 0.7, 0.7 to 0.9, 0.9 and up, by the weaker of the
  two confidences). The first build picked 351 of 2,000 judged answers.
- G1.3 Second reader (`scripts/second_read.py`): Claude graded all 351 rows blind to Jev's
  answer. The stances agreed on 285 (81%); 83 rows disagreed on stance or on `none`.
- G1.4 Thresholds, from the second read (done, 2026-09-23):

  | Weaker confidence | Stance agreement | Share of 2,000 answers |
  |---|---|---|
  | 0.9 and up | 81/83 (98%) | 53% |
  | 0.7 to 0.9 | 74/85 (87%) | 17% |
  | 0.5 to 0.7 | 77/90 (86%) | 16% |
  | below 0.5 | 53/93 (57%) | 15% |

  No `not_mentioned` / `no_known_issue` swaps. Decisions agreed with the owner:
  1. **Display threshold 0.9** on both confidences, applied at read time as `confident`.
     Lower it only after the Gate 2 pharmacist spot-check.
  2. **Children**: "safety or effectiveness not established" is `caution`. Added to the
     children stance instructions, which changes their prompt hash: 107 stored labels are
     re-judged on the next batch run (about 3.3M input tokens).
  3. **Taking with food** is hidden in the UI. Its 14 disagreements were mostly the same
     sentence put in different categories: the five categories do not fit food
     instructions. It gets its own options (with food, empty stomach, either, not
     mentioned) after M3.

  Follow-ups found by the review, none blocking M3:
  - Finasteride breastfeeding: `no_known_issue` at 0.73 from a fetal-study sentence, while
    the label says it is not for use in women. Below the threshold, so not shown as a
    category; re-check after the re-run.
  - OTC sentence lead-ins: some "Ask a doctor" items carry a "Do not use" lead-in
    (diphenhydramine, doxylamine), which can push a stance towards `warns_against`.
  - Section headings are merged into sentences, such as "2 DOSAGE AND ADMINISTRATION ...".
  - Aripiprazole still exceeds Jev's input limit (see Open questions).

Thresholds are agreed, so Gate 1 is passed and M3 may start.

### M3 User interface (done)

- M3.1 Drug search with RxNorm suggestions. RxNorm's approximate search does not match
  partial words, so `/api/drugs/suggestions` matches the start of a name or word in
  RxNorm's display name list (about 28K names, fetched once per process).
  `/api/drugs/resolve` turns the chosen name into the ingredient-set RxCUI.
- M3.2 Question chips grouped as in the catalog. `take_with_food` is hidden until it has
  its own options.
- M3.3 Answer card: category, quoted sentence, label version and date, DailyMed link.
  "Ask your pharmacist" is a note on every card, not a link, until there is a place to
  send people. Unreviewed answers say "Not yet checked by a pharmacist."
- M3.4 Low-confidence and not-found states, driven by the API's `confident` flag. A
  question with no candidate sections, such as a boxed warning on an OTC label, says the
  label has no section about it.

### M4 Custom questions (done)

- M4.1 Free-text question becomes the Jev instruction; categories stay fixed.
  `POST /api/labels/{rxcui}/ask` takes `{set_id, question}` and asks about the one label on
  screen, so a drug with two labels costs one request, not two. The text goes into the
  instructions as a `reader_question` field, with a rule to treat it as a topic, not as
  instructions. Candidates are every section the catalog reads for that label; a label too
  long for one request answers `too_long`. The answer uses the same `confident` rule and is
  never stored or reviewed. The card never repeats the reader's wording, so a question such
  as "Is it safe for me?" never looks answered. A pinned-hash test keeps catalog prompts byte-identical, so the
  shared builder re-judges nothing. A live check on OTC ibuprofen: stomach ulcer gave
  `caution` quoting the "Ask a doctor" item (evidence 0.69, so not shown); grapefruit gave
  `not_mentioned` with `none`. About 3.6K input tokens each.
- M4.2 Rate limiting and input length limits. Questions are 3 to 200 characters after
  trimming. Each client may ask 5 per minute and 50 per day (`ask_per_minute`,
  `ask_per_day`); over that is 429 Problem Details with `Retry-After`. Counts are in memory,
  per process, keyed by client address. An ask takes its slot before any upstream call, so
a burst cannot all reach RxNorm and openFDA, and gives back that same slot, never another
request's, if its drug or label is not found; invalid requests cost nothing.

Before a public launch: the limiter needs a shared store if the API runs several workers, and
the forwarded client address if it sits behind a proxy. The 0.9 threshold was set on catalog
questions only; Gate 2 should spot-check custom answers too.

### M5 UI uplift and transparency panel (done)

Done before Gate 2, so the reviewers see the layout that will launch.

- M5.1 Three-column layout: a sidebar with the brand, the search and the question chips; the
  answer card in the center; a panel on the right. Below about 1024 px the columns stack
  and the chips become one scrolling row. A one-line red strip across the top of every view says it is a demo
  project, not medical advice, and that AI picked the quotes with no pharmacist's check; each
  answer card carries the pharmacist note. The search button is an icon, and the API status sits at the
  foot of the panel.
- M5.2 API trace fields, so the panel shows real numbers:
  - For each label: its Jev run (tokens, latency, model) and whether it was judged now or
    served from the store.
  - For each answer: how many candidate sentences and sections Jev chose from.
  - For the lookup: how many labels openFDA matched per product type, and RxNorm and
    openFDA time.
  - For a custom question: its live Jev tokens and latency.
- M5.3 "How this answer was made" panel with session totals, always shown. For an answer shown as "We couldn't find a clear answer", it shows neither the
  stance nor its confidence, only that it is below the threshold, because the top guess is
  never shown.
- M5.4 Polish: the quote in a larger serif, a neutral shape per stance (not colour), a
  smaller caution strip on phones, desktop and phone checks, and the demo script moved to
  16:9 with the panel's real numbers ([docs/demo-script.md](docs/demo-script.md)).
  Questions with a clear answer are highlighted, the same for every category. The label
  switch is captioned "Which label" and counts each label's clear answers; when only the
  other label answers a question clearly, the card points to it without saying what it says.
  OTC and prescription labels are never merged: they are different products.

### M6 Cloudflare deployment: TypeScript port (M6.1 to M6.10 done, M6.11 prepared)

The backend is ported from Python to TypeScript and deployed as Cloudflare Workers. The app
waits on the network (openFDA 4 to 8 s, Jev 1 to 60 s per label), so what the move buys is
not speed of code. It buys:
- millisecond cold starts;
- Cloudflare's most mature path (Drizzle on D1, and tests in the Workers runtime);
- one language with the web app, so one set of zod schemas defines the API contract for
  both.

Python on Workers was the cheaper step, but it keeps the slowest cold starts and a young
third-party D1 library. The codebase is small today (about 3,000 lines of app code and 228
tests), so this is the cheapest time to port.

- **Two Workers.**
  - **API Worker:** Hono, TypeScript strict, zod for every external payload, Drizzle ORM on
    D1, and the TypeSafe JS SDK.
  - **Web Worker:** serves the Vite build as static assets. `/api/*` reaches the API
    Worker on the same origin, through a route on a custom domain or a service binding on
    `workers.dev`, so the web app keeps its relative `/api` calls and needs no CORS.
- **One contract.** A shared `packages/contract` holds the zod schemas for every API
  request and response. The Worker builds its responses from them and the web app parses
  with them. The hand-kept mirror of the Pydantic models in `apps/web/src/api.ts` goes
  away.
- **Same API.** The same paths, JSON shapes, Problem Details, trace fields and guardrails.
  The web app's behaviour does not change.
- **Storage.**
  - D1 holds `label`, `judge_run` and `judgment` as today. The largest stored label is
    265 KB, under D1's 2 MB row limit, so labels stay in D1.
  - The existing `rx_jev.db` is imported, so no stored judgment is lost.
- **Prompt-hash parity is the hard requirement.** The Worker must build byte-identical Jev
  requests, or every stored label is re-judged (about 4,900 judgments, 4.4M input tokens).
  JavaScript differs from Python in the details that matter:
  - regex semantics in the sentence splitter;
  - string length (UTF-16 units against code points) in the token estimate, which decides
    how a long label is split;
  - JSON serialization (sorted keys, no spaces, non-ASCII kept) in the prompt hash.

  So before any port code, Python writes golden files for every stored label: its
  candidates, request parts and prompt hash. The TypeScript code must match all of them.
- **Tests.** Vitest in the Workers runtime (`@cloudflare/vitest-pool-workers`), with a local
  D1. The 228 Python tests are ported. The recorded RxNorm and openFDA fixtures move to a
  shared `fixtures/` folder that both implementations replay.
- **A public demo, launched on purpose before Gate 2**, as a #BuildInPublic project. The
  safeguards:
  - the red caution strip on every page;
  - the per-client ask limits (5 a minute, 50 a day);
  - a Cloudflare rate-limiting rule on `/api/labels/*`;
  - a spending cap on the TypeSafe account.
- **Python stays until cutover.** `apps/api` remains the reference until every port test and
  golden file passes and the deployed Worker has passed its smoke test. Then it is removed.

Stories:

- M6.1 Monorepo and contract:
  - npm workspaces for `apps/worker`, `apps/web` and `packages/contract`;
  - the web app's zod schemas moved into the contract and imported from there;
  - Biome, oxlint and `tsc` across all three.
- M6.2 Golden files from Python. A script writes, for every label in `rx_jev.db` and the
  test fixtures, its candidates per section, the Jev request parts and the prompt hash,
  together with the pinned hashes. It runs before any port code.
- M6.3 Worker scaffold:
  - Hono with `/api/health`;
  - Problem Details for every error;
  - Wrangler config with D1, KV and a Durable Object;
  - Vitest in the Workers runtime;
  - `make` targets for the Worker.
- M6.4 The RxNorm and openFDA clients, with zod on every response, the same canonical label
  rule, the source trace (matches, requests, timings), and the Python client tests ported
  onto the shared fixtures. Includes the suggestions and resolve endpoints.
- M6.5 The catalog, sentence splitter, Jev request builder and judge (chunked evidence, the
  shortlist request, splitting by token budget) on the TypeSafe JS SDK. Every golden file
  matches byte for byte.
- M6.6 The store on D1 through Drizzle, and the answers endpoint with its trace fields. An
  import script moves `rx_jev.db` into D1, and a check confirms every stored run is found
  for its label after import.
- M6.7 The ask endpoint: length limits, and the rate limiter on a Durable Object keyed by
  `CF-Connecting-IP`, with the same windows and slot release.
- M6.8 Caching:
  - openFDA canonical lookups cached in D1 for 24 hours; the panel says when a lookup came
    from the cache;
  - the RxNorm name list in KV, refreshed by a daily Cron Trigger;
  - an `ETag` on answers, from the label version and run.
- M6.9 The offline tools ported: the review-set batch, the review sheet and the second read,
  run with Node against D1 through Drizzle's D1 HTTP driver.
- M6.10 The web Worker: the static build and `/api/*` on the same origin. Autocomplete
  moves to the browser: the RxNorm name list is cached in IndexedDB and matched locally.
  Nothing personal is stored in the browser: no looked-up drugs, answers or questions.
- M6.11 Deploy and cutover:
  - D1, KV and the Durable Object created;
  - `TYPESAFE_API_KEY` and `OPENFDA_API_KEY` set as Worker secrets;
  - data imported;
  - a smoke test on Tylenol PM, Wellbutrin and Benadryl, whose stored answers must load
    without calling Jev;
  - then `apps/api` removed, and CLAUDE.md and the Makefile updated for the TypeScript
    stack.

Where it stands:

- Parity: every golden file matches byte for byte: the 7 fixture labels with full request
  bodies, and all 123 stored labels at three token budgets and with a custom question. The
  three pinned prompt hashes match. Checked live through the local Workers: Tylenol PM,
  Wellbutrin and Benadryl load from the imported store without calling Jev.
- The import finds all 141 stored runs for their labels. 23 of the 123 labels have a run
  for today's prompt, the same as on the Python app; the rest predate the Gate 1 prompt
  changes and are judged again when first opened.
- Additions beyond the Python API: `openfda_cached` in the source trace, `/api/drugs/names`
  for the browser's name list, and the `ETag` on stored answers.
- M6.11 is prepared: Wrangler configs, `make db-remote`, `make deploy`, `make smoke`, and
  the steps in `docs/deploy-cloudflare.md`. Creating the Cloudflare resources, the secrets,
  the safeguards and the deploy need the owner's account. `apps/api` is removed only after
  the deployed smoke test passes.

### GATE 2 Regulatory and wording review

Confirm with a regulatory advisor that the wording and display rules keep this a label
reference tool, not a device giving individual advice. A pharmacist spot-checks the hard
cases flagged in Gate 1 and a sample of the rest.

The public demo (M6) launched before this gate on purpose. Gate 2 still applies before any
use beyond a demo, such as partners or promoting rx-jev as a reference tool.

## Open questions

- **Market.** If users are outside the US, local brands will not resolve and local labels
  may differ from US labels.
- **Jev input limit.** Not documented. The first review-set run found it: 61,989 input
  tokens was accepted and labels of about 67K tokens or more were rejected with
  `400 max_tokens_exceeded` (fluoxetine, duloxetine, quetiapine, topiramate, tramadol,
  oxycodone). Labels over a conservative 55K estimate are now split into several requests
  by whole question. A single question too long for any request is skipped as `too_long`.
  Open: aripiprazole still fails with `max_tokens_exceeded`. Its five parts are each
  estimated at 52K to 55K tokens but carry about 1,000 sentence-ID options, so the
  estimate undercounts option-heavy requests. Aripiprazole is left out of the Gate 1
  review; fix by counting options in the estimate or lowering the budget for such parts.
- **Evidence by ID.** Evidence options are bare candidate IDs that point into the state.
  Whether Jev resolves IDs as well as it would full sentence text is unmeasured; Gate 1
  evidence accuracy answers it.
- **openFDA rate limits.** Anonymous access is limited per IP. Register a free key before
  the M2.4 batch job.
- **Canonical label rule.** Checked in M1.2 against ibuprofen, metformin, acetaminophen with
  diphenhydramine, loratadine, atorvastatin and sertraline. Preferring the brand's NDA was
  rejected: for prescription ibuprofen it picks IV hospital products. Open: the rule does
  not yet consider route or dosage form, so a rare injectable could win for a drug that is
  usually oral. Revisit at Gate 1. The review-set run showed homeopathic products winning
  the OTC slot for five prescription-only drugs (insulin glargine, levothyroxine,
  citalopram, estradiol, potassium chloride). They have no `application_number`, while all
  116 other review-set labels have an NDA, ANDA, BLA or OTC monograph number, so labels
  without one are now skipped.
- **Mislabelled product types.** Some repackager labels marked prescription use OTC
  sections, and older prescription labels use `warnings` and `precautions` instead of
  `warnings_and_cautions`. The M1.3 mapper must select by the sections actually present.
