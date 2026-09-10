"""ATProto label evidence, signature verification, and bounded polling."""
from __future__ import annotations

import base64

import cbor2
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from .model import Coverage, Discovery, EvidenceSet, Observation, canonical, utcnow
from .network import NetworkError, did_document, service


def _base58(text):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = 0
    for char in text:
        number = number * 58 + alphabet.index(char)
    return b"\0" * (len(text) - len(text.lstrip("1"))) + number.to_bytes((number.bit_length() + 7) // 8, "big")


def signing_key(doc):
    for method in doc.get("verificationMethod", []):
        if method.get("id") in ("#atproto_label", doc["id"] + "#atproto_label"):
            value = method.get("publicKeyMultibase", "")
            if not value.startswith("z"):
                break
            raw = _base58(value[1:])
            curves = {b"\xe7\x01": ec.SECP256K1, b"\x80\x24": ec.SECP256R1}
            if raw[:2] not in curves:
                break
            return ec.EllipticCurvePublicKey.from_encoded_point(curves[raw[:2]](), raw[2:])
    raise ValueError("missing or unsupported #atproto_label signing key")


def verify_label(raw, key, provider):
    if raw.get("src") != provider or raw.get("ver") != 1:
        raise ValueError("label source/version mismatch")
    if not isinstance(raw.get("uri"), str) or not isinstance(raw.get("val"), str):
        raise ValueError("invalid label subject/value")
    if "neg" in raw and type(raw["neg"]) is not bool:
        raise ValueError("invalid negation")
    encoded = raw["sig"]["$bytes"]
    sig = base64.b64decode(encoded + "=" * (-len(encoded) % 4), validate=True)
    if len(sig) != 64:
        raise ValueError("invalid signature length")
    # Only protocol schema fields participate; provider-specific id is not signed.
    body = {k: raw[k] for k in ("ver", "src", "uri", "cid", "val", "neg", "cts", "exp") if k in raw}
    signature = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
    key.verify(signature, cbor2.dumps(body, canonical=True), ec.ECDSA(hashes.SHA256()))


def normalize(raw, retrieved_at, provenance):
    if not raw["uri"].startswith("did:") or raw.get("cid"):
        return None
    return Observation(raw["src"], raw["uri"], raw["val"], True, raw["cts"], raw.get("exp"),
                       raw.get("neg", False), provider_id=str(raw["id"]) if "id" in raw else None,
                       raw_json=canonical(raw), retrieved_at=retrieved_at, provenance=provenance)


class LabelProvider:
    def __init__(self, client, did, max_pages=20):
        self.client, self.did, self.max_pages = client, did, max_pages
        self.doc = did_document(client, did)
        self.endpoint = service(self.doc, "#atproto_labeler")
        self.key = signing_key(self.doc)

    def query(self, subjects, cursor=None, limit=250):
        params = {"uriPatterns": list(subjects), "sources": [self.did], "limit": min(250, limit)}
        if cursor:
            params["cursor"] = cursor
        return self.client.get(self.endpoint, "com.atproto.label.queryLabels", params)

    def _normalize_verified(self, raw, at):
        try:
            verify_label(raw, self.key, self.did)
        except InvalidSignature:
            # A rotated key is resolved once for this verification attempt.
            self.doc = did_document(self.client, self.did)
            self.key = signing_key(self.doc)
            verify_label(raw, self.key, self.did)
        return normalize(raw, at, self.endpoint)

    def collect(self, subjects):
        observations, coverage = [], []
        for offset in range(0, len(subjects), 100):
            requested = set(subjects[offset:offset + 100])
            at, cursor, seen = utcnow(), None, set()
            complete, reason = False, "page budget exhausted"
            try:
                for _ in range(self.max_pages):
                    page = self.query(tuple(sorted(requested)), cursor)
                    rows = page["labels"]
                    if not isinstance(rows, list):
                        raise ValueError("invalid label page")
                    for raw in rows:
                        if raw.get("uri") not in requested:
                            raise ValueError("label query returned a different subject")
                        obs = self._normalize_verified(raw, at)
                        if obs:
                            observations.append(obs)
                    next_cursor = page.get("cursor")
                    if not rows or not next_cursor:
                        complete, reason = True, ""
                        break
                    if next_cursor in seen:
                        raise ValueError("repeated label cursor")
                    seen.add(next_cursor)
                    cursor = next_cursor
            except (NetworkError, ValueError, KeyError, TypeError, InvalidSignature):
                reason = "label read or verification failed"
            coverage.extend(Coverage(self.did, subject, complete, at, reason) for subject in sorted(requested))
        return EvidenceSet(tuple(observations), tuple(coverage))

    def discover(self, store, limit=5000):
        source = "labels:" + self.did
        cursor = store.cursor(source)
        seen = set()
        count = 0
        complete, reason = False, "discovery budget exhausted; resume on next run"
        try:
            for _ in range(self.max_pages):
                page = self.query(("*",), cursor, max(1, min(250, limit - count)))
                observations = []
                for raw in page["labels"]:
                    obs = self._normalize_verified(raw, utcnow())
                    if obs:
                        observations.append(obs)
                store.add_evidence(observations)
                store.discover(source, (x.subject for x in observations))
                count += len(page["labels"])
                next_cursor = page.get("cursor")
                if not page["labels"]:
                    complete, reason = True, "endpoint exhausted; historical coverage not guaranteed"
                    break
                if next_cursor:
                    if next_cursor in seen or next_cursor == cursor:
                        raise ValueError("repeated discovery cursor")
                    seen.add(next_cursor)
                    cursor = next_cursor
                    store.set_cursor(source, cursor)
                else:
                    complete, reason = True, "endpoint exhausted; historical coverage not guaranteed"
                    break
                if count >= limit:
                    break
        except (NetworkError, ValueError, KeyError, TypeError, InvalidSignature):
            reason = "discovery read or verification failed; cursor retained"
        return Discovery(store.discovered(source), complete, source, cursor, reason)
