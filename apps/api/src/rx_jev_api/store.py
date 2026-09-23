"""Stores Jev's full distributions per label version, so each label is judged once.

A run is keyed by label `set_id` and `version`, the request's prompt hash, and the requested
model. Any change to the label text, the questions, or the pinned model misses the store and
triggers a fresh run. Verdicts are not stored: they are derived at read time, so thresholds
can change after the Gate 1 review without re-running inference.
"""

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel
from sqlalchemy import JSON, Column, UniqueConstraint
from sqlalchemy.exc import IntegrityError
from sqlmodel import Field, Session, SQLModel, select

from rx_jev_api.clients.openfda import Label
from rx_jev_api.judge import Distribution, JudgeRequest, JudgeResult, Kind, question_key

__all__ = ["JudgeRun", "JudgmentRecord", "LabelRecord", "Store", "StoredJudgment", "StoredRun"]


def _now() -> datetime:
    return datetime.now(UTC)


class LabelRecord(SQLModel, table=True):
    __tablename__ = "label"

    set_id: str = Field(primary_key=True)
    version: str = Field(primary_key=True)
    raw: dict[str, Any] = Field(sa_column=Column(JSON, nullable=False))
    fetched_at: datetime = Field(default_factory=_now)


class JudgeRun(SQLModel, table=True):
    __tablename__ = "judge_run"
    __table_args__ = (UniqueConstraint("set_id", "version", "prompt_hash", "model"),)

    id: int | None = Field(default=None, primary_key=True)
    set_id: str = Field(index=True)
    version: str
    prompt_hash: str
    model: str  # as requested, the lookup key
    model_version: str  # as reported by Jev
    latency_ms: int
    input_tokens: int | None
    output_tokens: int | None
    created_at: datetime = Field(default_factory=_now)


class JudgmentRecord(SQLModel, table=True):
    __tablename__ = "judgment"

    id: int | None = Field(default=None, primary_key=True)
    run_id: int = Field(foreign_key="judge_run.id", index=True)
    question_id: str
    kind: str
    choice: str
    confidence: float
    probabilities: dict[str, float] = Field(sa_column=Column(JSON, nullable=False))
    reviewed: bool = False


class StoredJudgment(BaseModel, frozen=True):
    distribution: Distribution
    reviewed: bool


class StoredRun(BaseModel, frozen=True):
    id: int
    prompt_hash: str
    model: str
    model_version: str
    latency_ms: int
    input_tokens: int | None
    output_tokens: int | None
    created_at: datetime
    # Keyed by question_key(question_id, kind).
    judgments: dict[str, StoredJudgment]


class Store:
    def __init__(self, session: Session) -> None:
        self._session = session

    def find(self, label: Label, prompt_hash: str, model: str) -> StoredRun | None:
        run = self._session.exec(
            select(JudgeRun).where(
                JudgeRun.set_id == label.set_id,
                JudgeRun.version == label.version,
                JudgeRun.prompt_hash == prompt_hash,
                JudgeRun.model == model,
            )
        ).first()
        return self._load(run) if run else None

    def save(
        self, label: Label, request: JudgeRequest, model: str, result: JudgeResult
    ) -> StoredRun:
        existing = self.find(label, request.prompt_hash, model)
        if existing:
            return existing

        self._ensure_label(label)
        run = JudgeRun(
            set_id=label.set_id,
            version=label.version,
            prompt_hash=request.prompt_hash,
            model=model,
            model_version=result.model_version,
            latency_ms=result.latency_ms,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
        )
        self._session.add(run)
        try:
            self._session.flush()
        except IntegrityError:
            # The label row is already committed, so this can only be the run key: another
            # writer stored the same run first. Serve that one.
            self._session.rollback()
            stored = self.find(label, request.prompt_hash, model)
            if stored is None:
                raise
            return stored

        assert run.id is not None
        for key, distribution in result.distributions.items():
            question_id, kind = _split_key(key)
            self._session.add(
                JudgmentRecord(
                    run_id=run.id,
                    question_id=question_id,
                    kind=kind,
                    choice=distribution.choice,
                    confidence=distribution.confidence,
                    probabilities=distribution.probabilities,
                )
            )
        self._session.commit()
        return self._load(run)

    def _ensure_label(self, label: Label) -> None:
        """Commit the label row on its own, so a conflict on it never fails a run's save.

        Writers judging one label version under different prompt hashes or models share
        this row. Whoever inserts it second hits the primary key; the row is there either
        way, so that conflict is resolved here before the run is written.
        """
        if self._session.get(LabelRecord, (label.set_id, label.version)) is not None:
            return
        self._session.add(
            LabelRecord(
                set_id=label.set_id, version=label.version, raw=label.model_dump(mode="json")
            )
        )
        try:
            self._session.commit()
        except IntegrityError:
            self._session.rollback()

    def label(self, set_id: str, version: str) -> Label | None:
        record = self._session.get(LabelRecord, (set_id, version))
        return Label.model_validate(record.raw) if record else None

    def _load(self, run: JudgeRun) -> StoredRun:
        assert run.id is not None
        rows = self._session.exec(select(JudgmentRecord).where(JudgmentRecord.run_id == run.id))
        return StoredRun(
            id=run.id,
            prompt_hash=run.prompt_hash,
            model=run.model,
            model_version=run.model_version,
            latency_ms=run.latency_ms,
            input_tokens=run.input_tokens,
            output_tokens=run.output_tokens,
            created_at=run.created_at,
            judgments={
                question_key(row.question_id, _as_kind(row.kind)): StoredJudgment(
                    distribution=Distribution(
                        choice=row.choice,
                        confidence=row.confidence,
                        probabilities=row.probabilities,
                    ),
                    reviewed=row.reviewed,
                )
                for row in rows
            },
        )


def _split_key(key: str) -> tuple[str, Kind]:
    question_id, _, kind = key.rpartition(".")
    return question_id, _as_kind(kind)


def _as_kind(value: str) -> Kind:
    if value == "stance" or value == "evidence":
        return value
    raise ValueError(f"Not a judgment kind: {value}")
