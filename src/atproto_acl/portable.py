"""Versioned transport envelope for evaluator policies and adjacent user intent."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import re
from typing import Any, Mapping

import yaml

from .model import digest
from .policy import CompiledPolicy, PolicyError, UniqueLoader, compile_policy


FORMAT = "atproto-acl.portable-policy"
FORMAT_VERSION = 1
ACCOUNT_RULES_VERSION = 1
RULE_NAMES = ("leave_alone", "always_keep", "never_unmute")
RUNTIME_NAMES = {
    "leave_alone": "exempt",
    "always_keep": "allow",
    "never_unmute": "keep_muted",
}
MAX_DOCUMENT_BYTES = 512 * 1024
_DID = re.compile(r"^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$")


def _keys(value: Any, allowed: set[str], required: set[str] = frozenset()) -> dict:
    if not isinstance(value, dict):
        raise PolicyError("portable document section must be an object")
    unknown = set(value) - allowed
    missing = required - set(value)
    if unknown:
        raise PolicyError(f"unknown portable document fields: {sorted(unknown)}")
    if missing:
        raise PolicyError(f"missing portable document fields: {sorted(missing)}")
    return value


def empty_account_rules() -> dict[str, tuple[dict[str, str], ...]]:
    return {name: () for name in RULE_NAMES}


def normalize_account_rules(value: Any) -> dict[str, tuple[dict[str, str], ...]]:
    section = _keys(value, {"version", *RULE_NAMES}, {"version", *RULE_NAMES})
    if type(section["version"]) is not int or section["version"] != ACCOUNT_RULES_VERSION:
        raise PolicyError(f"unsupported account_rules version {section.get('version')!r}")
    normalized: dict[str, tuple[dict[str, str], ...]] = {}
    for name in RULE_NAMES:
        entries = section[name]
        if not isinstance(entries, list):
            raise PolicyError(f"account_rules.{name} must be a list")
        seen: set[str] = set()
        rows: list[dict[str, str]] = []
        for entry in entries:
            row = _keys(entry, {"did", "last_known_handle"}, {"did"})
            did = row["did"]
            handle = row.get("last_known_handle")
            if not isinstance(did, str) or not _DID.fullmatch(did):
                raise PolicyError(f"account_rules.{name} requires stable DIDs")
            if did in seen:
                raise PolicyError(f"duplicate DID in account_rules.{name}: {did}")
            if handle is not None and (not isinstance(handle, str) or not handle or len(handle) > 253):
                raise PolicyError("last_known_handle must be a nonempty string no longer than 253 characters")
            seen.add(did)
            rows.append({"did": did, **({"last_known_handle": handle} if handle else {})})
        normalized[name] = tuple(sorted(rows, key=lambda item: item["did"]))
    return normalized


def runtime_account_rules(rules: Mapping[str, tuple[dict[str, str], ...]]) -> dict[str, set[str]]:
    return {
        RUNTIME_NAMES[name]: {entry["did"] for entry in rules[name]}
        for name in RULE_NAMES
    }


def account_rules_hash(rules: Mapping[str, tuple[dict[str, str], ...]]) -> str:
    return digest({RUNTIME_NAMES[name]: sorted(entry["did"] for entry in rules[name]) for name in RULE_NAMES})


def portable_behavior_hash(policy: CompiledPolicy, rules: Mapping[str, tuple[dict[str, str], ...]]) -> str:
    return digest({
        "policy": policy.config,
        "account_rules": {
            RUNTIME_NAMES[name]: sorted(entry["did"] for entry in rules[name])
            for name in RULE_NAMES
        },
    })


@dataclass(frozen=True)
class PortableDocument:
    policy: CompiledPolicy
    account_rules: dict[str, tuple[dict[str, str], ...]]
    provenance: dict[str, Any]
    enveloped: bool

    @property
    def account_rules_hash(self) -> str:
        return account_rules_hash(self.account_rules)

    @property
    def portable_behavior_hash(self) -> str:
        return portable_behavior_hash(self.policy, self.account_rules)


def _load(text: str) -> Any:
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_DOCUMENT_BYTES:
        raise PolicyError("portable document must be UTF-8 text no larger than 512 KiB")
    try:
        return yaml.load(text, Loader=UniqueLoader)
    except PolicyError:
        raise
    except yaml.MarkedYAMLError as exc:
        mark = exc.problem_mark
        where = f" at line {mark.line + 1}, column {mark.column + 1}" if mark else ""
        raise PolicyError(f"invalid YAML{where}: {exc.problem or type(exc).__name__}") from exc


def parse_portable_document(text: str) -> PortableDocument:
    root = _load(text)
    if not isinstance(root, dict) or "format" not in root:
        return PortableDocument(compile_policy(text), empty_account_rules(), {}, False)
    if root.get("format") != FORMAT:
        raise PolicyError(f"unsupported portable document format {root.get('format')!r}")
    root = _keys(root, {"format", "format_version", "provenance", "policy", "account_rules"},
                 {"format", "format_version", "provenance", "policy", "account_rules"})
    if type(root["format_version"]) is not int or root["format_version"] != FORMAT_VERSION:
        raise PolicyError(f"unsupported portable document version {root.get('format_version')!r}")
    provenance = _keys(root["provenance"], {
        "exported_at", "policy_name", "policy_revision", "exporter_version", "policy_source_hash"
    }, {"exported_at", "policy_name", "policy_revision", "exporter_version", "policy_source_hash"})
    if (not isinstance(provenance["exported_at"], str) or
            not isinstance(provenance["policy_name"], str) or
            type(provenance["policy_revision"]) is not int or provenance["policy_revision"] < 1 or
            not isinstance(provenance["exporter_version"], str) or
            not isinstance(provenance["policy_source_hash"], str) or
            not re.fullmatch(r"[0-9a-f]{64}", provenance["policy_source_hash"])):
        raise PolicyError("portable document provenance is invalid")
    if not isinstance(root["policy"], dict):
        raise PolicyError("portable document policy must be an object")
    policy_text = yaml.safe_dump(root["policy"], sort_keys=False, allow_unicode=True)
    policy = compile_policy(policy_text)
    rules = normalize_account_rules(root["account_rules"])
    return PortableDocument(policy, rules, dict(provenance), True)


def export_portable_document(*, policy_source: str, policy_name: str, policy_revision: int,
                             exporter_version: str, exported_at: str,
                             account_rules: Mapping[str, list[Mapping[str, str]]]) -> str:
    compiled = compile_policy(policy_source)
    policy_value = _load(policy_source)
    normalized = normalize_account_rules({"version": ACCOUNT_RULES_VERSION, **account_rules})
    envelope = {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "provenance": {
            "exported_at": exported_at,
            "policy_name": policy_name,
            "policy_revision": policy_revision,
            "exporter_version": exporter_version,
            "policy_source_hash": hashlib.sha256(policy_source.encode("utf-8")).hexdigest(),
        },
        "policy": policy_value,
        "account_rules": {
            "version": ACCOUNT_RULES_VERSION,
            **{name: [dict(entry) for entry in normalized[name]] for name in RULE_NAMES},
        },
    }
    # Keep the compiler call above as the authority; this assertion catches an
    # exporter change that would alter the evaluator policy while wrapping it.
    round_trip = parse_portable_document(yaml.safe_dump(envelope, sort_keys=False, allow_unicode=True))
    if round_trip.policy.policy_hash != compiled.policy_hash:
        raise PolicyError("portable export changed evaluator policy semantics")
    return yaml.safe_dump(envelope, sort_keys=False, allow_unicode=True)
