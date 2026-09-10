"""Private mute reconciliation; historical attribution never proves ownership."""
from __future__ import annotations

from .model import Capabilities, digest
from .network import NetworkError


class PrivateMuteAdapter:
    capabilities = Capabilities(True, "explicit_review", False, True,
        "same-scope calls converge, but replace other scopes; ambiguous writes require review")

    def __init__(self, session):
        self.session = session

    def observe(self, subjects):
        try:
            direct = set()
            cursor, seen = None, set()
            while True:
                params = {"limit": 100}
                if cursor:
                    params["cursor"] = cursor
                page = self.session.get("app.bsky.graph.getMutes", params)
                direct.update(x["did"] for x in page["mutes"])
                cursor = page.get("cursor")
                if not cursor:
                    break
                if cursor in seen:
                    raise NetworkError("repeated mute cursor")
                seen.add(cursor)
            result = {}
            for start in range(0, len(subjects), 25):
                profiles = self.session.get("app.bsky.actor.getProfiles", {"actors": list(subjects[start:start + 25])})
                for profile in profiles["profiles"]:
                    viewer = profile.get("viewer")
                    if not isinstance(viewer, dict):
                        continue
                    did = profile["did"]
                    result[did] = {"known": True, "direct": did in direct,
                        "muted": bool(viewer.get("muted")),
                        "only_reposts": bool(viewer.get("mutedOnlyReposts")),
                        "only_quotes": bool(viewer.get("mutedOnlyQuoteposts")),
                        "list": (viewer.get("mutedByList") or {}).get("uri"),
                        "blocked": bool(viewer.get("blocking") or viewer.get("blockingByList"))}
            return {did: result.get(did, {"known": False}) for did in subjects}
        except (NetworkError, KeyError, TypeError):
            return {did: {"known": False} for did in subjects}

    def apply(self, subject):
        self.session.post("app.bsky.graph.muteActor", {"actor": subject})

    def release(self, subject):
        self.session.post("app.bsky.graph.unmuteActor", {"actor": subject})


def has_mute(observed):
    return any(observed.get(k) for k in ("direct", "muted", "only_reposts", "only_quotes", "list"))


def attributable_shape(observed):
    return observed.get("known") and observed.get("direct") and not (
        observed.get("only_reposts") or observed.get("only_quotes"))


def plan_action(decision, observed, ledger, overrides, followed_policy=None):
    """Pure consequence planning. No remote effect, including release, here."""
    desired = decision.outcome
    basis = decision.basis
    if overrides.get("allow"):
        desired, basis = "no_quarantine_justification", "explicit_allow_override"
    result = {"subject": decision.subject, "desired": desired, "basis": basis,
              "observed": observed, "action": "none", "reason": "",
              "ownership": "locally-attributed" if ledger.get("status") == "attributed" else "unproven",
              "can_apply": False, "can_release": False,
              "can_prove_ownership": False, "manual_review_required": False,
              "overrides": overrides, "ledger_status": ledger.get("status", "untracked")}
    if followed_policy is not None:
        result["followed_policy"] = followed_policy

    def done(reason, action="none", review=False):
        result.update(reason=reason, action=action, manual_review_required=review)
        result["can_apply"] = action == "mute"
        result["can_release"] = action == "release_candidate"
        result["fingerprint"] = digest({**result, "evidence_ids": decision.evidence_ids,
                                        "rules": decision.rules})
        return result

    if overrides.get("exempt"):
        return done("exempt: automation has no jurisdiction")
    if ledger.get("status") in ("unresolved", "suspended"):
        return done("automation suspended; explicit resume required", review=True)
    if not observed.get("known"):
        if desired == "quarantine":
            return done("would quarantine; authenticated state observation required", "observe_required")
        return done("remote state unknown")
    if ledger.get("status") == "attributed" and not attributable_shape(observed):
        return done("observed manual change; suspend automation", "suspend", review=True)
    if desired == "indeterminate":
        return done("evidence cannot establish the winning disposition")
    if desired == "quarantine":
        if has_mute(observed) or observed.get("blocked"):
            return done("preserve existing moderation state")
        if followed_policy == "review":
            relationship = observed.get("relationship", "unknown")
            if relationship == "following":
                return done("account is already followed; review the follow relationship separately",
                            "follow_review_candidate", review=True)
            if relationship != "not_following":
                result["relationship_resolution"] = "unresolved"
                return done("follow relationship could not be established; no mute proposed", review=True)
        return done("observations matched user-authored policy", "mute")
    if overrides.get("keep_muted"):
        return done("keep-muted enforcement override prevents release")
    if ledger.get("status") == "attributed" and observed.get("direct"):
        return done("current mute ownership cannot be established", "release_candidate", review=True)
    return done("no current quarantine justification; preserve unrelated state")
