"""Additive receipt contracts: completeness, context digests, and grounded causes."""
from . import __version__
from .model import canonical, digest, timestamp


def disposition_reasons(row, decision, previous):
    codes = list(decision.reason_codes)
    if row["overrides"].get("allow"):
        codes = ["explicit_allow_override"]
    prior_row = next((r for r in (previous or {}).get("rows", [])
                      if r["subject"] == decision.subject), None)
    ceased = []
    if prior_row:
        prior_matches = {r["name"] for r in prior_row["evaluation"]["rules"]
                         if r["disposition"] == "quarantine" and r["truth"] == "true"}
        ceased = sorted(r["name"] for r in decision.rules
                        if r["name"] in prior_matches and r["disposition"] == "quarantine"
                        and r["truth"] == "false" and not r["expiry_blocks_match"])
        if ceased and row["desired"] == "no_quarantine_justification":
            codes.append("quarantine_rule_no_longer_matches")
    return {"disposition_reasons": sorted(set(codes)),
            "no_longer_matching_rules": ceased,
            "previous_quarantine_receipt": previous["id"] if previous else None}


def set_completeness(receipt, execution_complete=True):
    """Complete means the configured scope, never every account on ATProto."""
    rows = [r for r in receipt["rows"] if not r["overrides"].get("exempt")]
    subjects = {r["subject"] for r in rows}
    publishers = {p["did"] for p in receipt["policy"]["providers"].values()}
    covered = {(c["provider"], c["subject"]) for c in receipt["coverage"] if c["complete"]}
    expected = {(p, did) for p in publishers for did in subjects}
    discovery = receipt["discovery"]
    components = {
        "discovery": len(discovery) == len(receipt["policy"]["sources"]) and
                     all(d.get("complete") is True for d in discovery),
        "evidence": expected <= covered and all(c["complete"] for c in receipt["coverage"]
                                                if c["subject"] in subjects),
        "evaluation": all(r["evaluation"]["outcome"] != "indeterminate" for r in rows),
        "remote_state": all(r["observed"].get("known") is True for r in rows),
        "relationship": all(not r.get("followed_policy") or
                            r["observed"].get("relationship") in ("following", "not_following")
                            for r in rows),
        "execution": execution_complete,
    }
    receipt["completeness"] = components
    receipt["complete"] = all(components.values())
    receipt["incomplete_reasons"] = [k for k, complete in components.items() if not complete]


def add_context(receipt, policy, overrides, ledgers):
    # Catalog descriptions are not consulted by the evaluator in V0. Declaring
    # that fact is more precise than pretending a catalog snapshot was pinned.
    configuration = {
        "contract": "atproto-acl-effective-configuration-v1",
        "engine_version": __version__, "account": receipt["account"],
        "evidence_mode": receipt["evidence_mode"], "policy_hash": policy.policy_hash,
        "overrides": {k: sorted(v) for k, v in overrides.items()},
        "pins": receipt["identities"]["pins"],
        "adapter": receipt["adapter"], "capabilities": receipt["capabilities"],
        "publisher_catalog": {"status": "not_consulted", "affects_evaluation": False},
    }
    context = {
        "contract": "atproto-acl-decision-context-v1",
        "effective_config_hash": digest(configuration),
        "evaluated_at": timestamp(receipt["evaluated_at"]).isoformat(),
        "subjects": sorted(r["subject"] for r in receipt["rows"]),
        "discovery": sorted(receipt["discovery"], key=canonical),
        "coverage": sorted(receipt["coverage"], key=canonical),
        "evidence_ids": sorted({e["evidence_id"] for e in receipt["evidence"]}),
        "observed": {r["subject"]: r["observed"] for r in receipt["rows"]},
        "ledger": {r["subject"]: ledgers.get(r["subject"], {}) for r in receipt["rows"]},
        "history": {r["subject"]: r["previous_quarantine_receipt"] for r in receipt["rows"]},
    }
    receipt.update(policy_source_hash=policy.source_hash,
                   effective_configuration=configuration,
                   effective_config_hash=context["effective_config_hash"],
                   decision_context=context, decision_context_hash=digest(context))
