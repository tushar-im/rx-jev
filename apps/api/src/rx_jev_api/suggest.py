"""Drug name suggestions for the search box, matched against RxNorm's display names.

RxNorm's approximate search does not match partial words, so suggestions come from its
display name list: names starting with the query first, then names with a word starting
with it (so "metf" finds "glipiZIDE / metFORMIN"). Case is ignored; RxNorm keeps tall-man
lettering such as "metFORMIN", which is shown as is.
"""

import re
from collections.abc import Sequence

__all__ = ["suggest"]


def suggest(names: Sequence[str], query: str, limit: int = 10) -> list[str]:
    needle = query.strip().lower()
    if not needle:
        return []
    word = re.compile(rf"(?<![a-z0-9]){re.escape(needle)}")
    prefix: list[str] = []
    within: list[str] = []
    for name in names:
        lower = name.lower()
        if lower.startswith(needle):
            prefix.append(name)
        elif word.search(lower):
            within.append(name)
    ranked = sorted(prefix, key=_rank) + sorted(within, key=_rank)
    return ranked[:limit]


def _rank(name: str) -> tuple[int, str]:
    return len(name), name.lower()
