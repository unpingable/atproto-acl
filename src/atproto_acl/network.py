"""Small bounded XRPC client. Error text never includes response bodies or tokens."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request


APPVIEW = "https://public.api.bsky.app"


class NetworkError(RuntimeError):
    pass


def https_url(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.fragment:
        raise NetworkError("service URL must be HTTPS without embedded credentials or fragments")
    return url.rstrip("/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Credentials must not cross an unexpected service boundary.
        return None


class Client:
    def __init__(self, max_requests=1000, pace=0.05):
        self.remaining = max_requests
        self.requests = 0
        self.pace = pace
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, url, body=None, token=None):
        https_url(url)
        if self.remaining <= 0:
            raise NetworkError("request budget exhausted")
        self.remaining -= 1
        self.requests += 1
        headers = {"User-Agent": "atproto-acl/0.1 (+https://github.com/unpingable/atproto-acl)",
                   "Accept": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        if body is not None:
            headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, headers=headers)
        if self.pace:
            time.sleep(self.pace)
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read(16 * 1024 * 1024 + 1)
                if len(raw) > 16 * 1024 * 1024:
                    raise NetworkError("response exceeds size limit")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raise NetworkError(f"HTTP {exc.code}; request not automatically retried") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise NetworkError("request failed or returned invalid JSON") from None

    def get(self, base, method, params=None, token=None):
        url = https_url(base) + "/xrpc/" + method
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        return self.request(url, token=token)

    def post(self, base, method, body, token=None):
        return self.request(https_url(base) + "/xrpc/" + method, body=body, token=token)


def did_document(client, did):
    if did.startswith("did:plc:"):
        url = "https://plc.directory/" + urllib.parse.quote(did, safe=":")
    elif did.startswith("did:web:"):
        parts = did[8:].split(":")
        host = urllib.parse.unquote(parts[0])
        if any(x in host for x in "/?#@"):
            raise NetworkError("invalid did:web host")
        path = "/" + "/".join(urllib.parse.quote(x, safe="") for x in parts[1:]) if len(parts) > 1 else "/.well-known"
        url = "https://" + host + path + "/did.json"
    else:
        raise NetworkError("unsupported DID method")
    doc = client.request(url)
    if doc.get("id") != did:
        raise NetworkError("DID document identity mismatch")
    return doc


def service(doc, fragment):
    for item in doc.get("service", []):
        if item.get("id") in (fragment, doc["id"] + fragment):
            return https_url(item["serviceEndpoint"])
    raise NetworkError(f"DID document lacks {fragment}")


def resolve(client, actor):
    actor = actor.lstrip("@")
    if actor.startswith("did:"):
        return actor
    did = client.get(APPVIEW, "com.atproto.identity.resolveHandle", {"handle": actor}).get("did")
    if not isinstance(did, str) or not did.startswith("did:"):
        raise NetworkError("handle resolution did not return a DID")
    doc = did_document(client, did)
    if "at://" + actor not in doc.get("alsoKnownAs", []):
        raise NetworkError("handle binding is not bidirectionally verified")
    return did


class Session:
    def __init__(self, client, account, password):
        self.client = client
        self.did = account
        self.pds = service(did_document(client, account), "#atproto_pds")
        data = client.post(self.pds, "com.atproto.server.createSession", {"identifier": account, "password": password})
        if data.get("did") != account:
            raise NetworkError("authenticated account does not match configured account")
        self.token = data["accessJwt"]

    def get(self, method, params=None):
        return self.client.get(self.pds, method, params, token=self.token)

    def post(self, method, body):
        return self.client.post(self.pds, method, body, token=self.token)
