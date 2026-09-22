# Quench exposure capture v1

Status: bounded qualification instrument; not generalized telemetry.

This private/local evidence format answers one question: whether exact thread
lineages repeat in a bounded Home and Discover sample, and whether exact-lineage
suppression preserves unrelated posts by the same participants.

Each observation allowlists only:

- deterministic observation ID and observation time;
- `home` or `discover` provenance and position;
- exposed post URI/CID and author DID;
- determinate/indeterminate lineage standing;
- canonical root and optional parent AT URI;
- repost target URI when the exposed item is a repost; and
- a bounded structural reason for indeterminate lineage.

It excludes post and quote bodies, media, alt text, handles, display names,
profile text, external URLs, topics, sentiment, embeddings, classifications,
credentials, headers, and OAuth token material. The sanitizer constructs a new
allowlisted object from the existing bounded feed extractor; it never serializes
the upstream response.

Capture uses the application's durable OAuth session custody and requires its
existing grant to include `app.bsky.feed.getTimeline` and
`app.bsky.feed.getFeed`. The guarded operator harness receives only the DID; it
does not receive raw tokens. Expired access credentials may be refreshed under
the application's per-account cross-process lock. The complete successor
session, including the rotated refresh token and private DPoP material, is
committed atomically before the official client returns it for use.

The custody layer writes a refresh intent before sending a single-use refresh
token. A crash between the token response and successor-session commit leaves
that intent durable, and every later restore refuses with an indeterminate
outcome instead of replaying the predecessor. The official client additionally
revokes and deletes a successor if its store callback fails. A separate
refresh-disabled diagnostic primitives remain available for inspections that must
not alter credential custody.

The bounded capture invokes no ATProto write RPC and creates no application
preview, approval, job, or policy state. Its only permissible local mutation is
OAuth credential custody required to preserve a rotated read grant. It makes at
most one bounded Home and one bounded Discover acquisition. Credentials are
used only in process and never enter the capture or its diagnostics.

Analysis removes exact duplicate observation IDs deterministically. Home and
Discover retain their own order. The combined view is explicitly ordered as the
Home capture followed by the Discover capture; it is not a claim about a single
interleaved user timeline. “Would suppress” is a counterfactual over captured
order, not a claim about recommender causality or future delivery.
