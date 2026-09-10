"""Immutable evidence, coverage, policy result, and capability contracts."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Protocol


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def timestamp(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("timestamps must include a timezone")
    return dt.astimezone(timezone.utc)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class Truth(str, Enum):
    TRUE = "true"
    FALSE = "false"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Observation:
    provider: str
    subject: str
    property: str
    value: Any
    observed_at: str
    expires_at: str | None = None
    negated: bool = False
    evidence_id: str = ""
    provider_id: str | None = None
    raw_json: str = "{}"
    retrieved_at: str = ""
    provenance: str = ""

    def __post_init__(self):
        timestamp(self.observed_at)
        if self.expires_at:
            if timestamp(self.expires_at) < timestamp(self.observed_at):
                raise ValueError("expiry precedes observation")
        if not self.evidence_id:
            object.__setattr__(self, "evidence_id", digest({
                "provider": self.provider, "subject": self.subject,
                "property": self.property, "value": self.value,
                "observed_at": timestamp(self.observed_at).isoformat(),
                "expires_at": timestamp(self.expires_at).isoformat() if self.expires_at else None,
                "negated": self.negated,
            }))


@dataclass(frozen=True)
class Coverage:
    provider: str
    subject: str
    complete: bool
    checked_at: str
    reason: str = ""


@dataclass(frozen=True)
class EvidenceSet:
    observations: tuple[Observation, ...] = ()
    coverage: tuple[Coverage, ...] = ()


@dataclass(frozen=True)
class Decision:
    subject: str
    outcome: str
    basis: str
    matches: tuple[str, ...]
    unresolved: tuple[str, ...]
    rules: tuple[dict, ...]
    evidence_ids: tuple[str, ...]
    disagreements: bool = False
    reason_codes: tuple[str, ...] = ()


@dataclass(frozen=True)
class Discovery:
    subjects: tuple[str, ...]
    complete: bool
    source: str
    cursor: str | None = None
    reason: str = ""


@dataclass(frozen=True)
class Capabilities:
    can_apply: bool
    can_release: str
    can_prove_ownership: bool
    can_observe_state: bool
    write_idempotency: str


class AccountSource(Protocol):
    def discover(self, spec: dict) -> Discovery: ...


class ObservationProvider(Protocol):
    def collect(self, subjects: tuple[str, ...]) -> EvidenceSet: ...


class ActionAdapter(Protocol):
    capabilities: Capabilities
    def observe(self, subjects: tuple[str, ...]) -> dict[str, dict]: ...
    def apply(self, subject: str) -> None: ...
    def release(self, subject: str) -> None: ...
