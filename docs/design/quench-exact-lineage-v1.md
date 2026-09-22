# Exact-lineage Quench preview

Status: **qualified local preview primitive; no feed-enforcement adapter**
Recorded: 2026-09-22

This is the smallest deterministic implementation of “stop showing me this
conversation” that fits the current atproto-acl architecture. It is a local
attention-policy decision, not moderation state and not an actor mute or block.

## Policy contract

Policy format v1 has one optional additive field:

```yaml
attention:
  suppress_lineages:
    - at://did:plc:example/app.bsky.feed.post/3lroot
```

Each value is one exact `app.bsky.feed.post` AT URI. Values are unique and
canonicalized into lexical order by the strict compiler, so they participate in
the ordinary policy hash and portable behavior hash. Removing a value removes
its effect on the next evaluation. Existing v1 documents without `attention`
retain their existing meaning and hashes.

The compiler requires at least one `feed_exposure` source when this field is
present. This prevents a valid-looking rule that has no item-level input.

The guided editor deliberately refuses this advanced field instead of silently
dropping it. The YAML editor, portable export/import, compiler, acquisition,
receipt, and preview paths preserve it.

## Lineage evidence

For a root post, the canonical lineage is the post's own URI. For a reply, the
extractor uses the declared `reply.root` URI already present in the hydrated
feed item and/or its embedded post record. It does not fetch or walk parents.

When record-level and hydrated roots are both present they must agree. A missing
root remains `unknown`; a non-post AT URI is `malformed`; disagreement is
`conflict`. Parent is retained as bounded provenance but never promoted to a
root. Deleted, blocked, or unavailable hydrated roots remain usable when their
view carries the same valid root URI. Reposted replies retain the target post's
declared root. Quote edges are outside this contract.

## Composition and effect

The existing account evaluator still evaluates actors and proposes its existing
private-mute actions. Exact-lineage evaluation produces a separate item-level
receipt row with one of `suppress`, `allow`, or `indeterminate`. It never creates
an actor action, changes actor precedence, or enters the worker's approval and
write journal.

The current effect is therefore **preview-only**: the hosted result can explain
which sampled feed items would be suppressed, the exact root rule, and why an
item was left indeterminate. It does not yet filter Bluesky Home, Discover, a
generator feed, notifications, search, or any third-party client. A future
feed/client adapter must preserve this exact decision identity and must not
translate it into per-actor mutes.

## Qualification boundary

The forcing corpus travels through the real bounded `extractFeedExposures` path
and contains a root, replies by multiple actors, a reposted reply, an unrelated
thread containing the same actor, and missing/conflicting lineage. Tests prove
that the selected root and its replies are suppressed, the same actor elsewhere
is allowed, incomplete lineage is not guessed, removing the rule restores
ordinary evaluation, and actor decisions remain independent.

No retained privacy-safe production Home/Discover snapshot containing reply
roots was available in the inspected campaign evidence. Consequently this
tranche qualifies the structure and behavior against protocol-shaped fixtures,
not the prevalence of repeated lineages in a real account's feeds. The next
empirical prerequisite is a bounded, body-free read-only capture under existing
account authority; absence of that capture does not justify a crawler.
