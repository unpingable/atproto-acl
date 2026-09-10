import base64
from dataclasses import replace

import cbor2
import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from atproto_acl.labels import LabelProvider, normalize, signing_key, verify_label
from atproto_acl.network import NetworkError
from atproto_acl.store import Store
from test_policy import DID, NOW, PROVIDER


def b58(raw):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n, result = int.from_bytes(raw, "big"), ""
    while n:
        n, remainder = divmod(n, 58)
        result = alphabet[remainder] + result
    return result


def signed(key, **extra):
    body = {"ver": 1, "src": PROVIDER, "uri": DID, "val": "q", "cts": NOW,
            "exp": "2026-09-09T12:00:00Z", **extra}
    signature = key.sign(cbor2.dumps(body, canonical=True), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(signature)
    sig = base64.b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big")).decode().rstrip("=")
    return {**body, "sig": {"$bytes": sig}, "id": 42}


def doc(key):
    prefix = b"\xe7\x01" if isinstance(key.curve, ec.SECP256K1) else b"\x80\x24"
    raw = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.CompressedPoint)
    return {"id": PROVIDER,
        "verificationMethod": [{"id": PROVIDER + "#atproto_label", "publicKeyMultibase": "z" + b58(prefix + raw)}],
        "service": [{"id": "#atproto_labeler", "serviceEndpoint": "https://labels.example"}]}


@pytest.mark.parametrize("curve", [ec.SECP256K1, ec.SECP256R1])
def test_signature_roundtrip_and_substitution(curve):
    key = ec.generate_private_key(curve())
    public = signing_key(doc(key))
    raw = signed(key)
    verify_label(raw, public, PROVIDER)
    with pytest.raises(InvalidSignature):
        verify_label({**raw, "val": "changed"}, public, PROVIDER)
    with pytest.raises(ValueError):
        verify_label(raw, public, "did:plc:another")


def test_signature_missing_label_key_has_no_repository_key_fallback():
    key = ec.generate_private_key(ec.SECP256K1())
    document = doc(key)
    document["verificationMethod"][0]["id"] = PROVIDER + "#atproto"
    with pytest.raises(ValueError):
        signing_key(document)


def test_normalization_ignores_provider_id_and_signature_for_identity():
    key = ec.generate_private_key(ec.SECP256K1())
    first = normalize(signed(key), NOW, "endpoint")
    second = normalize({**signed(key), "id": 99}, "2026-09-10T00:00:00Z", "other")
    assert first.evidence_id == second.evidence_id
    assert first.provider_id == "42" and second.provider_id == "99"
    assert normalize(signed(key, uri="at://did:plc:alice/app.bsky.feed.post/abc"), NOW, "endpoint") is None
    assert normalize(signed(key, cid="version-specific"), NOW, "endpoint") is None


class Client:
    def __init__(self, key, pages):
        self.key, self.pages, self.params = key, list(pages), []
    def request(self, url):
        return doc(self.key)
    def get(self, endpoint, method, params):
        self.params.append(params)
        result = self.pages.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def test_paginated_subject_collection_and_partial_failure():
    key = ec.generate_private_key(ec.SECP256K1())
    raw = signed(key)
    client = Client(key, [{"labels": [raw], "cursor": "c1"}, NetworkError("failed")])
    evidence = LabelProvider(client, PROVIDER).collect((DID,))
    assert len(evidence.observations) == 1
    assert not evidence.coverage[0].complete
    assert client.params[1]["cursor"] == "c1"


def test_complete_empty_page_not_inferred_from_page_budget():
    key = ec.generate_private_key(ec.SECP256K1())
    client = Client(key, [{"labels": [signed(key)], "cursor": "c1"}])
    assert not LabelProvider(client, PROVIDER, max_pages=1).collect((DID,)).coverage[0].complete
    client = Client(key, [{"labels": []}])
    assert LabelProvider(client, PROVIDER).collect((DID,)).coverage[0].complete


def test_failed_signature_gates_subject():
    key = ec.generate_private_key(ec.SECP256K1())
    raw = {**signed(key), "val": "substitution"}
    client = Client(key, [{"labels": [raw]}])
    evidence = LabelProvider(client, PROVIDER).collect((DID,))
    assert not evidence.coverage[0].complete and not evidence.observations


def test_resumable_discovery_commits_evidence_before_cursor(tmp_path):
    key = ec.generate_private_key(ec.SECP256K1())
    store = Store(tmp_path / "state.db", "did:plc:owner")
    try:
        client = Client(key, [{"labels": [signed(key)], "cursor": "c1"}])
        found = LabelProvider(client, PROVIDER, max_pages=1).discover(store, limit=1)
        assert found.subjects == (DID,) and not found.complete
        assert client.params[0]["limit"] == 1
        assert store.cursor("labels:" + PROVIDER) == "c1"
        assert len(store.evidence(DID)) == 1
        client = Client(key, [{"labels": []}])
        found = LabelProvider(client, PROVIDER).discover(store)
        assert client.params[0]["cursor"] == "c1"
        assert found.complete and found.subjects == (DID,)
    finally:
        store.close()


def test_repeated_cursor_is_incomplete():
    key = ec.generate_private_key(ec.SECP256K1())
    page = {"labels": [signed(key)], "cursor": "c1"}
    result = LabelProvider(Client(key, [page, page]), PROVIDER).collect((DID,))
    assert not result.coverage[0].complete
