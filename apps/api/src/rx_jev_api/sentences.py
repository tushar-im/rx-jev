"""Splits label sections into numbered candidate sentences for Jev to select from.

Every candidate is a character span of the original section text, so what the UI shows is
provably verbatim. Splitting is deliberately conservative: a missed split only makes a
candidate longer, while a wrong split could cut a warning in half. OTC labels whose bullets
were lost upstream therefore stay as one candidate per section.

A bullet item often only means something with the text it hangs off: "contraindicated in
patients with: • severe renal impairment". The first sentence of each bullet item carries
that governing text as `lead_in`, also a verbatim span, and the UI must show both. openFDA
flattens nested lists, so nesting is inferred: an item ending in ":" opens an inner list,
and an item containing its own ":" ("children under 12 years: ask a doctor") belongs to the
outer list. A multi-sentence item ending in ":" starts a new list after prose.
"""

import re

from pydantic import BaseModel

from rx_jev_api.clients.openfda import Label

__all__ = ["Candidate", "Span", "label_candidates", "split_section"]

_BULLETS = re.compile(r"[•■▪●◆]")
# A sentence ends at . ! or ? followed by whitespace and an uppercase letter.
_SENTENCE_END = re.compile(r"[.!?](?=\s+[A-Z])")
_ABBREVIATIONS = {"e.g.", "i.e.", "vs.", "approx.", "dr.", "no.", "fig.", "al."}
_ABBREVIATIONS |= {"inc.", "ltd.", "pvt.", "co.", "corp.", "st.", "mr.", "mrs.", "ms.", "jr."}
# Initialisms such as U.S. or U.S.P.
_INITIALISM = re.compile(r"(?:[a-z]\.){2,}")
_LETTER = re.compile(r"[A-Za-z]")


class Span(BaseModel, frozen=True):
    text: str
    # Offsets into the section text: text == section_text[start:end].
    start: int
    end: int


class Candidate(Span, frozen=True):
    id: str
    section: str
    # Governing text for a bullet item; None for prose and non-first item sentences.
    lead_in: Span | None


def split_section(section: str, text: str) -> list[Candidate]:
    candidates: list[Candidate] = []
    outer: Span | None = None  # lead-in of the current top-level list
    inner: Span | None = None  # lead-in of a nested list opened by an item ending in ":"

    for index, (seg_start, seg_end) in enumerate(_bullet_items(text)):
        sentences = [
            Span(text=text[start:end], start=start, end=end)
            for start, end in (_strip(text, *span) for span in _sentences(text, seg_start, seg_end))
            if _LETTER.search(text, start, end)
        ]
        if not sentences:
            continue

        for n, sentence in enumerate(sentences):
            lead_in = None
            if index > 0 and n == 0:
                lead_in = outer if inner is None or ":" in sentence.text else inner
            candidates.append(
                Candidate(
                    id=f"{section}:{len(candidates) + 1}",
                    section=section,
                    text=sentence.text,
                    start=sentence.start,
                    end=sentence.end,
                    lead_in=lead_in,
                )
            )

        last = sentences[-1]
        if index == 0 or (len(sentences) > 1 and last.text.endswith(":")):
            outer, inner = last, None
        elif last.text.endswith(":"):
            inner = last
    return candidates


def label_candidates(label: Label, sections: list[str]) -> list[Candidate]:
    return [c for name in sections for c in split_section(name, label.sections.get(name, ""))]


def _bullet_items(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    piece_start = 0
    for match in _BULLETS.finditer(text):
        spans.append((piece_start, match.start()))
        piece_start = match.end()
    spans.append((piece_start, len(text)))
    return spans


def _sentences(text: str, start: int, end: int) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    piece_start = start
    for match in _SENTENCE_END.finditer(text, start, end):
        if _is_abbreviation(text, piece_start, match.end()):
            continue
        spans.append((piece_start, match.end()))
        piece_start = match.end()
    spans.append((piece_start, end))
    return spans


def _is_abbreviation(text: str, start: int, stop: int) -> bool:
    word_start = max(text.rfind(" ", start, stop), text.rfind("\n", start, stop)) + 1
    word = text[max(word_start, start) : stop].lower()
    return word in _ABBREVIATIONS or _INITIALISM.fullmatch(word) is not None


def _strip(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end
