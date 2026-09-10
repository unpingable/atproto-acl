# Policy reference (version 1)

Required root fields: `version: 1`, `account`, `providers`, `sources`, and `rules`.
Optional root fields: `exempt`, `allow`, `keep_muted` (lists of DIDs or handles).
Unknown keys and duplicate YAML keys are errors.

Provider aliases map to `{type: atproto_labels, did: ...}` or the narrowly
supported `{type: external_list, did: did:web:bsky38.com}`. This source is an
unauthenticated third-party HTML snapshot, not DID-signed publisher evidence; its
retrieval digest is retained with each acquisition. Rules explicitly name
an alias with `source`; there is no implicit global label source. `fixture`
providers permit offline demonstrations, including declared `measurements`.
V0 live providers do not offer numeric measurements.

```yaml
rules:
  - name: friends-can-poast
    disposition: allow
    when:
      source: trusted
      label: member
  - name: heavy-posting
    disposition: quarantine
    when:
      all:
        - source: activity
          label: high-volume
          max_age_seconds: 86400
        - not:
            source: activity
            label: temporary-exception
```

`all` and `any` require nonempty lists. `not` accepts one predicate. Leaves
require `source` and either `label`, or `property` with `op` and a finite numeric
`value`. Numeric operators are `eq`, `gt`, `gte`, `lt`, `lte`; the provider must
declare the property's measurement semantics. Nesting is limited to 32 levels.

Rule dispositions are `allow`, `quarantine`, and `neutral`. Evaluate every rule;
the greatest conclusively matched disposition wins. An unresolved rule above the
current winner makes the result indeterminate. `neutral` is a rule contribution;
evaluator outcomes use `no_quarantine_justification`, never a claim of subject
neutrality. Names are unique and identify
rules in receipts, not priority.

| Conclusive matches | Material unresolved rule | Outcome |
| --- | --- | --- |
| allow and quarantine | any lower rule | no justification, basis allow |
| quarantine | none | quarantine |
| none | none | no justification |
| quarantine | allow | indeterminate |
| none | quarantine or allow | indeterminate |

Boolean unknown propagation uses strong three-valued logic: false dominates
`all`, true dominates `any`, and `not unknown` stays unknown. Expiry removes an
assertion's standing; incomplete coverage cannot establish negative evidence or
the absence of a potentially higher-precedence allow rule.

Account source forms:

```yaml
sources:
  - type: explicit_dids
    dids: [did:plc:example]
  - type: follows
    actor: optional-handle.example
    limit: 10000
  - type: timeline
    limit: 500
  - type: feed_exposure
    surface: timeline
    limit: 500
    followed: review
  - type: feed_exposure
    surface: generator
    feed_uri: at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot
    limit: 500
    followed: review
  - type: labeled_stream
    provider: activity
    limit: 5000
  - type: external_snapshot
    provider: bsky38
    url: https://bsky38.com/
    limit: 38
```

Sources form a union, deduplicated by DID. Timeline limits count feed entries;
the resulting author set may be smaller. Label discovery limits count label
records and each request is reduced to the remaining bound. Follows and label
sources report truncation; a completed bounded timeline is a sample, not universal
coverage. `external_snapshot` is currently hard-pinned to the Bsky38 provider,
origin, and 38-member bound; arbitrary server-side URLs are rejected.

`feed_exposure` is a hosted acquisition contract. Its limit is 1–500 feed items.
Timeline forbids `feed_uri`; generator requires an exact feed-generator AT URI.
The hosted adapter records body-free post URI/CID provenance, considers top-level,
repost-target, and hydrated quote authors independently, and bounds quote traversal
to four levels and sixteen authors per item. `followed: review` routes confirmed
followed matches to a separate approval class. A missing or malformed relationship
is unresolved and cannot propose a mute. The CLI refuses live `feed_exposure`
because it does not implement this provenance adapter; hosted and fixture inputs do.
