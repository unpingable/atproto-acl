from dataclasses import replace
import itertools
import json

import pytest

from atproto_acl.model import Coverage, EvidenceSet, Observation
from atproto_acl.policy import PolicyError, compile_policy, evaluate

NOW = "2026-09-08T12:00:00Z"
DID = "did:plc:alice"
PROVIDER = "did:plc:publisher"


def config(rules):
    return {"version": 1, "account": "did:plc:owner",
            "providers": {"p": {"type": "fixture", "did": PROVIDER}},
            "sources": [{"type": "explicit_dids", "dids": [DID]}], "rules": rules}


def rule(name, disposition, label=None, when=None):
    return {"name": name, "disposition": disposition, "when": when or {"source": "p", "label": label or name}}


def obs(label="q", **kw):
    return Observation(PROVIDER, DID, label, True, kw.pop("observed_at", "2026-09-08T00:00:00Z"),
                       kw.pop("expires_at", "2026-09-09T00:00:00Z"), **kw)


def ev(*observations, complete=True):
    return EvidenceSet(tuple(observations), (Coverage(PROVIDER, DID, complete, NOW),))


def run(rules, evidence):
    return evaluate(compile_policy(json.dumps(config(rules))), evidence, DID, NOW)


def test_order_independence_and_intentional_disagreement():
    rules = [rule("a", "allow"), rule("q", "quarantine"), rule("n", "neutral")]
    decisions, hashes = [], []
    for perm in itertools.permutations(rules):
        policy = compile_policy(json.dumps(config(list(perm))))
        hashes.append(policy.policy_hash)
        decisions.append(evaluate(policy, ev(obs("a"), obs("q")), DID, NOW))
    assert len(set(hashes)) == 1
    assert all(d == decisions[0] for d in decisions)
    assert decisions[0].outcome == "no_quarantine_justification"
    assert decisions[0].basis == "allow_rule"
    assert decisions[0].disagreements


@pytest.mark.parametrize("labels,complete,outcome", [
    (["q"], True, "quarantine"), ([], True, "no_quarantine_justification"),
    (["q"], False, "indeterminate"), ([], False, "indeterminate"),
])
def test_basic_outcomes(labels, complete, outcome):
    assert run([rule("q", "quarantine")], ev(*(obs(x) for x in labels), complete=complete)).outcome == outcome


def test_unknown_allow_blocks_known_quarantine_across_publishers():
    cfg = config([rule("q", "quarantine"), rule("a", "allow", when={"source": "trust", "label": "member"})])
    cfg["providers"]["trust"] = {"type": "fixture", "did": "did:plc:trust"}
    decision = evaluate(compile_policy(json.dumps(cfg)), ev(obs()), DID, NOW)
    assert decision.outcome == "indeterminate"
    assert decision.matches == ("q",)
    assert decision.unresolved == ("a",)


def test_known_allow_beats_unknown_quarantine():
    cfg = config([rule("a", "allow"), rule("q", "quarantine", when={"source": "other", "label": "q"})])
    cfg["providers"]["other"] = {"type": "fixture", "did": "did:plc:other"}
    assert evaluate(compile_policy(json.dumps(cfg)), ev(obs("a")), DID, NOW).basis == "allow_rule"


def test_expired_allow_during_outage_cannot_enable_quarantine():
    cfg = config([rule("q", "quarantine"), rule("a", "allow", when={"source": "trust", "label": "member"})])
    cfg["providers"]["trust"] = {"type": "fixture", "did": "did:plc:trust"}
    expired = Observation("did:plc:trust", DID, "member", True, "2026-09-08T00:00:00Z", NOW)
    decision = evaluate(compile_policy(json.dumps(cfg)), ev(obs(), expired), DID, NOW)
    assert decision.outcome == "indeterminate"


def test_no_justification_is_not_clearance():
    expired = obs(expires_at=NOW)
    result = run([rule("q", "quarantine")], ev(expired, complete=False))
    assert result.outcome == "no_quarantine_justification"
    assert result.basis == "no_matching_justification"
    assert "allow" not in result.basis


def test_expiry_does_not_establish_negative_evidence_during_outage():
    result = run([rule("q", "quarantine", when={"not": {"source": "p", "label": "q"}})],
                 ev(obs(expires_at=NOW), complete=False))
    assert result.outcome == "indeterminate"


@pytest.mark.parametrize("op,known,expected", [("all", False, "no_quarantine_justification"),
    ("all", True, "indeterminate"), ("any", True, "quarantine"), ("any", False, "indeterminate")])
def test_boolean_unknown_propagation(op, known, expected):
    cfg = config([rule("q", "quarantine", when={op: [{"source": "p", "label": "q"}, {"source": "other", "label": "x"}]})])
    cfg["providers"]["other"] = {"type": "fixture", "did": "did:plc:other"}
    assert evaluate(compile_policy(json.dumps(cfg)), ev(*([obs()] if known else [])), DID, NOW).outcome == expected


def test_negation_and_reapplication():
    negation = obs(observed_at="2026-09-08T01:00:00Z", negated=True)
    assert run([rule("q", "quarantine")], ev(obs(), negation)).outcome == "no_quarantine_justification"
    again = obs(observed_at="2026-09-08T02:00:00Z")
    assert run([rule("q", "quarantine")], ev(obs(), negation, again)).outcome == "quarantine"


def test_conflicting_same_time_is_indeterminate():
    assert run([rule("q", "quarantine")], ev(obs(), obs(negated=True))).outcome == "indeterminate"


def test_future_evidence_is_indeterminate():
    assert run([rule("q", "quarantine")], ev(obs(observed_at="2026-09-08T14:00:00Z"))).outcome == "indeterminate"


def test_refetch_does_not_renew_standing():
    first = obs()
    fetched = replace(first, retrieved_at="2026-09-10T00:00:00Z", provenance="another retrieval")
    assert first.evidence_id == fetched.evidence_id
    p = compile_policy(json.dumps(config([rule("q", "quarantine")])))
    assert evaluate(p, ev(fetched), DID, "2026-09-10T00:00:00Z").outcome == "no_quarantine_justification"


def test_policy_max_age():
    predicate = {"source": "p", "label": "q", "max_age_seconds": 3600}
    assert run([rule("q", "quarantine", when=predicate)], ev(obs())).outcome == "no_quarantine_justification"


def test_numeric_measurement_needs_provider_contract():
    cfg = config([rule("q", "quarantine", when={"source": "p", "property": "posts", "op": "gt", "value": 20})])
    with pytest.raises(PolicyError):
        compile_policy(json.dumps(cfg))
    cfg["providers"]["p"]["measurements"] = {"posts": "posts/day over 30 days"}
    policy = compile_policy(json.dumps(cfg))
    measure = Observation(PROVIDER, DID, "posts", 21, "2026-09-08T00:00:00Z")
    assert evaluate(policy, ev(measure), DID, NOW).outcome == "quarantine"
    cfg["providers"]["p"]["type"] = "atproto_labels"
    with pytest.raises(PolicyError):
        compile_policy(json.dumps(cfg))


@pytest.mark.parametrize("text", ["version: 1\nversion: 2", "[]", "null", "version: true", "x: !!python/object:thing {}"])
def test_invalid_policy_rejected(text):
    with pytest.raises(PolicyError):
        compile_policy(text)


def test_yaml_diagnostics_include_location_and_size_is_bounded():
    with pytest.raises(PolicyError, match=r"duplicate YAML key 'version' at line 2, column 1"):
        compile_policy("version: 1\nversion: 2")
    with pytest.raises(PolicyError, match=r"invalid YAML at line 2"):
        compile_policy("version: 1\nrules: [")
    with pytest.raises(PolicyError, match="no larger than 256 KiB"):
        compile_policy("#" * (256 * 1024 + 1))


def test_bad_time_rejected():
    with pytest.raises(ValueError):
        obs(observed_at="2026-09-08T00:00:00")
    with pytest.raises(ValueError):
        obs(expires_at="2026-09-07T00:00:00Z")


def test_categorical_predicate_does_not_coerce_measurement():
    event = Observation(PROVIDER, DID, "q", 21, "2026-09-08T00:00:00Z")
    assert run([rule("q", "quarantine")], ev(event)).outcome == "indeterminate"


def test_disallowed_fields_are_not_silently_ignored():
    cfg = config([rule("q", "quarantine")])
    cfg["rules"][0]["priority"] = 42
    with pytest.raises(PolicyError):
        compile_policy(json.dumps(cfg))


def test_external_snapshot_is_pinned_to_supported_provider_and_origin():
    cfg = config([rule("membership", "quarantine", when={"source": "bsky38", "label": "member"})])
    cfg["providers"] = {"bsky38": {"type": "external_list", "did": "did:web:bsky38.com"}}
    cfg["sources"] = [{"type": "external_snapshot", "provider": "bsky38",
                       "url": "https://bsky38.com/", "limit": 38}]
    assert compile_policy(json.dumps(cfg)).config["sources"][0]["limit"] == 38
    cfg["sources"][0]["url"] = "https://attacker.invalid/"
    with pytest.raises(PolicyError, match="supported Bsky38"):
        compile_policy(json.dumps(cfg))
    cfg["sources"][0]["url"] = "https://bsky38.com/"
    cfg["sources"][0]["limit"] = 1
    with pytest.raises(PolicyError, match="supported Bsky38"):
        compile_policy(json.dumps(cfg))
    cfg["sources"][0]["limit"] = 38
    cfg["providers"]["bsky38"]["did"] = "did:web:attacker.invalid"
    with pytest.raises(PolicyError, match="supported Bsky38"):
        compile_policy(json.dumps(cfg))


def test_feed_exposure_source_accepts_bounded_timeline_and_generator_forms():
    cfg = config([rule("q", "quarantine")])
    cfg["sources"] = [{"type": "feed_exposure", "surface": "timeline",
                       "limit": 500, "followed": "review"}]
    assert compile_policy(json.dumps(cfg)).config["sources"] == cfg["sources"]

    feed = "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot"
    cfg["sources"] = [{"type": "feed_exposure", "surface": "generator",
                       "feed_uri": feed, "limit": 500, "followed": "review"}]
    assert compile_policy(json.dumps(cfg)).config["sources"] == cfg["sources"]


@pytest.mark.parametrize("source", [
    {"type": "feed_exposure"},
    {"type": "feed_exposure", "surface": "other"},
    {"type": "feed_exposure", "surface": "timeline", "feed_uri":
        "at://did:plc:x/app.bsky.feed.generator/y"},
    {"type": "feed_exposure", "surface": "timeline", "feed_uri": None},
    {"type": "feed_exposure", "surface": "generator"},
    {"type": "feed_exposure", "surface": "generator", "feed_uri": "https://example.test/feed"},
    {"type": "feed_exposure", "surface": "timeline", "limit": 0},
    {"type": "feed_exposure", "surface": "timeline", "limit": 501},
    {"type": "feed_exposure", "surface": "timeline", "followed": "exclude"},
])
def test_feed_exposure_source_rejects_ambiguous_or_unbounded_forms(source):
    cfg = config([rule("q", "quarantine")])
    cfg["sources"] = [source]
    with pytest.raises(PolicyError):
        compile_policy(json.dumps(cfg))
