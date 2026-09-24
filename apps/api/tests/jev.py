"""A stand-in for the TypeSafe API. Unit tests never call the real Jev.

`FakeJev` answers every Choice question with a peaked distribution over its criteria and
records each request body, so tests can check what was sent.
"""

import json
from collections.abc import Callable
from typing import Any

import httpx2
from typesafe_sdk import RetryPolicy, TypeSafeClient

MODEL_VERSION = "jev-1.13.0"

# Picks the option to peak on, given the question key and its option names.
Picker = Callable[[str, list[str]], str]


def first_option(key: str, options: list[str]) -> str:
    return options[0]


class FakeJev:
    def __init__(
        self,
        pick: Picker = first_option,
        status: int = 200,
        drop: set[str] | None = None,
        confidence: Callable[[str], float] | None = None,
    ) -> None:
        self.pick = pick
        self.status = status
        self.drop = drop or set()  # question keys to leave unanswered
        # Confidence per question key; 0.8 for every question unless given.
        self.confidence = confidence or (lambda key: 0.8)
        self.requests: list[dict[str, Any]] = []

    def client(self) -> TypeSafeClient:
        return TypeSafeClient(
            api_key="test-key",
            transport=httpx2.MockTransport(self._handle),
            retry=RetryPolicy(max_retries=0),
        )

    def _handle(self, request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        if self.status != 200:
            return httpx2.Response(self.status, json={"error": "overloaded"})
        answers = {
            key: self._answer(key, q)
            for key, q in body["questions"].items()
            if key not in self.drop
        }
        return httpx2.Response(
            200,
            json={
                "model": MODEL_VERSION,
                "answers": answers,
                "usage": {"input_tokens": 1234, "output_tokens": 56},
            },
        )

    def _answer(self, key: str, question: dict[str, Any]) -> dict[str, Any]:
        options = list(question["criteria"])
        choice = self.pick(key, options)
        rest = [o for o in options if o != choice]
        probabilities = {o: 0.1 / len(rest) for o in rest} | {choice: 0.9}
        return {
            "type": "choice",
            "choice": choice,
            "probabilities": probabilities,
            "confidence": self.confidence(key),
        }
