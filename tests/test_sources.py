from atproto_acl.model import Discovery
from atproto_acl.sources import Sources
from atproto_acl.store import Store


class Client:
    def __init__(self, pages):
        self.pages = iter(pages)
    def get(self, *args):
        return next(self.pages)


def test_explicit_dids_deduplicated(tmp_path):
    store = Store(tmp_path / "s.db", "did:plc:owner")
    try:
        source = Sources(Client([]), store.account, store, {})
        assert source.discover({"type": "explicit_dids", "dids": ["did:plc:a", "did:plc:a"]}).subjects == ("did:plc:a",)
    finally:
        store.close()


def test_follows_paginate_and_report_truncation(tmp_path):
    store = Store(tmp_path / "s.db", "did:plc:owner")
    try:
        pages = [{"follows": [{"did": "did:plc:a"}], "cursor": "c1"}, {"follows": [{"did": "did:plc:b"}]}]
        result = Sources(Client(pages), store.account, store, {}).discover({"type": "follows"})
        assert result.complete and result.subjects == ("did:plc:a", "did:plc:b")
        result = Sources(Client(pages), store.account, store, {}).discover({"type": "follows", "limit": 1})
        assert not result.complete and result.subjects == ("did:plc:a",)
    finally:
        store.close()


def test_timeline_requires_auth_and_is_explicit_sample(tmp_path):
    store = Store(tmp_path / "s.db", "did:plc:owner")
    try:
        assert not Sources(Client([]), store.account, store, {}).discover({"type": "timeline"}).complete
        session = Client([{"feed": [{"post": {"author": {"did": "did:plc:a"}}}], "cursor": "more"}])
        result = Sources(Client([]), store.account, store, {}, session).discover({"type": "timeline", "limit": 1})
        assert result.complete and result.reason == "configured timeline sample"
    finally:
        store.close()


def test_unavailable_label_source_is_not_complete(tmp_path):
    store = Store(tmp_path / "s.db", "did:plc:owner")
    try:
        result = Sources(Client([]), store.account, store, {}).discover({"type": "labeled_stream", "provider": "p"})
        assert not result.complete and result.subjects == ()
    finally:
        store.close()


def test_external_snapshot_without_adapter_is_explicitly_unavailable(tmp_path):
    store = Store(tmp_path / "s.db", "did:plc:owner")
    try:
        result = Sources(Client([]), store.account, store, {}).discover({"type": "external_snapshot"})
        assert not result.complete and result.subjects == ()
        assert "adapter" in result.reason
    finally:
        store.close()
