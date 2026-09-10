"""Account discovery is independent from evidence admissibility."""
from __future__ import annotations

from .model import Discovery
from .network import APPVIEW, NetworkError, resolve


class Sources:
    def __init__(self, client, account, store, providers, session=None, max_pages=20):
        self.client, self.account, self.store = client, account, store
        self.providers, self.session, self.max_pages = providers, session, max_pages

    def discover(self, spec):
        kind = spec["type"]
        if kind == "explicit_dids":
            return Discovery(tuple(sorted(set(spec["dids"]))), True, kind)
        if kind == "labeled_stream":
            provider = self.providers.get(spec["provider"])
            if not provider:
                return Discovery((), False, kind, reason="publisher unavailable")
            return provider.discover(self.store, spec.get("limit", 5000))
        if kind == "external_snapshot":
            return Discovery((), False, kind, reason="external snapshot requires a configured acquisition adapter")
        if kind == "timeline" and not self.session:
            return Discovery((), False, kind, reason="timeline requires authentication")
        cursor, seen, subjects = None, set(), set()
        limit = spec.get("limit", 500 if kind == "timeline" else 10000)
        items = 0
        try:
            actor = spec.get("actor", self.account)
            did = self.store.pin(actor, resolve(self.client, actor)) if kind == "follows" else self.account
            for _ in range(self.max_pages):
                params = {"limit": min(100, limit - items)}
                if cursor:
                    params["cursor"] = cursor
                if kind == "follows":
                    params["actor"] = did
                    page = self.client.get(APPVIEW, "app.bsky.graph.getFollows", params)
                    rows = page["follows"]
                    subjects.update(x["did"] for x in rows)
                else:
                    page = self.session.get("app.bsky.feed.getTimeline", params)
                    rows = page["feed"]
                    subjects.update(x["post"]["author"]["did"] for x in rows)
                items += len(rows)
                cursor = page.get("cursor")
                if not cursor or not rows:
                    return Discovery(tuple(sorted(subjects)), True, kind)
                if items >= limit:
                    return Discovery(tuple(sorted(subjects)), kind == "timeline", kind, cursor,
                                     "configured timeline sample" if kind == "timeline" else "follow set truncated")
                if cursor in seen:
                    raise NetworkError("repeated account cursor")
                seen.add(cursor)
        except (NetworkError, KeyError, TypeError):
            return Discovery(tuple(sorted(subjects)), False, kind, cursor, "account discovery failed")
        return Discovery(tuple(sorted(subjects)), False, kind, cursor, "page budget exhausted")
