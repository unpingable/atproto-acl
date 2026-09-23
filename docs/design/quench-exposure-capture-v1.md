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

The capture retains the coherent ordered prefix available from each feed, up
to the configured bound (at most 500 items). Home and Discover need not contain
the same number of observations. A prefix is coherent only when acquisition
either reaches the requested bound or terminates normally without a continuation
cursor, and every retained observation passes extraction and privacy validation.
Authentication or transport failure, repeated or otherwise ambiguous pagination,
malformed response data, incomplete serialization, and privacy violations refuse
the whole capture. Samples are never padded, resampled, or trimmed merely to
equalize the feeds.

The qualification receipt records each feed's actual count and terminal
condition. A feed with fewer than 100 observations is retained when it exhausted
normally, but its empirical conclusion is explicitly `underpowered`. The other
feed can still support a separately denominated conclusion. A preceding
count-only diagnostic may retain only request bound, count, page count, final
cursor presence, terminal condition, and timestamps; it must not retain any
post, actor, lineage, response-content, header, or credential field.

Analysis removes exact duplicate observation IDs deterministically. Home and
Discover retain their own order. The combined view is explicitly ordered as the
Home capture followed by the Discover capture; it is not a claim about a single
interleaved user timeline. “Would suppress” is a counterfactual over captured
order, not a claim about recommender causality or future delivery.
