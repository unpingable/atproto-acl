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

Capture uses an existing OAuth session only when it already grants
`app.bsky.feed.getTimeline` and `app.bsky.feed.getFeed` and its access token has
at least ten minutes remaining. The guarded operator harness opens the
application database read-only, restores without refresh, and refuses any
refresh-token grant at the fetch boundary. It invokes no write RPC, creates no
application preview, approval, job, or policy state, and makes at most one
bounded Home and one bounded Discover acquisition. Credentials are used only
in process and never enter the capture or its diagnostics. An expired or stale
session requires a separate, explicitly authorized reconnect; the harness will
not rotate OAuth state and lose the replacement in a read-only run.

Analysis removes exact duplicate observation IDs deterministically. Home and
Discover retain their own order. The combined view is explicitly ordered as the
Home capture followed by the Discover capture; it is not a claim about a single
interleaved user timeline. “Would suppress” is a counterfactual over captured
order, not a claim about recommender causality or future delivery.
