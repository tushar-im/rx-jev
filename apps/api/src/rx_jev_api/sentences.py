"""Splits label sections into numbered candidate sentences for Jev to select from.

Every candidate is a character span of the original section text, so what the UI shows is
provably verbatim. Splitting is deliberately conservative: a missed split only makes a
candidate longer, while a wrong split could cut a warning in half. OTC labels whose bullets
were lost upstream therefore stay as one candidate per section.
"""

import re

from pydantic import BaseModel

from rx_jev_api.clients.openfda import Label

__all__ = ["Candidate", "label_candidates", "split_section"]

_BULLETS = re.compile(r"[•■▪●◆]")
# A sentence ends at . ! or ? followed by whitespace and an uppercase letter.
_SENTENCE_END = re.compile(r"[.!?](?=\s+[A-Z])")
_ABBREVIATIONS = {"e.g.", "i.e.", "vs.", "approx.", "dr.", "no.", "fig.", "al."}
_LETTER = re.compile(r"[A-Za-z]")


class Candidate(BaseModel, frozen=True):
    id: str
    section: str
    text: str
    # Offsets into the section text: text == section_text[start:end].
    start: int
    end: int


def split_section(section: str, text: str) -> list[Candidate]:
    spans: list[tuple[int, int]] = []
    for seg_start, seg_end in _bullet_items(text):
        spans.extend(_sentences(text, seg_start, seg_end))

    candidates: list[Candidate] = []
    for start, end in spans:
        start, end = _strip(text, start, end)
        if _LETTER.search(text, start, end):
            candidates.append(
                Candidate(
                    id=f"{section}:{len(candidates) + 1}",
                    section=section,
                    text=text[start:end],
                    start=start,
                    end=end,
                )
            )
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
    return text[max(word_start, start) : stop].lower() in _ABBREVIATIONS


def _strip(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end
