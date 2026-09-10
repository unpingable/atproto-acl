"""Narrow JSON protocol used by the hosted BFF.

The browser and Node service never evaluate policy.  Acquisition is supplied by
the authenticated BFF, while policy compilation, consequence planning, and the
private-mute action journal remain in this package.
"""
from __future__ import annotations

from dataclasses import asdict
import json
import sys

from .labels import LabelProvider
from .model import Coverage, EvidenceSet, Observation, utcnow
from .network import Client, NetworkError
from .policy import PolicyError, compile_policy
from .runtime import build_receipt
from .store import StateError, Store


def _preview(message):
    policy = compile_policy(message["policy"])
    account = message["account"]
    state = Store(message["state"], account, "live")
    try:
        with state.lock():
            identities = message.get("identities", {})

            def resolve(actor):
                if actor.startswith("did:"):
                    return actor
                try:
                    return identities[actor]
                except KeyError as exc:
                    raise StateError(f"verified identity missing for {actor}") from exc

            configured = policy.config["account"]
            if resolve(configured) != account:
                raise StateError("policy account does not match authenticated account")
            state.pin(configured, account)
            overrides = state.overrides()
            for layer in overrides:
                for actor in policy.config[layer]:
                    did = resolve(actor)
                    state.pin(actor, did)
                    overrides[layer].add(did)
            overrides["exempt"].add(account)
            subjects = set(message.get("subjects", [])) | set(state.ledgers())
            discovery = list(message.get("discovery", []))
            client = Client(max_requests=int(message.get("max_requests", 1000)))
            providers = {}
            for alias, spec in policy.config["providers"].items():
                if spec["type"] == "atproto_labels":
                    try:
                        providers[alias] = LabelProvider(client, spec["did"], int(message.get("max_pages", 20)))
                    except (NetworkError, ValueError, KeyError, TypeError):
                        providers[alias] = None
            for source in policy.config["sources"]:
                if source["type"] != "labeled_stream":
                    continue
                provider = providers.get(source["provider"])
                found = provider.discover(state, source.get("limit", 5000)) if provider else None
                if found:
                    subjects.update(found.subjects)
                    discovery.append(asdict(found))
                else:
                    discovery.append({"subjects": [], "complete": False, "source": "labeled_stream",
                                      "reason": "publisher unavailable"})
            for values in overrides.values():
                subjects.update(values)
            acquired_observations = [Observation(**item) for item in message.get("observations", [])]
            acquired_coverage = [Coverage(**item) for item in message.get("coverage", [])]
            for alias, spec in policy.config["providers"].items():
                if spec["type"] == "external_list":
                    if not any(item.provider == spec["did"] for item in acquired_coverage):
                        acquired_coverage.extend(
                            Coverage(spec["did"], did, False, utcnow(), "external source unavailable")
                            for did in subjects
                        )
                    continue
                provider = providers.get(alias)
                if provider:
                    found = provider.collect(tuple(sorted(subjects)))
                    acquired_observations.extend(found.observations)
                    acquired_coverage.extend(found.coverage)
                elif spec["type"] == "atproto_labels":
                    acquired_coverage.extend(
                        Coverage(spec["did"], did, False, utcnow(), "publisher unavailable")
                        for did in subjects
                    )
            observations, coverage = tuple(acquired_observations), tuple(acquired_coverage)
            external_dids = {spec["did"] for spec in policy.config["providers"].values()
                             if spec["type"] == "external_list"}
            state.add_evidence(tuple(item for item in observations if item.provider not in external_dids))
            current_external = tuple(item for item in observations if item.provider in external_dids)
            evidence = EvidenceSet(
                current_external + tuple(item for did in sorted(subjects) for item in state.evidence(did)
                                         if item.provider not in external_dids),
                coverage,
            )
            remote = message.get("remote", {})
            for observed in remote.values():
                if not isinstance(observed, dict):
                    raise StateError("remote state must be an object")
                relationship = observed.get("relationship")
                if "relationship" in observed and relationship not in (
                        "following", "not_following", "unknown"):
                    raise StateError("remote relationship must be following, not_following, or unknown")
            receipt = build_receipt(
                policy,
                state,
                tuple(sorted(subjects)),
                evidence,
                discovery,
                overrides,
                remote,
                message.get("now") or utcnow(),
            )
            receipt["acquisition_hash"] = message.get("acquisition_hash")
            state.save_receipt(receipt)
            return receipt
    finally:
        state.close()


def _override(message):
    state = Store(message["state"], message["account"], "live")
    try:
        with state.lock():
            state.set_override(message["subject"], message["kind"], bool(message["enabled"]))
            return {kind: sorted(values) for kind, values in state.overrides().items()}
    finally:
        state.close()


def _list_overrides(message):
    state = Store(message["state"], message["account"], "live")
    try:
        with state.lock():
            return {kind: sorted(values) for kind, values in state.overrides().items()}
    finally:
        state.close()


def _begin(message):
    state = Store(message["state"], message["account"], "live")
    try:
        with state.lock():
            attempt = state.begin_action(message["subject"], message["action"], message["detail"])
            return {"attempt": attempt, "status": "pending"}
    finally:
        state.close()


def _finish(message):
    state = Store(message["state"], message["account"], "live")
    try:
        with state.lock():
            state.finish_action(
                int(message["attempt"]),
                message["subject"],
                message["action"],
                bool(message["success"]),
            )
            return {"attempt": int(message["attempt"]), "status": "confirmed" if message["success"] else "unresolved"}
    finally:
        state.close()


def handle(message):
    command = message.get("command")
    if command == "validate":
        policy = compile_policy(message["policy"])
        return {"policy_hash": policy.policy_hash, "source_hash": policy.source_hash,
                "config": policy.config}
    if command == "preview":
        return _preview(message)
    if command == "override":
        return _override(message)
    if command == "list_overrides":
        return _list_overrides(message)
    if command == "begin_action":
        return _begin(message)
    if command == "finish_action":
        return _finish(message)
    raise StateError("unknown host bridge command")


def main():
    try:
        message = json.load(sys.stdin)
        print(json.dumps({"ok": True, "result": handle(message)}, sort_keys=True))
        return 0
    except (PolicyError, StateError, KeyError, TypeError, ValueError, OSError) as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
