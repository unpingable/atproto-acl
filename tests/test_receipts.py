"""Semantic diagnostics and reproducible context contracts."""
from dataclasses import replace
import hashlib
import json

import pytest

from atproto_acl.model import Coverage, EvidenceSet
from atproto_acl.policy import compile_policy, evaluate
from atproto_acl.runtime import build_receipt, execute
from atproto_acl.store import StateError
from test_policy import DID, NOW, PROVIDER, config, ev, obs, rule
from test_runtime import FakeAdapter, MUTED, OPEN, store


def policy(rules=None):
    return compile_policy(json.dumps(config(rules or [rule("q", "quarantine")])))


def receipt(store, *, p=None, evidence=None, remote=None, overrides=None, now=NOW, discovery=None):
    return build_receipt(p or policy(), store, (DID,), evidence or ev(obs()),
        [{"source": "explicit_dids", "subjects": [DID], "complete": True}] if discovery is None else discovery,
        overrides or {"exempt": set(), "allow": set(), "keep_muted": set()},
        {DID: OPEN} if remote is None else remote, now)


def test_allow_expiry_and_no_match_are_distinct(store):
    allowed = receipt(store, p=policy([rule("q", "quarantine"), rule("a", "allow")]),
                      evidence=ev(obs("q"), obs("a")))
    expired = receipt(store, evidence=ev(obs(expires_at=NOW)))
    never_matched = receipt(store, evidence=ev())
    assert allowed["rows"][0]["disposition_reasons"] == ["allow_won"]
    assert expired["rows"][0]["disposition_reasons"] == ["quarantine_evidence_expired"]
    assert never_matched["rows"][0]["disposition_reasons"] == ["no_matching_quarantine_rule"]
    for r in (allowed, expired, never_matched):
        assert r["rows"][0]["desired"] == "no_quarantine_justification"
        assert "neutral" != r["rows"][0]["evaluation"]["outcome"]


def test_no_longer_matches_requires_recorded_history(store):
    negative = ev(obs(), obs(observed_at="2026-09-08T01:00:00Z", negated=True))
    first = receipt(store, evidence=negative, remote={DID: MUTED})
    assert "quarantine_rule_no_longer_matches" not in first["rows"][0]["disposition_reasons"]
    applied = receipt(store)
    execute(applied, store, FakeAdapter(), clock=lambda: NOW)
    after = receipt(store, evidence=negative, remote={DID: MUTED})
    row = after["rows"][0]
    assert "quarantine_rule_no_longer_matches" in row["disposition_reasons"]
    assert row["no_longer_matching_rules"] == ["q"]
    assert row["previous_quarantine_receipt"] == applied["id"]
    assert row["action"] == "release_candidate"
    assert row["can_prove_ownership"] is False


def test_irrelevant_expiry_is_not_reported_as_cause(store):
    p = policy([rule("q", "quarantine", when={"all": [
        {"source": "p", "label": "q"}, {"source": "p", "label": "missing"}]})])
    result = receipt(store, p=p, evidence=ev(obs(expires_at=NOW)))
    assert "quarantine_evidence_expired" not in result["rows"][0]["disposition_reasons"]


def test_local_max_age_reports_expiry(store):
    p = policy([rule("q", "quarantine", when={"source": "p", "label": "q", "max_age_seconds": 3600})])
    assert receipt(store, p=p)["rows"][0]["disposition_reasons"] == ["quarantine_evidence_expired"]


def test_complete_preview_is_explicit(store):
    r = receipt(store)
    assert r["complete"] is True
    assert all(r["completeness"].values())
    assert r["incomplete_reasons"] == []


@pytest.mark.parametrize("change,reason", [
    ({"discovery": []}, "discovery"),
    ({"discovery": [{"source": "explicit_dids", "complete": False}]}, "discovery"),
    ({"evidence": ev(obs(), complete=False)}, "evidence"),
    ({"evidence": EvidenceSet((obs(),), ())}, "evidence"),
    ({"evidence": ev(obs(), obs(negated=True))}, "evaluation"),
    ({"remote": {}}, "remote_state"),
])
def test_partial_preview_has_top_level_false(store, change, reason):
    r = receipt(store, **change)
    assert r["complete"] is False
    assert reason in r["incomplete_reasons"]


def test_exempt_subject_needs_no_remote_or_evidence_reads(store):
    r = receipt(store, evidence=EvidenceSet(), remote={}, overrides={
        "exempt": {DID}, "allow": set(), "keep_muted": set()})
    assert r["complete"] is True
    assert r["rows"][0]["action"] == "none"


def test_failed_execution_is_incomplete(store):
    r = receipt(store)
    execute(r, store, FakeAdapter(fail=True), clock=lambda: NOW)
    assert r["complete"] is False
    assert r["completeness"]["execution"] is False


def test_raw_yaml_hash_is_distinct_from_semantic_hash(store):
    text = json.dumps(config([rule("q", "quarantine")]))
    first = compile_policy(text)
    changed_text = "# comment with CRLF\r\n" + text
    second = compile_policy(changed_text)
    assert second.source_hash == hashlib.sha256(changed_text.encode("utf-8")).hexdigest()
    assert first.source_hash != second.source_hash
    assert first.policy_hash == second.policy_hash
    a, b = receipt(store, p=first), receipt(store, p=second)
    assert a["policy_source_hash"] != b["policy_source_hash"]
    assert a["effective_config_hash"] == b["effective_config_hash"]
    assert a["decision_context_hash"] == b["decision_context_hash"]


def test_pins_and_overrides_change_effective_configuration(store):
    baseline = receipt(store)
    store.pin("friend.test", DID)
    pinned = receipt(store)
    assert baseline["policy_hash"] == pinned["policy_hash"]
    assert baseline["effective_config_hash"] != pinned["effective_config_hash"]
    changed = receipt(store, overrides={"exempt": set(), "allow": {DID}, "keep_muted": set()})
    assert changed["policy_hash"] == pinned["policy_hash"]
    assert changed["effective_config_hash"] != pinned["effective_config_hash"]


def test_account_source_configuration_is_hashed(store):
    cfg = config([rule("q", "quarantine")])
    cfg["sources"] = [{"type": "timeline", "limit": 17}]
    assert receipt(store)["effective_config_hash"] != receipt(store, p=compile_policy(json.dumps(cfg)))["effective_config_hash"]


@pytest.mark.parametrize("change", [
    {"now": "2026-09-08T12:01:00Z"},
    {"remote": {DID: MUTED}},
    {"evidence": ev(obs(expires_at=NOW))},
    {"evidence": ev(obs(), complete=False)},
    {"discovery": [{"source": "explicit_dids", "complete": False}]},
])
def test_evaluated_inputs_change_context_not_configuration(store, change):
    a, b = receipt(store), receipt(store, **change)
    assert a["effective_config_hash"] == b["effective_config_hash"]
    assert a["decision_context_hash"] != b["decision_context_hash"]


def test_retrieval_metadata_is_not_decision_context(store):
    a = receipt(store, evidence=ev(obs(retrieved_at=NOW)))
    b = receipt(store, evidence=ev(obs(retrieved_at="2026-09-08T12:01:00Z", provenance="other endpoint")))
    assert a["decision_context_hash"] == b["decision_context_hash"]
    assert a["effective_configuration"]["publisher_catalog"] == {
        "status": "not_consulted", "affects_evaluation": False}


def test_legacy_receipt_is_readable_but_needs_new_release_review(store):
    store.ledger(DID, "attributed")
    old = receipt(store, evidence=ev(obs(expires_at=NOW)), remote={DID: MUTED})
    old.pop("effective_config_hash")
    store.save_receipt(old)
    assert store.receipt(old["id"])["schema"] == 1
    with pytest.raises(StateError, match="legacy release"):
        execute(receipt(store, evidence=ev(obs(expires_at=NOW)), remote={DID: MUTED}),
                store, FakeAdapter(MUTED), old, [DID], clock=lambda: NOW)


def test_rebinding_invalidates_release_context(store):
    store.ledger(DID, "attributed")
    store.pin("friend.test", DID)
    old = receipt(store, evidence=ev(obs(expires_at=NOW)), remote={DID: MUTED})
    store.rebind("friend.test", DID, "did:plc:bob")
    fresh = receipt(store, evidence=ev(obs(expires_at=NOW)), remote={DID: MUTED})
    assert old["rows"][0]["fingerprint"] == fresh["rows"][0]["fingerprint"]
    with pytest.raises(StateError):
        execute(fresh, store, FakeAdapter(MUTED), old, [DID], clock=lambda: NOW)


def test_new_observation_time_alone_does_not_invalidate_review(store):
    store.ledger(DID, "attributed")
    old = receipt(store, evidence=ev(obs(expires_at=NOW)), remote={DID: MUTED})
    fresh = receipt(store, evidence=ev(obs(expires_at=NOW)), remote={DID: MUTED},
                    now="2026-09-08T12:01:00Z")
    assert old["decision_context_hash"] != fresh["decision_context_hash"]
    adapter = FakeAdapter(MUTED)
    execute(fresh, store, adapter, old, [DID], clock=lambda: "2026-09-08T12:01:00Z")
    assert adapter.calls == [("unmute", DID)]
