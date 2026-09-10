from dataclasses import replace
import json

import pytest

from atproto_acl.adapters import PrivateMuteAdapter, plan_action
from atproto_acl.model import EvidenceSet
from atproto_acl.policy import compile_policy, evaluate
from atproto_acl.runtime import build_receipt, execute
from atproto_acl.store import StateError, Store
from test_policy import DID, NOW, config, ev, obs, rule

OWNER = "did:plc:owner"
OPEN = {"known": True, "direct": False, "muted": False, "only_reposts": False,
        "only_quotes": False, "list": None, "blocked": False}
MUTED = {**OPEN, "direct": True, "muted": True}


class FakeAdapter:
    capabilities = PrivateMuteAdapter.capabilities
    def __init__(self, state=None, fail=False):
        self.state, self.calls, self.fail = state or OPEN, [], fail
    def observe(self, subjects):
        return {did: dict(self.state) for did in subjects}
    def apply(self, subject):
        self.calls.append(("mute", subject))
        self.state = MUTED
        if self.fail:
            raise TimeoutError("effect may already exist")
    def release(self, subject):
        self.calls.append(("unmute", subject))
        self.state = OPEN


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "state.db", OWNER)
    yield s
    s.close()


def proposal(store, evidence=None, remote=None, overrides=None, policy=None, discovery=None):
    p = policy or compile_policy(json.dumps(config([rule("q", "quarantine")])))
    return build_receipt(p, store, (DID,), evidence or ev(obs()), discovery or [],
                         overrides or {"exempt": set(), "allow": set(), "keep_muted": set()},
                         {DID: remote or OPEN}, NOW)


def feed_exposure_policy(followed="review"):
    cfg = config([rule("q", "quarantine")])
    source = {"type": "feed_exposure", "surface": "timeline", "limit": 500}
    if followed is not None:
        source["followed"] = followed
    cfg["sources"] = [source]
    return compile_policy(json.dumps(cfg))


def feed_discovery():
    return [{"source": "feed_exposure", "surface": "timeline", "subjects": [DID],
             "complete": True, "provenance": "authenticated timeline"}]


def test_feed_exposure_routes_followed_match_to_separate_review(store):
    row = proposal(store, remote={**OPEN, "relationship": "following"},
                   policy=feed_exposure_policy(), discovery=feed_discovery())["rows"][0]
    assert row["desired"] == "quarantine"
    assert row["action"] == "follow_review_candidate"
    assert row["followed_policy"] == "review"
    assert row["manual_review_required"] is True
    assert row["can_apply"] is False


def test_feed_exposure_mutes_nonfollowed_match_and_refuses_unknown_relation(store):
    not_followed = proposal(store, remote={**OPEN, "relationship": "not_following"},
                            policy=feed_exposure_policy(), discovery=feed_discovery())["rows"][0]
    assert not_followed["action"] == "mute"
    receipt = proposal(store, remote={**OPEN, "relationship": "unknown"},
                       policy=feed_exposure_policy(), discovery=feed_discovery())
    unknown = receipt["rows"][0]
    assert unknown["action"] == "none"
    assert unknown["relationship_resolution"] == "unresolved"
    assert unknown["manual_review_required"] is True
    assert receipt["complete"] is False
    assert "relationship" in receipt["incomplete_reasons"]


def test_follow_relationship_does_not_change_legacy_or_unrequested_source(store):
    legacy = proposal(store, remote={**OPEN, "relationship": "following"})["rows"][0]
    assert legacy["action"] == "mute"
    unrequested = proposal(store, remote={**OPEN, "relationship": "following"},
                           policy=feed_exposure_policy(None), discovery=feed_discovery())["rows"][0]
    assert unrequested["action"] == "mute"


def test_feed_follow_review_keeps_allow_and_exemption_precedence(store):
    cfg = config([rule("q", "quarantine"), rule("a", "allow")])
    cfg["sources"] = [{"type": "feed_exposure", "surface": "timeline", "followed": "review"}]
    allowed = proposal(store, evidence=ev(obs(), obs("a")),
                       remote={**OPEN, "relationship": "following"},
                       policy=compile_policy(json.dumps(cfg)), discovery=feed_discovery())["rows"][0]
    assert allowed["action"] == "none"
    exempt = proposal(store, remote={**OPEN, "relationship": "following"},
                      overrides={"exempt": {DID}, "allow": set(), "keep_muted": set()},
                      policy=feed_exposure_policy(), discovery=feed_discovery())["rows"][0]
    assert exempt["action"] == "none"


def test_historical_authorship_is_not_current_ownership(store):
    adapter = FakeAdapter()
    with store.lock():
        execute(proposal(store), store, adapter, clock=lambda: NOW)
        assert store.ledgers()[DID]["status"] == "attributed"
        # T2/T3 happen between observations. T4 looks identical to T1 remotely.
        adapter.state = OPEN
        adapter.state = MUTED
        expired = ev(obs(expires_at=NOW), complete=False)
        release = proposal(store, expired, MUTED)
        assert release["rows"][0]["action"] == "release_candidate"
        assert release["rows"][0]["can_prove_ownership"] is False
        execute(release, store, adapter, clock=lambda: NOW)
    assert adapter.calls == [("mute", DID)]


def test_explicit_review_releases(store):
    store.ledger(DID, "attributed")
    evidence = ev(obs(expires_at=NOW))
    reviewed = proposal(store, evidence, MUTED)
    store.save_receipt(reviewed)
    fresh = proposal(store, evidence, MUTED)
    adapter = FakeAdapter(MUTED)
    execute(fresh, store, adapter, reviewed, [DID], clock=lambda: NOW)
    assert adapter.calls == [("unmute", DID)]
    assert store.ledgers()[DID]["status"] == "released"


@pytest.mark.parametrize("change", ["policy_hash", "override_hash", "account"])
def test_stale_release_rejected(store, change):
    store.ledger(DID, "attributed")
    previous = proposal(store, ev(obs(expires_at=NOW)), MUTED)
    fresh = proposal(store, ev(obs(expires_at=NOW)), MUTED)
    fresh[change] = "changed"
    with pytest.raises(StateError):
        execute(fresh, store, FakeAdapter(MUTED), previous, [DID], clock=lambda: NOW)


def test_release_requires_selection_and_current_candidate(store):
    store.ledger(DID, "attributed")
    previous = proposal(store, ev(obs(expires_at=NOW)), MUTED)
    for selected in ([], ["did:plc:unrelated"]):
        with pytest.raises(StateError):
            execute(proposal(store, ev(obs(expires_at=NOW)), MUTED), store, FakeAdapter(MUTED), previous, selected)
    with pytest.raises(StateError):
        execute(proposal(store, ev(obs()), MUTED), store, FakeAdapter(MUTED), previous, [DID])


@pytest.mark.parametrize("remote", [MUTED, {**OPEN, "only_reposts": True},
    {**OPEN, "only_quotes": True}, {**OPEN, "muted": True, "list": "at://list"}])
def test_existing_mutes_preserved_without_adoption(store, remote):
    adapter = FakeAdapter(remote)
    receipt = proposal(store, remote=remote)
    execute(receipt, store, adapter, clock=lambda: NOW)
    assert not adapter.calls
    assert DID not in store.ledgers()


def test_overrides_are_separate_layers(store):
    store.ledger(DID, "attributed")
    expired = ev(obs(expires_at=NOW))
    layers = {"exempt": {DID}, "allow": set(), "keep_muted": set()}
    row = proposal(store, expired, MUTED, layers)["rows"][0]
    assert row["action"] == "none" and "no jurisdiction" in row["reason"]
    layers = {"exempt": set(), "allow": {DID}, "keep_muted": {DID}}
    row = proposal(store, remote=MUTED, overrides=layers)["rows"][0]
    assert row["desired"] == "no_quarantine_justification"
    assert row["evaluation"]["outcome"] == "quarantine"
    assert row["action"] == "none" and "keep-muted" in row["reason"]


def test_keep_muted_never_creates_a_mute(store):
    layers = {"exempt": set(), "allow": set(), "keep_muted": {DID}}
    assert proposal(store, ev(obs(expires_at=NOW)), overrides=layers)["rows"][0]["action"] == "none"


def test_observed_manual_unmute_suspends(store):
    store.ledger(DID, "attributed")
    adapter = FakeAdapter()
    receipt = proposal(store)
    assert receipt["rows"][0]["action"] == "suspend"
    execute(receipt, store, adapter, clock=lambda: NOW)
    assert store.ledgers()[DID]["status"] == "suspended"
    assert not adapter.calls


def test_write_timeout_never_adopts_state(store):
    adapter = FakeAdapter(fail=True)
    execute(proposal(store), store, adapter, clock=lambda: NOW)
    assert store.ledgers()[DID]["status"] == "unresolved"
    fresh = proposal(store, remote=MUTED)
    execute(fresh, store, adapter, clock=lambda: NOW)
    assert adapter.calls == [("mute", DID)]


def test_process_loss_keeps_pending_journal(store):
    attempt = store.begin_action(DID, "mute", {"proposal": "interrupted"})
    assert store.ledgers()[DID]["status"] == "unresolved"
    assert store.conn.execute("SELECT status FROM attempts WHERE id=?", (attempt,)).fetchone()[0] == "pending"
    assert proposal(store)["rows"][0]["action"] == "none"


def test_changed_remote_state_before_write(store):
    adapter = FakeAdapter(MUTED)
    receipt = proposal(store)
    execute(receipt, store, adapter, clock=lambda: NOW)
    assert not adapter.calls
    assert receipt["executions"][0]["status"] == "state_changed"


def test_evidence_expiring_in_write_queue_cannot_apply(store):
    adapter = FakeAdapter()
    receipt = proposal(store)
    execute(receipt, store, adapter, clock=lambda: "2026-09-10T00:00:00Z")
    assert not adapter.calls


def test_action_budget_refuses_before_any_write(store):
    with pytest.raises(StateError):
        execute(proposal(store), store, FakeAdapter(), max_actions=0)
    assert not store.ledgers()


def test_identity_rebind_is_explicit_and_receipted(store):
    store.pin("mutable.test", DID)
    with pytest.raises(StateError):
        store.pin("mutable.test", "did:plc:bob")
    with pytest.raises(StateError):
        store.rebind("mutable.test", "did:plc:wrong", "did:plc:bob")
    store.rebind("mutable.test", DID, "did:plc:bob")
    assert store.identities()["pins"]["mutable.test"] == "did:plc:bob"
    assert store.identities()["migrations"][0]["old_did"] == DID


def test_account_state_separation(store):
    with pytest.raises(StateError):
        Store(store.path, "did:plc:other")


def test_fixture_state_cannot_be_reopened_live(tmp_path):
    path = tmp_path / "fixture.db"
    Store(path, OWNER, "fixture").close()
    with pytest.raises(StateError):
        Store(path, OWNER, "live")


def test_library_enforcement_rejects_fixture_receipt(store):
    receipt = proposal(store)
    receipt["fixture"] = True
    with pytest.raises(StateError):
        execute(receipt, store, FakeAdapter())


def test_adapter_capabilities_gate_execution(store):
    adapter = FakeAdapter()
    adapter.capabilities = replace(adapter.capabilities, can_apply=False)
    with pytest.raises(StateError):
        execute(proposal(store), store, adapter)
    assert not adapter.calls


def test_single_writer_lock(store):
    other = Store(store.path, OWNER)
    try:
        with store.lock():
            with pytest.raises(StateError):
                with other.lock():
                    pytest.fail("concurrent writer admitted")
    finally:
        other.close()


def test_evidence_deduplication_preserves_first_retrieval(store):
    first = obs(retrieved_at=NOW)
    store.add_evidence([first, replace(first, retrieved_at="2026-09-10T00:00:00Z")])
    assert store.evidence(DID) == (first,)


def test_scoped_mutes_not_visible_in_get_mutes_still_preserved():
    class Session:
        def get(self, method, params):
            if method.endswith("getMutes"):
                return {"mutes": []}
            return {"profiles": [{"did": DID, "viewer": {"mutedOnlyReposts": True}}]}
    remote = PrivateMuteAdapter(Session()).observe((DID,))[DID]
    decision = evaluate(compile_policy(json.dumps(config([rule("q", "quarantine")]))), ev(obs()), DID, NOW)
    assert plan_action(decision, remote, {}, {})["action"] == "none"
