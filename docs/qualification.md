# Qualification status

This file states what the public test suite establishes. Live acceptance records,
account identifiers, job IDs, host paths, and production observations are kept in
private operator evidence rather than source control.

## Covered by automated fixtures

- policy precedence, three-valued evidence, expiry, exemptions, and keep-muted;
- identity resolution and explicit rebinding;
- preview completeness and exact action-batch binding;
- two-user route and data isolation;
- confirmed, failed, skipped, and uncertain action outcomes;
- interruption before and after an external effect;
- reviewed release behavior and preservation of pre-existing mutes;
- CSRF, session expiry, reconnect/disconnect, and browser refresh recovery; and
- desktop, mobile, and keyboard browser journeys.

Fixture tests use synthetic identities and block network access. They do not prove
interoperability with a real authorization server, PDS, AppView, feed generator,
or label publisher.

## Live claims

A release may be described as live-qualified only when its private acceptance
record names the exact source revision and immutable artifact. Live browser OAuth,
feed acquisition, mute/readback, and reviewed release evidence must be reported
separately from fixtures.

The open limited preview is qualified in Firefox. Chrome OAuth remains a public-beta
blocker until a current release completes the full sign-in and return journey.
A real self-hosted-PDS account has completed OAuth and established an application
session. Its first fresh scan was blocked by the release's missing Python bridge,
so this is partial portability evidence rather than qualified scanning support;
repeat the read-only scan after deploying the corrected artifact contract.

## Publication gate

Before calling the service a public beta, the operator verifies a clean public history,
repository security settings after visibility changes, support contact reachability,
Chrome OAuth, multi-user isolation, deletion-through-restore behavior, global capacity
controls, the immediate write gate, and one bounded mute/readback/reviewed-release
lifecycle. The repository is public; open-preview admission remains a separate control
and does not grant new accounts moderation-write access.

Every deployed candidate must also complete the fresh-account journey from the
operator guide: initial read-only OAuth, creation and validation of a new policy,
preview, and authoritative override read. Preserved accounts and policies do not
exercise enough of the release boundary to satisfy this gate.
