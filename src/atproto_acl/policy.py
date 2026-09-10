"""Pure, order-independent policy compiler and three-valued evaluator."""
from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from datetime import timedelta

import yaml

from .model import Decision, EvidenceSet, Truth, canonical, digest, timestamp


class PolicyError(ValueError):
    pass


class UniqueLoader(yaml.SafeLoader):
    pass


def _mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            mark = key_node.start_mark
            raise PolicyError(f"duplicate YAML key {key!r} at line {mark.line + 1}, column {mark.column + 1}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)


@dataclass(frozen=True)
class CompiledPolicy:
    """Canonical JSON keeps the compiled contract immutable."""
    document: str
    policy_hash: str
    source_hash: str = ""

    @property
    def config(self):
        import json
        return json.loads(self.document)


def _keys(value, allowed, required=()):
    if not isinstance(value, dict):
        raise PolicyError("expected an object")
    unknown = set(value) - set(allowed)
    missing = set(required) - set(value)
    if unknown:
        raise PolicyError(f"unknown fields: {sorted(unknown)}")
    if missing:
        raise PolicyError(f"missing required fields: {sorted(missing)}")


def _predicate(node, providers, depth=0):
    if depth > 32:
        raise PolicyError("predicate nesting exceeds 32")
    if not isinstance(node, dict):
        raise PolicyError("predicate must be an object")
    for op in ("all", "any", "not"):
        if op in node:
            _keys(node, [op])
            children = [node[op]] if op == "not" else node[op]
            if not isinstance(children, list) or not children:
                raise PolicyError(f"{op} requires nonempty predicates")
            for child in children:
                _predicate(child, providers, depth + 1)
            return
    _keys(node, ["source", "label", "property", "op", "value", "max_age_seconds"], ["source"])
    if node["source"] not in providers:
        raise PolicyError(f"unknown evidence source: {node['source']}")
    if ("label" in node) == ("property" in node):
        raise PolicyError("predicate needs exactly one of label or property")
    if "label" in node:
        if not isinstance(node["label"], str) or not node["label"] or "op" in node or "value" in node:
            raise PolicyError("label predicates require a nonempty label and no comparison")
    else:
        if node.get("op") not in ("eq", "gt", "gte", "lt", "lte"):
            raise PolicyError("measurement comparison requires eq/gt/gte/lt/lte")
        value = node.get("value")
        if type(value) not in (int, float) or not math.isfinite(value):
            raise PolicyError("measurement comparison requires a finite number")
        measurements = providers[node["source"]].get("measurements", {})
        if node["property"] not in measurements:
            raise PolicyError("numeric property must be declared by its provider; labels are not counts")
    age = node.get("max_age_seconds")
    if age is not None and (type(age) is not int or age <= 0):
        raise PolicyError("max_age_seconds must be a positive integer")


def compile_policy(text: str) -> CompiledPolicy:
    if not isinstance(text, str) or len(text.encode("utf-8")) > 256 * 1024:
        raise PolicyError("policy document must be UTF-8 text no larger than 256 KiB")
    try:
        config = yaml.load(text, Loader=UniqueLoader)
        _keys(config, ["version", "account", "providers", "sources", "rules", "exempt", "allow", "keep_muted"],
              ["version", "account", "providers", "sources", "rules"])
        if type(config["version"]) is not int or config["version"] != 1 or not isinstance(config["account"], str) or not config["account"]:
            raise PolicyError("version must be 1 and account must be an identifier")
        providers = config["providers"]
        if not isinstance(providers, dict) or not providers:
            raise PolicyError("at least one evidence provider is required")
        publisher_dids = set()
        for name, spec in providers.items():
            _keys(spec, ["type", "did", "measurements"], ["type", "did"])
            if spec["type"] not in ("atproto_labels", "external_list", "fixture") or not spec["did"].startswith("did:"):
                raise PolicyError(f"invalid provider {name}")
            if spec["type"] == "atproto_labels" and spec.get("measurements"):
                raise PolicyError("ATProto label providers do not expose numeric measurements")
            if spec["did"] in publisher_dids:
                raise PolicyError("use one provider alias per publisher DID")
            publisher_dids.add(spec["did"])
            if not isinstance(spec.get("measurements", {}), dict) or any(
                    not isinstance(k, str) or not isinstance(v, str) or not v
                    for k, v in spec.get("measurements", {}).items()):
                raise PolicyError("measurement declarations map property names to nonempty descriptions")
        if not isinstance(config["sources"], list) or not config["sources"]:
            raise PolicyError("configure at least one account source explicitly")
        for source in config["sources"]:
            _keys(source, ["type", "dids", "actor", "limit", "provider", "url",
                           "surface", "feed_uri", "followed"], ["type"])
            kind = source["type"]
            if kind not in ("explicit_dids", "follows", "timeline", "labeled_stream",
                            "external_snapshot", "feed_exposure"):
                raise PolicyError(f"unknown account source {kind}")
            _keys(source, {"explicit_dids": ["type", "dids"], "follows": ["type", "actor", "limit"],
                           "timeline": ["type", "limit"], "labeled_stream": ["type", "provider", "limit"],
                           "external_snapshot": ["type", "provider", "url", "limit"],
                           "feed_exposure": ["type", "surface", "feed_uri", "limit", "followed"]}[kind],
                  ["type", "surface"] if kind == "feed_exposure" else ["type"])
            if kind == "explicit_dids" and (not isinstance(source.get("dids"), list) or
                    any(not isinstance(x, str) or not x.startswith("did:") for x in source["dids"])):
                raise PolicyError("explicit_dids requires a DID list")
            if kind == "labeled_stream" and source.get("provider") not in providers:
                raise PolicyError("labeled_stream requires a configured provider")
            if kind == "external_snapshot":
                provider = providers.get(source.get("provider"), {})
                if (provider.get("type") != "external_list" or
                        provider.get("did") != "did:web:bsky38.com" or
                        source.get("url") != "https://bsky38.com/" or source.get("limit") != 38):
                    raise PolicyError("external_snapshot requires the supported Bsky38 provider and URL")
            if kind == "feed_exposure":
                surface = source.get("surface")
                feed_uri = source.get("feed_uri")
                if surface not in ("timeline", "generator"):
                    raise PolicyError("feed_exposure surface must be timeline or generator")
                if surface == "generator":
                    if (not isinstance(feed_uri, str) or not re.fullmatch(
                            r"at://did:(?:plc|web):[^/\s]+/app\.bsky\.feed\.generator/[A-Za-z0-9._~:-]+",
                            feed_uri)):
                        raise PolicyError("generator feed_exposure requires a feed generator AT URI")
                elif "feed_uri" in source:
                    raise PolicyError("timeline feed_exposure must not specify feed_uri")
                if source.get("followed") not in (None, "review"):
                    raise PolicyError("feed_exposure followed must be review")
                if "limit" in source and (type(source["limit"]) is not int or
                                           not 1 <= source["limit"] <= 500):
                    raise PolicyError("feed_exposure limit must be between 1 and 500")
            elif "limit" in source and (type(source["limit"]) is not int or source["limit"] <= 0):
                raise PolicyError("source limit must be positive")
        if not isinstance(config["rules"], list):
            raise PolicyError("rules must be a list")
        names = set()
        for rule in config["rules"]:
            _keys(rule, ["name", "disposition", "when"], ["name", "disposition", "when"])
            if not isinstance(rule["name"], str) or not rule["name"] or rule["name"] in names:
                raise PolicyError("rule names must be unique nonempty strings")
            names.add(rule["name"])
            if rule["disposition"] not in ("allow", "quarantine", "neutral"):
                raise PolicyError("disposition must be allow, quarantine, or neutral")
            _predicate(rule["when"], providers)
        for layer in ("exempt", "allow", "keep_muted"):
            values = config.setdefault(layer, [])
            if not isinstance(values, list) or any(not isinstance(x, str) or not x for x in values):
                raise PolicyError(f"{layer} must be a list of DIDs or handles")
        config["rules"].sort(key=lambda x: x["name"])
        return CompiledPolicy(canonical(config), digest(config), hashlib.sha256(text.encode("utf-8")).hexdigest())
    except yaml.MarkedYAMLError as exc:
        mark = exc.problem_mark
        where = f" at line {mark.line + 1}, column {mark.column + 1}" if mark else ""
        problem = exc.problem or type(exc).__name__
        raise PolicyError(f"invalid YAML{where}: {problem}") from exc
    except (TypeError, KeyError, AttributeError, RecursionError, yaml.YAMLError) as exc:
        raise PolicyError(f"invalid policy: {type(exc).__name__}") from exc


def _leaf(node, providers, evidence, subject, now, negative=False, require_current=False, ignore_expiry=False):
    provider = providers[node["source"]]["did"]
    prop = node.get("label", node.get("property"))
    events = [e for e in evidence.observations
              if e.provider == provider and e.subject == subject and e.property == prop]
    if not events:
        complete = any(c.provider == provider and c.subject == subject and c.complete
                       for c in evidence.coverage)
        return Truth.FALSE if complete else Truth.UNKNOWN, []
    latest_time = max(timestamp(e.observed_at) for e in events)
    latest = {e.evidence_id: e for e in events if timestamp(e.observed_at) == latest_time}
    ids = sorted(latest)
    if len(latest) != 1 or latest_time > now:
        return Truth.UNKNOWN, ids
    event = next(iter(latest.values()))
    complete = any(c.provider == provider and c.subject == subject and c.complete for c in evidence.coverage)
    if event.negated:
        return (Truth.UNKNOWN if (negative or require_current) and not complete else Truth.FALSE), ids
    deadline = timestamp(event.expires_at) if event.expires_at else None
    if node.get("max_age_seconds"):
        local = latest_time + timedelta(seconds=node["max_age_seconds"])
        deadline = min(deadline, local) if deadline else local
    if deadline and deadline <= now and not ignore_expiry:
        # An expired assertion loses standing, but during an outage its absence
        # cannot justify a new consequence through a negated predicate.
        return (Truth.UNKNOWN if (negative or require_current) and not complete else Truth.FALSE), ids
    # A partial refresh might hide a newer negation: unexpired cache is not
    # sufficient to authorize new consequences when current coverage is unknown.
    if not complete:
        return Truth.UNKNOWN, ids
    if "label" in node:
        return (Truth.TRUE if event.value is True else Truth.UNKNOWN), ids
    if type(event.value) not in (int, float) or not math.isfinite(event.value):
        return Truth.UNKNOWN, ids
    rhs = node["value"]
    match = {"eq": event.value == rhs, "gt": event.value > rhs, "gte": event.value >= rhs,
             "lt": event.value < rhs, "lte": event.value <= rhs}[node["op"]]
    return Truth.TRUE if match else Truth.FALSE, ids


def _eval(node, providers, evidence, subject, now, negative=False, require_current=False, ignore_expiry=False):
    for op in ("all", "any", "not"):
        if op not in node:
            continue
        children = [node[op]] if op == "not" else node[op]
        results = [_eval(x, providers, evidence, subject, now, not negative if op == "not" else negative,
                         require_current, ignore_expiry) for x in children]
        truths = [r[0] for r in results]
        ids = sorted({eid for r in results for eid in r[1]})
        if op == "not":
            return {Truth.TRUE: Truth.FALSE, Truth.FALSE: Truth.TRUE, Truth.UNKNOWN: Truth.UNKNOWN}[truths[0]], ids
        decisive = Truth.FALSE if op == "all" else Truth.TRUE
        if decisive in truths:
            return decisive, ids
        if Truth.UNKNOWN in truths:
            return Truth.UNKNOWN, ids
        return Truth.TRUE if op == "all" else Truth.FALSE, ids
    return _leaf(node, providers, evidence, subject, now, negative, require_current, ignore_expiry)


def evaluate(policy: CompiledPolicy, evidence: EvidenceSet, subject: str, now: str) -> Decision:
    config = policy.config
    results = []
    ids = set()
    for rule in config["rules"]:
        truth, used = _eval(rule["when"], config["providers"], evidence, subject, timestamp(now),
                           require_current=rule["disposition"] == "allow")
        expiry_blocks_match = False
        if rule["disposition"] == "quarantine" and truth == Truth.FALSE:
            without_expiry, _ = _eval(rule["when"], config["providers"], evidence, subject,
                                      timestamp(now), ignore_expiry=True)
            expiry_blocks_match = without_expiry != Truth.FALSE
        results.append({"name": rule["name"], "disposition": rule["disposition"],
                        "truth": truth.value, "expiry_blocks_match": expiry_blocks_match})
        ids.update(used)
    rank = {"neutral": 0, "quarantine": 1, "allow": 2}
    matches = [r for r in results if r["truth"] == "true"]
    unknown = [r for r in results if r["truth"] == "unknown"]
    winner = max((rank[r["disposition"]] for r in matches), default=0)
    uncertain = any(rank[r["disposition"]] > winner for r in unknown)
    outcome = "indeterminate" if uncertain else "quarantine" if winner == 1 else "no_quarantine_justification"
    basis = "unresolved_precedence" if uncertain else "allow_rule" if winner == 2 else "quarantine_rule" if winner == 1 else "no_matching_justification"
    if uncertain:
        reasons = ("unresolved_precedence",)
    elif winner == 2:
        reasons = ("allow_won",)
    elif winner == 1:
        reasons = ("quarantine_rule_matched",)
    elif any(r["expiry_blocks_match"] for r in results):
        reasons = ("quarantine_evidence_expired",)
    else:
        reasons = ("no_matching_quarantine_rule",)
    return Decision(subject, outcome, basis, tuple(r["name"] for r in matches),
                    tuple(r["name"] for r in unknown), tuple(results), tuple(sorted(ids)),
                    len({r["disposition"] for r in matches}) > 1, reasons)
