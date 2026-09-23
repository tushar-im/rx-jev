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
- **Model version.** Request `jev-latest`. Every run records the version Jev reports, so a
  new version shows up in the stored runs; re-check the thresholds when one appears.
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

### M3 User interface

- M3.1 Drug search with RxNorm suggestions.
- M3.2 Question chips grouped as in the catalog. `take_with_food` is hidden until it has
  its own options.
- M3.3 Answer card: category, quoted sentence, label version and date, DailyMed link.
- M3.4 Low-confidence and not-found states, driven by the API's `confident` flag.

### M4 Custom questions

- M4.1 Free-text question becomes the Jev instruction; categories stay fixed.
- M4.2 Rate limiting and input length limits.

### GATE 2 Regulatory and wording review

Confirm with a regulatory advisor that the wording and display rules keep this a label
reference tool, not a device giving individual advice. A pharmacist spot-checks the hard
cases flagged in Gate 1 and a sample of the rest. **Do not launch publicly before this.**

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
