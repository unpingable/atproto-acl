# Reuse and independence

The hosted service remains independent of `atproto-community`. It imports no
Community package, database, credential, authority, or runtime.

| Concern | Pattern reviewed | Implementation here | Qualification boundary |
| --- | --- | --- | --- |
| Browser OAuth | Confidential backend-for-frontend OAuth | Official `@atproto/oauth-client-node`, server-side tokens, opaque application cookie | Requires browser-specific live acceptance |
| Secret storage | Owner-only server-side credential storage | SQLite OAuth state plus external private JWK and service credentials | Host permissions are an operator check |
| CSRF and sessions | Origin checks, HttpOnly cookies, and request tokens | Exact Origin validation, per-session CSRF digest, restrictive cookies, and CSP | Controlled browser fixtures do not prove a live grant |
| Subject binding | Ownership checks at every data boundary | Immutable DID on policies, evidence, approvals, jobs, and sessions | Cross-user fixtures plus live multi-user acceptance |
| Uncertain writes | Durable intent before effect and read-only reconciliation | Action journal with pending, attempting, confirmed, failed, and uncertain standing | Never infer success from a retryable transport error |
| Refresh coordination | One refresher per stored OAuth session | Expiring SQLite coordination passed to the official SDK | Requires concurrent live refresh acceptance |

Patterns were evaluated for their trust and failure properties, then implemented
inside atproto-acl's narrower architecture. No uncommitted donor work or private
campaign evidence is treated as released or qualified code.
