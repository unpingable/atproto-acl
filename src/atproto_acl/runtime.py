"""Shared orchestration for CLI and future UI; explicit write authorization."""
from __future__ import annotations

from dataclasses import asdict
import json
from uuid import uuid4

from .adapters import PrivateMuteAdapter, plan_action
from .labels import LabelProvider
from .model import Coverage, EvidenceSet, Observation, digest, utcnow
from .network import NetworkError, resolve
from .policy import compile_policy, evaluate
from .sources import Sources
from .receipts import add_context, disposition_reasons, set_completeness
from .store import StateError


def resolve_overrides(policy, store, resolver):
    overrides = store.overrides()
    for layer in overrides:
        for actor in policy.config[layer]:
            did = resolver(actor)
            store.pin(actor, did)
            overrides[layer].add(did)
    overrides["exempt"].add(store.account)
    return overrides


def prepare(policy, store, client, session=None, fixture=None, max_pages=20):
    config = policy.config
    resolver = (lambda actor: actor if actor.startswith("did:") else fixture.get("identities", {})[actor]) if fixture else lambda actor: resolve(client, actor)
    overrides = resolve_overrides(policy, store, resolver)
    if fixture is not None:
        if fixture.get("version") != 1 or fixture.get("account") != store.account:
            raise StateError("fixture version/account mismatch")
        observations = tuple(Observation(**x) for x in fixture.get("observations", []))
        store.add_evidence(observations)
        subjects = set(fixture.get("subjects", [])) | set(store.ledgers())
        for layer in overrides.values():
            subjects.update(layer)
        evidence = EvidenceSet(tuple(x for did in sorted(subjects) for x in store.evidence(did)),
                               tuple(Coverage(**x) for x in fixture.get("coverage", [])))
        return tuple(sorted(subjects)), evidence, fixture.get("discovery", []), overrides, fixture.get("remote", {})
    if any(source["type"] == "feed_exposure" for source in config["sources"]):
        raise StateError("feed_exposure requires an acquisition adapter that records exposure provenance")
    providers, errors = {}, {}
    for alias, spec in config["providers"].items():
        if spec["type"] != "atproto_labels":
            raise StateError("fixture providers require --fixture and cannot enforce")
        try:
            providers[alias] = LabelProvider(client, spec["did"], max_pages)
        except (NetworkError, ValueError, KeyError, TypeError):
            errors[alias] = "publisher identity or endpoint unavailable"
    sources = Sources(client, store.account, store, providers, session, max_pages)
    discoveries = [sources.discover(spec) for spec in config["sources"]]
    subjects = {did for item in discoveries for did in item.subjects} | set(store.ledgers())
    for layer in overrides.values():
        subjects.update(layer)
    subjects = tuple(sorted(subjects))
    coverage = []
    for alias, spec in config["providers"].items():
        if alias in providers:
            evidence = providers[alias].collect(subjects)
            store.add_evidence(evidence.observations)
            coverage.extend(evidence.coverage)
        else:
            coverage.extend(Coverage(spec["did"], did, False, utcnow(), errors[alias]) for did in subjects)
    observations = tuple(x for did in subjects for x in store.evidence(did))
    adapter = PrivateMuteAdapter(session) if session else None
    remote = adapter.observe(subjects) if adapter else {}
    return subjects, EvidenceSet(observations, tuple(coverage)), [asdict(x) for x in discoveries], overrides, remote


def _followed_policy(policy, discovery, subject):
    """Return an explicitly requested followed-account policy for this exposure."""
    configured = [source for source in policy.config["sources"]
                  if source["type"] == "feed_exposure" and source.get("followed") == "review"]
    for observed in discovery:
        if (observed.get("source") != "feed_exposure" or
                subject not in observed.get("subjects", ())):
            continue
        for source in configured:
            if observed.get("surface") != source["surface"]:
                continue
            if source["surface"] == "generator" and observed.get("feed_uri") != source["feed_uri"]:
                continue
            return "review"
    return None


def build_receipt(policy, store, subjects, evidence, discovery, overrides, remote, now):
    ledgers = store.ledgers()
    rows = []
    for did in subjects:
        decision = evaluate(policy, evidence, did, now)
        layer = {kind: did in values for kind, values in overrides.items()}
        row = plan_action(decision, remote.get(did, {"known": False}), ledgers.get(did, {}), layer,
                          _followed_policy(policy, discovery, did))
        row["evaluation"] = asdict(decision)
        previous = store.attributed_receipt(did, ledgers.get(did, {}))
        row.update(disposition_reasons(row, decision, previous))
        rows.append(row)
    ids = {eid for row in rows for eid in row["evaluation"]["evidence_ids"]}
    receipt = {"schema": 1, "id": str(uuid4()), "account": store.account,
            "evidence_mode": store.evidence_mode,
            "policy_hash": policy.policy_hash, "policy": policy.config,
            "override_hash": digest({k: sorted(v) for k, v in overrides.items()}),
            "evaluated_at": now, "created_at": utcnow(), "mode": "preview",
            "adapter": "private_mute", "capabilities": asdict(PrivateMuteAdapter.capabilities),
            "discovery": discovery, "coverage": [asdict(c) for c in evidence.coverage],
            "identities": store.identities(),
            "evidence": [asdict(x) for x in evidence.observations if x.evidence_id in ids],
            "rows": rows, "executions": []}
    add_context(receipt, policy, overrides, ledgers)
    set_completeness(receipt)
    return receipt


def execute(receipt, store, adapter, release=None, selected=(), max_actions=100, clock=utcnow):
    """Caller holds the state lock. Re-observe immediately before each effect."""
    if store.evidence_mode != "live" or receipt.get("fixture"):
        raise StateError("fixture evidence cannot enforce")
    if not adapter.capabilities.can_observe_state:
        raise StateError("adapter cannot observe the state required for reconciliation")
    if release is None and not adapter.capabilities.can_apply:
        raise StateError("adapter does not permit application")
    if release is not None and adapter.capabilities.can_release in ("never", "unsupported", ""):
        raise StateError("adapter does not permit release")
    rows = receipt["rows"]
    release_mode = release is not None
    if release_mode:
        if release.get("fixture"):
            raise StateError("fixture proposals cannot authorize releases")
        if not selected:
            raise StateError("release requires explicit --did selections")
        if not release.get("effective_config_hash"):
            raise StateError("legacy release proposal lacks effective context; review a new preview")
        if any(release.get(k) != receipt.get(k) for k in
               ("account", "policy_hash", "override_hash", "effective_config_hash")):
            raise StateError("release proposal policy/account/overrides changed; review a new preview")
        previous = {r["subject"]: r for r in release["rows"]}
        current = {r["subject"]: r for r in rows}
        for did in selected:
            if did not in previous or did not in current or previous[did]["action"] != "release_candidate" or current[did]["action"] != "release_candidate":
                raise StateError("selected DID is not a current reviewed release candidate")
            if previous[did]["fingerprint"] != current[did]["fingerprint"]:
                raise StateError("release conditions changed; review a new preview")
        candidates = [current[did] for did in sorted(set(selected))]
    else:
        candidates = [r for r in rows if r["action"] == "mute"]
    if len(candidates) > max_actions:
        raise StateError(f"action count {len(candidates)} exceeds --max-actions {max_actions}")
    receipt["mode"] = "release" if release_mode else "apply"
    # Save the proposal before any remote writes. Each attempt is also journaled.
    store.save_receipt(receipt)
    for row in rows:
        if row["action"] == "suspend":
            store.ledger(row["subject"], "suspended", {"reason": row["reason"]})
    for row in candidates:
        did = row["subject"]
        fresh = adapter.observe((did,)).get(did, {"known": False})
        # Re-evaluate standing at write time: queued actions must not outlive
        # their evidence just because an earlier preview was admissible.
        evidence = EvidenceSet(tuple(Observation(**x) for x in receipt["evidence"]),
                               tuple(Coverage(**x) for x in receipt["coverage"]))
        policy = compile_policy(json.dumps(receipt["policy"]))
        decision = evaluate(policy, evidence, did, clock())
        fresh_plan = plan_action(decision, fresh, store.ledgers().get(did, {}), row["overrides"],
                                 row.get("followed_policy"))
        if fresh != row["observed"] or fresh_plan["fingerprint"] != row["fingerprint"]:
            receipt["executions"].append({"subject": did, "action": "none", "status": "state_changed"})
            if fresh != row["observed"] and store.ledgers().get(did, {}).get("status") == "attributed":
                store.ledger(did, "suspended", {"reason": "state changed before write"})
            continue
        action = "unmute" if release_mode else "mute"
        attempt = store.begin_action(did, action, {"proposal": receipt["id"], "reviewed": release["id"] if release else None})
        try:
            (adapter.release if release_mode else adapter.apply)(did)
        except Exception:
            store.finish_action(attempt, did, action, False)
            receipt["executions"].append({"subject": did, "action": action, "status": "unresolved", "attempt": attempt})
            # A timeout may have committed the effect: stop, don't replay blindly.
            break
        store.finish_action(attempt, did, action, True)
        receipt["executions"].append({"subject": did, "action": action, "status": "confirmed", "attempt": attempt})
    set_completeness(receipt, all(x["status"] == "confirmed" for x in receipt["executions"]))
    store.conn.execute("UPDATE receipts SET body=? WHERE id=?", (json.dumps(receipt, sort_keys=True), receipt["id"]))
    return receipt
