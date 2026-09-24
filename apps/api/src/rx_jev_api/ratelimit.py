"""Sliding-window rate limits per client, kept in memory.

Every custom question calls Jev live, so asks are limited per client. The counts live in
this process only: they reset on restart and are not shared between workers. A deployment
with several workers, or behind a proxy that hides client addresses, needs a shared store
and the forwarded address instead.
"""

import itertools
import time
from collections import deque
from collections.abc import Callable, Sequence
from threading import Lock

from pydantic import BaseModel, Field

__all__ = ["Limit", "RateLimiter", "Slot"]


class Limit(BaseModel, frozen=True):
    count: int = Field(ge=1)
    seconds: float = Field(gt=0)


class Slot(BaseModel, frozen=True):
    """One counted hit, held by the request that made it so it can give back exactly it."""

    key: str
    id: int
    at: float


class RateLimiter:
    def __init__(
        self, limits: Sequence[Limit], clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._limits = list(limits)
        self._clock = clock
        self._span = max((limit.seconds for limit in self._limits), default=0.0)
        self._hits: dict[str, deque[Slot]] = {}
        self._ids = itertools.count()
        self._lock = Lock()

    def acquire(self, key: str) -> Slot | float:
        """Counts a hit for `key` and returns its slot, or, if a limit is spent, returns the
        seconds until it frees up and counts nothing."""
        with self._lock:
            now = self._clock()
            self._forget(now)
            hits = self._hits.get(key, deque())
            wait = self._wait(hits, now)
            if wait is not None:
                return wait
            slot = Slot(key=key, id=next(self._ids), at=now)
            hits.append(slot)
            self._hits[key] = hits
            return slot

    def hit(self, key: str) -> float | None:
        """Like `acquire`, for a caller that never gives its slot back."""
        result = self.acquire(key)
        return None if isinstance(result, Slot) else result

    def release(self, slot: Slot) -> None:
        """Takes back exactly this slot, for a request that turned out not to count. Other
        requests' slots are untouched; a slot already released or expired is ignored."""
        with self._lock:
            hits = self._hits.get(slot.key)
            if hits is None:
                return
            remaining = deque(h for h in hits if h.id != slot.id)
            if remaining:
                self._hits[slot.key] = remaining
            else:
                del self._hits[slot.key]

    def clients(self) -> int:
        """Clients with a hit still inside some window."""
        with self._lock:
            self._forget(self._clock())
            return len(self._hits)

    def _wait(self, hits: deque[Slot], now: float) -> float | None:
        waits = [
            hits[-limit.count].at + limit.seconds - now
            for limit in self._limits
            if _recent(hits, now, limit.seconds) >= limit.count
        ]
        return max(waits, default=None)

    def _forget(self, now: float) -> None:
        for key in list(self._hits):
            hits = self._hits[key]
            while hits and hits[0].at <= now - self._span:
                hits.popleft()
            if not hits:
                del self._hits[key]


def _recent(hits: deque[Slot], now: float, seconds: float) -> int:
    return sum(1 for h in hits if h.at > now - seconds)
