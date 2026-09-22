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
   each type: the label's ingredient list must match exactly (salt forms allowed), prefer
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
   Answers not yet checked by a pharmacist carry `reviewed: false`. If Jev fails, the API
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
- Low-confidence stance or evidence `none` shows "We couldn't find a clear answer. Read the
  full label or ask a pharmacist." It never shows a guess.
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
  fetched_at), `judgment` (set_id, version, question_id, prompt_hash, model_version, full
  distribution, latency, tokens). Verdicts are derived at read time so thresholds can change
  without re-running inference.
- **Keys.** `TYPESAFE_API_KEY` lives only in the backend environment. The browser never sees it.
- **Model version.** Pin the Jev version per deployment. An upgrade invalidates calibrated
  thresholds, so re-run the review set before switching.
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

### M2 Jev judgments

- M2.1 Judge module: builds stance and evidence questions from the catalog.
- M2.2 Store module: persist distributions keyed by label version.
- M2.3 `GET /api/labels/{rxcui}/answers` serves stored judgments. On a miss it computes
  and stores all standard questions for that label version, with `reviewed: false`, as
  defined in step 7 above. A Jev failure returns 503 Problem Details.
- M2.4 Batch script: precompute the review set of 100 common drugs.

**Needs:** a TypeSafe API key, and Jev's maximum input size confirmed from the docs.

### GATE 1 Pharmacist review

A pharmacist reviews the stored answers for 100 drugs against the 19 v1 questions. Record,
per question, stance accuracy, evidence accuracy, and every case where `not_mentioned` and
`no_known_issue` were confused. Set confidence thresholds from this data, not from cookbook
defaults. **Do not start M3 until thresholds are agreed.**

### M3 User interface

- M3.1 Drug search with RxNorm suggestions.
- M3.2 Question chips grouped as in the catalog.
- M3.3 Answer card: category, quoted sentence, label version and date, DailyMed link.
- M3.4 Low-confidence and not-found states.

### M4 Custom questions

- M4.1 Free-text question becomes the Jev instruction; categories stay fixed.
- M4.2 Rate limiting and input length limits.

### GATE 2 Regulatory and wording review

Confirm with a regulatory advisor that the wording and display rules keep this a label
reference tool, not a device giving individual advice. **Do not launch publicly before this.**

## Open questions

- **Market.** If users are outside the US, local brands will not resolve and local labels
  may differ from US labels.
- **Jev input limit.** Long prescription labels may need sections sent in several requests.
- **openFDA rate limits.** Anonymous access is limited per IP. Register a free key before
  the M2.4 batch job.
- **Canonical label rule.** Checked in M1.2 against ibuprofen, metformin, acetaminophen with
  diphenhydramine, loratadine, atorvastatin and sertraline. Preferring the brand's NDA was
  rejected: for prescription ibuprofen it picks IV hospital products. Open: the rule does
  not yet consider route or dosage form, so a rare injectable could win for a drug that is
  usually oral. Revisit at Gate 1.
- **Mislabelled product types.** Some repackager labels marked prescription use OTC
  sections, and older prescription labels use `warnings` and `precautions` instead of
  `warnings_and_cautions`. The M1.3 mapper must select by the sections actually present.
