import pytest

from atproto_acl.host_bridge import handle


POLICY = """
version: 1
account: did:plc:viewer
providers:
  activity:
    type: fixture
    did: did:plc:publisher
    measurements:
      posts_per_day: average posts per day
sources:
  - type: explicit_dids
    dids: [did:plc:subject]
rules:
  - name: prolific
    disposition: quarantine
    when:
      source: activity
      property: posts_per_day
      op: gt
      value: 20
"""


def test_host_preview_uses_engine_and_live_journal(tmp_path):
    message = {
        "command": "preview",
        "policy": POLICY,
        "account": "did:plc:viewer",
        "state": str(tmp_path / "engine.db"),
        "subjects": ["did:plc:subject"],
        "observations": [{
            "provider": "did:plc:publisher", "subject": "did:plc:subject",
            "property": "posts_per_day", "value": 24,
            "observed_at": "2026-09-08T12:00:00+00:00",
        }],
        "coverage": [{
            "provider": "did:plc:publisher", "subject": "did:plc:subject",
            "complete": True, "checked_at": "2026-09-08T12:01:00+00:00",
        }],
        "remote": {"did:plc:subject": {"known": True, "direct": False, "muted": False}},
        "now": "2026-09-08T12:02:00+00:00",
    }
    result = handle(message)
    assert result["rows"][0]["desired"] == "quarantine"
    assert result["rows"][0]["action"] == "mute"
    assert result["complete"] is False
    assert result["incomplete_reasons"] == ["discovery"]


def test_host_bridge_lists_authoritative_overrides(tmp_path):
    common = {"state": str(tmp_path / "engine.db"), "account": "did:plc:viewer"}
    handle({"command": "override", **common, "subject": "did:plc:subject",
            "kind": "exempt", "enabled": True})
    assert handle({"command": "list_overrides", **common}) == {
        "exempt": ["did:plc:subject"], "allow": [], "keep_muted": []}


def test_host_bridge_journals_uncertain_attempt(tmp_path):
    common = {"state": str(tmp_path / "engine.db"), "account": "did:plc:viewer",
              "subject": "did:plc:subject", "action": "mute"}
    begun = handle({"command": "begin_action", **common, "detail": {"job": "job-1"}})
    finished = handle({"command": "finish_action", **common, "attempt": begun["attempt"], "success": False})
    assert finished["status"] == "unresolved"


def test_host_preview_preserves_feed_exposure_follow_review_boundary(tmp_path):
    policy = POLICY.replace(
        "  - type: explicit_dids\n    dids: [did:plc:subject]",
        "  - type: feed_exposure\n    surface: timeline\n    limit: 500\n    followed: review",
    )
    message = {
        "command": "preview", "policy": policy, "account": "did:plc:viewer",
        "state": str(tmp_path / "engine.db"), "subjects": ["did:plc:subject"],
        "observations": [{
            "provider": "did:plc:publisher", "subject": "did:plc:subject",
            "property": "posts_per_day", "value": 24,
            "observed_at": "2026-09-08T12:00:00+00:00",
        }],
        "coverage": [{
            "provider": "did:plc:publisher", "subject": "did:plc:subject",
            "complete": True, "checked_at": "2026-09-08T12:01:00+00:00",
        }],
        "discovery": [{
            "source": "feed_exposure", "surface": "timeline",
            "subjects": ["did:plc:subject"], "complete": True,
            "provenance": "authenticated timeline",
        }],
        "remote": {"did:plc:subject": {"known": True, "direct": False, "muted": False,
                                          "relationship": "following"}},
        "now": "2026-09-08T12:02:00+00:00",
    }
    result = handle(message)
    assert result["rows"][0]["action"] == "follow_review_candidate"
    assert result["rows"][0]["followed_policy"] == "review"

    message["remote"]["did:plc:subject"]["relationship"] = "invented"
    with pytest.raises(Exception, match="remote relationship"):
        handle(message)
    message["remote"]["did:plc:subject"]["relationship"] = None
    with pytest.raises(Exception, match="remote relationship"):
        handle(message)
