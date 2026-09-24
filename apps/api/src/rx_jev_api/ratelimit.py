"""Sliding-window rate limits per client, kept in memory.

Every custom question calls Jev live, so asks are limited per client. The counts live in
this process only: they reset on restart and are not shared between workers. A deployment
with several workers, or behind a proxy that hides client addresses, needs a shared store
and the forwarded address instead.
"""

import time
from collections import deque
from collections.abc import Callable, Sequence
from threading import Lock

from pydantic import BaseModel, Field

__all__ = ["Limit", "RateLimiter"]


class Limit(BaseModel, frozen=True):
    count: int = Field(ge=1)
    seconds: float = Field(gt=0)


class RateLimiter:
    def __init__(
        self, limits: Sequence[Limit], clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._limits = list(limits)
        self._clock = clock
        self._span = max((limit.seconds for limit in self._limits), default=0.0)
        self._hits: dict[str, deque[float]] = {}
        self._lock = Lock()

    def hit(self, key: str) -> float | None:
        """Counts a hit for `key`, or, if a limit is spent, returns the seconds until it
        frees up and counts nothing."""
        with self._lock:
            now = self._clock()
            self._forget(now)
            hits = self._hits.get(key, deque())
            waits = [
                hits[-limit.count] + limit.seconds - now
                for limit in self._limits
                if _recent(hits, now, limit.seconds) >= limit.count
            ]
            if waits:
                return max(waits)
            hits.append(now)
            self._hits[key] = hits
            return None

    def clients(self) -> int:
        """Clients with a hit still inside some window."""
        with self._lock:
            self._forget(self._clock())
            return len(self._hits)

    def _forget(self, now: float) -> None:
        for key in list(self._hits):
            hits = self._hits[key]
            while hits and hits[0] <= now - self._span:
                hits.popleft()
            if not hits:
                del self._hits[key]


def _recent(hits: deque[float], now: float, seconds: float) -> int:
    return sum(1 for t in hits if t > now - seconds)
