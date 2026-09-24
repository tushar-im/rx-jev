# Gate 1 review rules (G1.1)

How to mark each row of the Gate 1 review sheet, so every row is judged the same way. The
review checks what the label says, not whether the drug is a good idea for anyone.

## What a row is

One drug label and one catalog question. It shows:

- the question's subject, for example "people who have kidney disease or reduced kidney
  function";
- the sections Jev was told to read, and a DailyMed link to the full label;
- Jev's **stance** (one of five categories) with its confidence;
- Jev's **evidence**: the one sentence it chose, or `none`, with its confidence.

## 1. Is the stance right?

Read the listed sections and decide what they say about the subject.

| Category | Correct when the listed sections... |
|---|---|
| `warns_against` | say not to use the drug, or that it is contraindicated, for the subject |
| `dose_change` | give a different dose or schedule for the subject |
| `caution` | say to ask a doctor first, use caution, or monitor, without saying not to use it |
| `no_known_issue` | explicitly say no problem, risk or dose change is known for the subject |
| `not_mentioned` | do not address the subject at all |

Rules:

1. **The strictest statement wins**, in the order of the table: `warns_against`, then
   `dose_change`, then `caution`. "Not recommended in severe renal impairment; reduce the
   dose in moderate impairment" is `warns_against`.
2. **Silence is not reassurance.** `no_known_issue` needs a sentence that says so, such as
   "No dose adjustment is needed in renal impairment". A label that never mentions the
   subject is `not_mentioned`. Record every row where these two are swapped; they are the
   most important errors in the review.
3. **Judge the listed sections only.** If the subject is addressed only in a section Jev
   was not given, mark the stance against the listed sections and set the error type to
   `sections` (a code problem, not a model problem).
4. **Partial matches count.** A sentence about "severe hepatic impairment" addresses
   liver disease. A sentence about a different condition that merely sounds close does not.

5. **Taking with food.** The categories fit this question loosely, so: an instruction to
   take it with food (or on an empty stomach) is `caution`; "with or without food" is
   `no_known_issue`; no food instruction is `not_mentioned`. `dose_change` is not used.
   Disagreements here may mean the question needs its own categories, not that Jev erred.
6. **Boxed warning.** Any boxed warning text is at least `caution`; `warns_against` when
   it says not to use the drug for some group.

Mark `stance_ok` as `yes` or `no`. When `no`, fill `correct_stance`.

## 2. Is the evidence right?

1. **Correct** when the chosen sentence, read with its lead-in, on its own supports the
   correct stance. If several sentences would do, any of them is correct.
2. **`none` is correct** only when the correct stance is `not_mentioned`.
3. **Wrong** when the sentence is about something else, supports a different stance, or
   is `none` while a supporting sentence exists.

Mark `evidence_ok` as `yes` or `no`. When `no` and a better sentence exists, paste it in
`better_sentence`.

## 3. When unsure

Mark `unsure` and write why in `notes`. Unsure rows are not guessed: they go to the
pharmacist spot-check at Gate 2 and are left out of the accuracy numbers.

## 4. Error type

For every `no`, pick one:

- `model`: Jev misread sentences it was given.
- `sections`: the right sentence is in a section the catalog does not map to this question.
- `sentences`: sentence splitting broke the meaning, for example a list item cut from its
  heading.
- `label`: the label itself is ambiguous or contradicts itself.

## 5. What the review produces (G1.4)

Per question: stance accuracy, evidence accuracy, and the count of `not_mentioned` and
`no_known_issue` swaps, each by confidence level. Confidence thresholds are set from these
numbers. `model` errors inform thresholds; `sections` and `sentences` errors are code fixes.

## Out of scope

- Aripiprazole, which Jev cannot judge yet (see PLAN.md, Jev input limit).
- Whether the canonical label is the best one for the drug. Note it in `notes` if a label
  looks wrong, but judge the label shown.
