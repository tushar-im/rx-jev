import pytest

from rx_jev_api.ratelimit import Limit, RateLimiter, Slot


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


def test_allows_up_to_the_limit_then_says_how_long_to_wait(clock: Clock) -> None:
    limiter = RateLimiter([Limit(count=2, seconds=60)], clock=clock)
    assert limiter.hit("a") is None
    clock.now += 10
    assert limiter.hit("a") is None
    clock.now += 5
    # The oldest hit leaves the window 60 s after it was made, 45 s from now.
    assert limiter.hit("a") == pytest.approx(45)


def test_the_window_slides(clock: Clock) -> None:
    limiter = RateLimiter([Limit(count=1, seconds=60)], clock=clock)
    assert limiter.hit("a") is None
    clock.now += 60
    assert limiter.hit("a") is None


def test_rejected_hits_do_not_count(clock: Clock) -> None:
    limiter = RateLimiter([Limit(count=1, seconds=60)], clock=clock)
    limiter.hit("a")
    for _ in range(5):
        clock.now += 10
        assert limiter.hit("a") is not None
    clock.now += 10
    assert limiter.hit("a") is None


def test_acquire_returns_a_slot_or_how_long_to_wait(clock: Clock) -> None:
    limiter = RateLimiter([Limit(count=1, seconds=60)], clock=clock)
    assert isinstance(limiter.acquire("a"), Slot)
    clock.now += 15
    assert limiter.acquire("a") == pytest.approx(45)


def test_release_takes_back_only_its_own_slot(clock: Clock) -> None:
    limiter = RateLimiter([Limit(count=2, seconds=60)], clock=clock)
    first = limiter.acquire("a")
    clock.now += 10
    assert isinstance(limiter.acquire("a"), Slot)
    assert isinstance(first, Slot)
    # The earlier request gives its slot back while the later one still holds its own.
    limiter.release(first)
    assert limiter.hit("a") is None
    # Only the later hits remain, so the window frees 60 s after them, not 50 s.
    assert limiter.hit("a") == pytest.approx(60)


def test_releasing_twice_or_after_expiry_does_nothing(clock: Clock) -> None:
    limiter = RateLimiter([Limit(count=1, seconds=60)], clock=clock)
    slot = limiter.acquire("a")
    assert isinstance(slot, Slot)
    limiter.release(slot)
    limiter.release(slot)
    assert limiter.clients() == 0
    assert limiter.hit("a") is None
    clock.now += 61
    limiter.release(slot)
    assert limiter.hit("a") is None


def test_clients_are_counted_apart(clock: Clock) -> None:
    limiter = RateLimiter([Limit(count=1, seconds=60)], clock=clock)
    assert limiter.hit("a") is None
    assert limiter.hit("b") is None
    assert limiter.hit("a") is not None


def test_every_limit_applies(clock: Clock) -> None:
    limiter = RateLimiter([Limit(count=2, seconds=60), Limit(count=3, seconds=3_600)], clock=clock)
    for _ in range(3):
        assert limiter.hit("a") is None
        clock.now += 60
    # Under the minute limit, but the hourly one is spent until the first hit is an hour old.
    assert limiter.hit("a") == pytest.approx(3_600 - 180)


def test_forgets_clients_with_no_hits_in_any_window(clock: Clock) -> None:
    limiter = RateLimiter([Limit(count=1, seconds=60)], clock=clock)
    limiter.hit("a")
    clock.now += 61
    limiter.hit("b")
    assert limiter.clients() == 1
