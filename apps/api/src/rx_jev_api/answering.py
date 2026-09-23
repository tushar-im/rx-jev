"""Makes sure every label has stored judgments, judging only the ones the store lacks."""

from pydantic import BaseModel

from rx_jev_api.clients.openfda import Label
from rx_jev_api.judge import Judge, JudgeRequest, build_request
from rx_jev_api.store import Store, StoredRun

__all__ = ["JudgedLabel", "judge_labels"]


class JudgedLabel(BaseModel, frozen=True):
    label: Label
    request: JudgeRequest
    # None only when no question had candidates, so there was nothing to ask Jev.
    run: StoredRun | None
    # True when this call judged the label; False when it came from the store.
    fresh: bool


def judge_labels(labels: list[Label], judge: Judge, store: Store) -> list[JudgedLabel]:
    """Stored judgments for every label. Raises JudgeError and stores nothing if Jev fails.

    Every miss is judged before any result is stored, so a failure on a later label never
    leaves an earlier label of the same drug stored on its own.
    """
    requests = [build_request(label) for label in labels]
    runs = [
        store.find(label, request.prompt_hash, judge.model)
        for label, request in zip(labels, requests, strict=True)
    ]
    results = {
        i: judge.judge(requests[i])
        for i, run in enumerate(runs)
        if run is None and requests[i].questions
    }
    for i, result in results.items():
        runs[i] = store.save(labels[i], requests[i], judge.model, result)

    return [
        JudgedLabel(label=label, request=request, run=run, fresh=i in results)
        for i, (label, request, run) in enumerate(zip(labels, requests, runs, strict=True))
    ]
