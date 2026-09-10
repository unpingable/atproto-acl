import hashlib
import json

import pytest

from atproto_acl.policy import PolicyError
from atproto_acl.portable import export_portable_document, parse_portable_document, runtime_account_rules
from atproto_acl.cli import main


POLICY = """version: 1
account: did:plc:viewer
providers:
  activity:
    type: fixture
    did: did:plc:publisher
    measurements: {posts: posts per day}
sources:
  - type: explicit_dids
    dids: [did:plc:subject]
rules:
  - name: prolific
    disposition: quarantine
    when: {source: activity, property: posts, op: gt, value: 20}
exempt: [did:plc:inline]
allow: []
keep_muted: []
"""


def exported(handle="subject.example", exported_at="2026-09-10T12:00:00+00:00"):
    return export_portable_document(
        policy_source=POLICY, policy_name="Quiet feed", policy_revision=7,
        exporter_version="0.2.0", exported_at=exported_at,
        account_rules={
            "leave_alone": [{"did": "did:plc:subject", "last_known_handle": handle}],
            "always_keep": [{"did": "did:plc:subject"}],
            "never_unmute": [{"did": "did:plc:grandma"}],
        },
    )


def test_envelope_preserves_independent_overlapping_rule_sets():
    doc = parse_portable_document(exported())
    assert doc.enveloped is True
    assert runtime_account_rules(doc.account_rules) == {
        "exempt": {"did:plc:subject"},
        "allow": {"did:plc:subject"},
        "keep_muted": {"did:plc:grandma"},
    }
    assert doc.provenance["policy_source_hash"] == hashlib.sha256(POLICY.encode()).hexdigest()
    assert doc.policy.config["exempt"] == ["did:plc:inline"]


def test_provenance_and_handle_annotations_do_not_change_behavioral_identity():
    first = parse_portable_document(exported())
    later = parse_portable_document(exported("renamed.example", "2027-01-01T00:00:00+00:00"))
    assert first.policy.policy_hash == later.policy.policy_hash
    assert first.account_rules_hash == later.account_rules_hash
    assert first.portable_behavior_hash == later.portable_behavior_hash


def test_bare_v1_remains_unambiguously_supported():
    doc = parse_portable_document(POLICY)
    assert doc.enveloped is False
    assert doc.policy.config["exempt"] == ["did:plc:inline"]
    assert runtime_account_rules(doc.account_rules) == {"exempt": set(), "allow": set(), "keep_muted": set()}


@pytest.mark.parametrize("old,new,error", [
    ("format_version: 1", "format_version: 2", "unsupported portable document version"),
    ("format: atproto-acl.portable-policy", "format: strange-format", "unsupported portable document format"),
    ("version: 1\n  leave_alone", "version: 2\n  leave_alone", "unsupported account_rules version"),
])
def test_unknown_versions_and_formats_refuse_by_discriminator(old, new, error):
    with pytest.raises(PolicyError, match=error):
        parse_portable_document(exported().replace(old, new, 1))


def test_duplicate_did_within_one_set_refuses_but_cross_set_overlap_does_not():
    text = exported().replace(
        "    last_known_handle: subject.example\n  always_keep:",
        "    last_known_handle: subject.example\n  - did: did:plc:subject\n"
        "    last_known_handle: duplicate.example\n  always_keep:",
    )
    with pytest.raises(PolicyError, match="duplicate DID"):
        parse_portable_document(text)


@pytest.mark.parametrize("text,match", [
    ("format: atproto-acl.portable-policy\nformat_version: [", "invalid YAML"),
    ("format: atproto-acl.portable-policy\nformat_version: 1\n", "missing portable document fields"),
    ("format: atproto-acl.portable-policy\nformat_version: 1\nprovenance: nope\npolicy: {}\naccount_rules: {}\n",
     "portable document section must be an object"),
])
def test_corrupt_and_partial_documents_refuse(text, match):
    with pytest.raises(PolicyError, match=match):
        parse_portable_document(text)


def test_export_is_a_complete_escape_hatch_in_empty_cli_state(tmp_path, capsys):
    policy_path = tmp_path / "portable.yaml"
    policy_path.write_text(exported())
    fixture_path = tmp_path / "fixture.json"
    fixture_path.write_text(json.dumps({
        "version": 1, "account": "did:plc:viewer",
        "subjects": ["did:plc:subject", "did:plc:grandma"],
        "observations": [], "coverage": [], "discovery": [],
        "remote": {
            "did:plc:subject": {"known": True, "direct": False, "muted": False},
            "did:plc:grandma": {"known": True, "direct": True, "muted": True},
        },
    }))
    state = tmp_path / "fresh" / "state.db"
    assert not state.exists()
    assert main(["preview", "--policy", str(policy_path), "--fixture", str(fixture_path),
                 "--state", str(state), "--now", "2026-09-10T12:00:00Z", "--format", "json"]) == 0
    receipt = json.loads(capsys.readouterr().out)
    parsed = parse_portable_document(exported())
    assert receipt["portable_behavior_hash"] == parsed.portable_behavior_hash
    assert receipt["account_rules_hash"] == parsed.account_rules_hash
    assert receipt["rows"]
    assert state.exists()
