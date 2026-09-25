# Demo script: 75-second product video

A recorded screen demo for LinkedIn and X, in 16:9. Most feed video plays muted, so the
captions carry the story; the voice-over is optional.

The layout has three columns: the search and question chips on the left, the answer in the
middle, and "How this answer was made" on the right. The red demo caution strip stays on
screen in every shot. Keep it there; it's part of the message.

Every beat below uses a label whose stored answers match the current prompt hash, checked on
2026-09-24. Stored answers load without calling Jev. The custom questions were tested live
on the same label.

## Beats

| Time | Screen | Caption (burned in) |
|---|---|---|
| 0:00 | Empty app. The right panel explains the pipeline. | A drug label can run 30 pages. Find the sentence that matters. |
| 0:05 | Type `tylenol`, pick **tylenol pm** from the suggestions. Cut the openFDA wait (about 5 s). | Search by brand or generic name. |
| 0:12 | Tap **Pregnancy**. Hold on the card: "The label advises caution" and the quote *If pregnant or breast-feeding, ask a health professional before use.* | Word for word from the official FDA label. Never paraphrased. |
| 0:20 | Zoom on the footer: label version 9, effective date, "Read the full label on DailyMed". | Every answer names its label version and links to the source. |
| 0:26 | *Optional, cut first if long.* Tap **Blood thinners**. Quote: *Ask a doctor or pharmacist before use if you are taking the blood thinning drug warfarin taking sedatives or tranquilizers* (two OTC bullets run together, still verbatim). | |
| 0:32 | Tap **Liver disease**. Card: "We couldn't find a clear answer. Read the full label or ask a pharmacist." The panel says Jev read 11 sentences and the answer is below the display threshold, with no guess shown. | When it isn't sure, it says so instead of guessing. |
| 0:40 | Type in the question box: `Can I take it with other medicines that contain acetaminophen?` and press Ask. Card: "The label warns against use", quote *Do not use with any other drug containing acetaminophen (prescription or nonprescription).* Pan to the panel: "Jev picked 1 of 16 sentences from 7 sections", "Asked live". | Ask your own question. Same rule: only the label's own words. |
| 0:52 | New search: `wellbutrin`. Tap **Drowsiness and driving**. Quote: *...they should refrain from driving an automobile or operating complex, hazardous machinery.* Zoom on the panel: "Jev picked 1 of 99 sentences". | Prescription labels too. Jev picks the sentence; it never writes one. |
| 1:02 | Hold on the panel's session total, then the end card (added in the edit). | rx-jev shows what the label says. It is not medical advice: ask your pharmacist. Label reading by TypeSafe Jev. |

Keep the "Not yet checked by a pharmacist" line visible on the cards. It is honest and it
fits the message.

Panel numbers checked live on 2026-09-24 (openFDA totals drift as labels are added):
- **Tylenol PM (OTC):** openFDA matched 196 original-packager labels. Stored run: 14,084 Jev tokens. Pregnancy was picked from 1 sentence, so don't zoom on the panel there.
- **Wellbutrin (prescription):** 68 original-packager labels. Drowsiness and driving: 1 of 99 sentences.
- **Custom question on Tylenol PM:** 1 of 16 sentences from 7 sections, about 2.1K input tokens.
- **RxNorm and openFDA:** took 2 to 8 s per search today. Cut these waits in the edit.

### Tested answers behind each beat

| Beat | Label | Stance, confidence | Shown |
|---|---|---|---|
| Pregnancy | Pain Reliever PM Extra Strength, OTC v9 | caution 1.00 | yes |
| Blood thinners | same | caution 1.00 | yes |
| Liver disease | same | caution 0.73 | no, so the no-clear-answer state appears |
| Custom: other acetaminophen | same, live | warns_against 1.00, evidence 0.99 | yes |
| Drowsiness and driving | Bupropion Hydrochloride, prescription v23 | caution 0.90 | yes |

Backups if a beat changes on the day:
- **Custom question:** "Will it make me drowsy?" (caution 0.91, shown).
- **Prescription beat:** `ativan`, then **Glaucoma** (warns_against 0.98). Its quote starts with the merged heading "CONTRAINDICATIONS", a known Gate 1 follow-up, so it's the weaker shot.

Avoid these on camera:
- **Tylenol PM, Allergy:** its quote has a lead-in from another item (Gate 1 follow-up).
- **Tylenol PM, Children:** it merges two items.
- **Advil and metformin:** their stored answers are stale, so they re-judge live (up to a minute), and metformin has no confident answers.
- **"Can I drink alcohol while taking it?":** it came back at 0.87, so nothing is shown.

## Before recording

1. **Run the app on `main` with the existing `apps/api/rx_jev.db`:** `make -j2 dev`. Do not delete or move the database.
2. **Do one full dry run of every beat.**
   - If openFDA has published a newer label version since 2026-09-24, the dry run absorbs the re-judge (about 11K tokens for Tylenol PM, 42K for Wellbutrin) and stores it, so the recording stays fast.
   - Check that each card still matches the table above.
3. **Custom questions call Jev on every take (about 2.1K tokens each).**
   - The limit is 5 asks a minute and 50 a day per client. Pace the retakes.
   - Or set `ASK_PER_MINUTE=20` in `apps/api/.env` for the session, and remove it afterwards.
4. **Browser:** use a clean profile, one tab and no bookmarks bar. Set the window to 1600x900 at 100% zoom, so all three columns show. Keep the panel open, and pick light or dark mode and keep it for every take.
5. **Record and edit.** Record at 60 fps. In the edit:
   - Cut the openFDA and Jev waits.
   - Burn in the captions.
   - Export 1920x1080. Three columns need the width; zoom into the card or panel for the beats that call for it.

## Wording and brand checks

- **Captions and post copy follow the product guardrails:** never "safe", "allowed", "OK to take", or anything that sounds like advice for one person. Say what the label says.
- **Searching "tylenol pm" shows a store-brand label with the same ingredients** (Pain Reliever PM Extra Strength), not Tylenol's own. Don't caption it as Tylenol's label. Wellbutrin likewise shows the generic bupropion label.
- **rx-jev is a public demo that launched before the Gate 2 review.** So:
  - Call it a prototype.
  - Keep the "not medical advice" line in both the video and the post.

## Draft post

> Drug labels are long. rx-jev finds what the official FDA label says about a question,
> such as pregnancy, blood thinners or driving, and quotes it word for word with a link to
> the full label. When it isn't sure, it says so.
>
> A prototype built with TypeSafe Jev, which picks the label's own sentence instead of
> writing an answer. It shows label text only and is not medical advice: ask your
> pharmacist about your own situation.
