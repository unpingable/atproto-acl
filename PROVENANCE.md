# Provenance and verification

The evaluator and adapters are implemented in this repository. The design draws on
common patterns from the author's ATProto observatory work—bounded acquisition,
provenance-carrying evidence, dry-run receipts, identity pinning, and conservative
write reconciliation—without importing another application or its authority.

The hosted application uses an independent SQLite store and the official ATProto
OAuth client. OAuth/session patterns were reviewed against an existing community
application and then reimplemented within atproto-acl's smaller trust boundary.
See the [reuse matrix](docs/reuse-matrix.md) for the component-level account.

Protocol references include:

- [ATProto labels](https://atproto.com/specs/label)
- [ATProto OAuth specification](https://atproto.com/specs/oauth)
- [OAuth application patterns](https://atproto.com/guides/oauth-patterns)
- [Permission scopes](https://atproto.com/specs/permission)
- [Private mute API](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/graph/muteActor.json)
- [Timeline API](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getTimeline.json)
- [Feed API](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/getFeed.json)
- [Relationship API](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/graph/getRelationships.json)
- [Embedded records](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/record.json)

The test suite uses signed synthetic labels, fake OAuth sessions, controlled
adapters, and network blocking. It covers evaluator behavior, schemas, pagination,
resource limits, identity migrations, action recovery, web account isolation, and
browser journeys. These results establish implementation behavior only. Current
live interoperability claims and gaps are summarized in
[qualification status](docs/qualification.md); detailed live evidence stays in the
protected operator record.

Release archives include examples and documentation. Python package metadata
identifies the project as `MIT OR Apache-2.0` and includes both license texts.
Direct dependency licensing is recorded in [third-party notices](THIRD_PARTY_NOTICES.md).
