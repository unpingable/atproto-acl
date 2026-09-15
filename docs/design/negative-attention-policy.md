# Negative-attention policy: reply lineage by root author

Status: **BACKLOG / DESIGN RESEARCH — NOT IMPLEMENTED**  
Working terms: **anti-algorithm**, **negative attention policy**, **origin
mute**, **quench** — “quench it rather than ban it”: reduce routed exposure
to a class of material without banning or morally classifying the people
producing it  
Recorded: 2026-09-13

This note preserves a product and policy distinction. It does not authorize a
schema change, evaluator change, feed filter, UI, new service, ingestion,
moderation action, or deployment.

## User need

Ordinary actor mute means “do not show me Alice.” The proposed primitive means:

> I may or may not care about Alice generally, but I do not want conversations
> Alice starts to recruit my attention through everyone else.

If Alice starts a thread, its root and replies by Bob and Carol may be hidden.
Bob's unrelated garden post and Carol's reply there remain visible. This is a
user-controlled attention rule, not moderation of Alice and not a claim that
Alice did anything wrong.

The narrow first rule to investigate is approximately:

```yaml
attention:
  suppress_reply_trees_by_root_author:
    - did:plc:example
```

The spelling and placement are provisional. Stable DIDs are policy identity;
handles are enrollment and presentation conveniences. A handle is resolved to
a DID when the user adds it and does not silently rebind after a handle change.

## Initial semantic boundary

The first useful implementation may cover only deterministic ordinary reply
lineage:

| Case | Proposed initial standing |
|---|---|
| Root post authored by selected DID | suppress when `hide_root_and_replies` is the selected mode |
| Direct reply | suppress when the reply's declared root AT URI belongs to selected DID |
| Arbitrarily deep reply | same; use `reply.root`, not a bounded parent walk |
| Root record deleted or unavailable | root URI can still establish repository DID if the reply record is otherwise admitted as authentic input; content hydration is not required merely to parse the DID |
| Repost of the root or a reply | unresolved pending proof that every acquired feed/view path retains the repost target's reply-root metadata |
| Quote post or quote cascade | outside initial semantics; quotes form a propagation DAG and must not be advertised as ordinary reply lineage |
| Independent post on the same topic | visible; semantic similarity is not lineage |

Modes with materially different behavior must not become one ambiguous toggle:

- hide root and replies;
- hide replies but allow the root;
- hide reposts whose target belongs to the lineage;
- hide confidently attributable quote descendants;
- suppress one exact root thread rather than every root by an author;
- time-bound suppression of one lineage.

The root author can be obtained from a valid root AT URI without resolving the
root record. That establishes declared lineage, not content validity or causal
origin. Malformed, absent, contradictory, or truncated relationship data must
produce an explicit unresolved standing under the selected mode; it must not
silently become either visible-by-proof or suppressed-by-guess.

## Fit with current ACL architecture

The current v1 evaluator is actor-oriented: it compiles strict `sources` and
label/measurement `rules`, evaluates one subject DID, and proposes actor-level
mute/unmute actions. The local enforcement path uses ATProto actor mutes. It
cannot express “hide Bob here but allow Bob elsewhere,” so this feature must
not be faked by muting every participant.

Existing pieces worth reusing are:

| ACL primitive | Reuse | Required seam |
|---|---|---|
| Strict policy compiler, canonical policy hash, duplicate/unknown-key refusal | Versioned representation and deterministic identity | Decide whether attention rules are an additive section/container or a later policy format; do not reinterpret v1 documents |
| Portable policy envelope | User custody and CLI/web round trip | Any behavioral lineage rules must enter `portable_behavior_hash` and be understood by both CLI and web before portability is claimed |
| Guided editor and advanced YAML refusal | A legible guided card plus exact fallback | Guided mode must round-trip every represented mode and refuse unsupported quote/repost semantics |
| DID resolution and DID-bound account rules | Enrollment by handle, stable stored authority | Preserve last-known handle as annotation only; explicit rebinding remains a user act |
| Feed-exposure acquisition | Bounded feed pagination, exact post URI/CID, repost introducer and quote provenance | Current body-free summaries do not retain reply-root lineage; determine whether evaluation can occur during hydration with a bounded, receipt-worthy lineage summary |
| Preview/approval and reason reporting | Side-by-side context preview and an exact explanation | Preview actions here are per-feed-item suppression decisions, not actor mute batches; action ownership and rollback semantics differ |
| Three-valued evidence and incomplete reasons | Fail honest on missing lineage data | Define visibility/suppression behavior for UNKNOWN separately from moderation quarantine precedence |
| Bounded bridge/executor controls | Resource budget and refusal | Hydration or lineage checks may not create unbounded per-item network work |

This most naturally extends the ACL policy vocabulary and explanation model,
but it likely needs a **feed-filter adapter** rather than the current
`muteActor` enforcement path. The existing roadmap already calls for evaluating
feed-filter adapters with explicit ownership. No parallel policy engine should
be created: a future adapter should consume the same compiled, portable,
explainable user policy and emit a different action class.

Whether the feature can remain entirely local depends on the user's client or
feed path accepting a filter. It is local/user-side attention governance; it
must never be described as protocol enforcement, server moderation, or a
restriction on another user's speech.

## UX and explanations

Candidate guided-card language:

> **Hide threads started by selected accounts**
>
> Posts by other people remain visible normally. Their replies inside
> conversations started by these accounts are hidden.

A hidden descendant should explain its lineage rather than blame its visible
author:

> Hidden because this post belongs to a conversation started by
> @alice.example, which is suppressed by your “Hide threads started by…”
> policy.

Preview must show contextual contrast:

```text
Bob normally          ALLOW
Bob replying in X     SUPPRESS (root-author lineage policy)
Bob elsewhere         ALLOW
```

The receipt/explanation needs the policy rule identity, evaluated post URI/CID,
declared root URI, parsed root-author DID, acquisition path and coverage, result
(`ALLOW`, `SUPPRESS`, or `UNKNOWN`), and exact reason code. It should not retain
post bodies merely to make the explanation convenient.

Policy removal should stop future filtering immediately. Any cache must be a
bounded reconstructible projection of the current policy plus observed lineage,
not hidden service-only intent.

## Research questions

- Which ATProto record/view fields are present and authenticity-bound on every
  intended timeline, generator-feed, CLI, and local-client path?
- Does the hydrated `FeedViewPost.record.reply.root` preserve a usable strong
  reference in practice, and how are malformed parent/root disagreements
  represented?
- Can evaluation remain deterministic and monotone without fetching the root?
  If hydration is required, what is the bounded request/cache contract?
- What is the feed-scale CPU, memory, and network cost, including cold cache?
- When a root is unavailable, is URI-only attribution sufficient for the
  chosen mode, and which facts remain unknown?
- For a reposted reply, does every relevant view preserve both the repost
  target and that target's root? If not, repost lineage stays unsupported.
- Quote posts and cascades are DAG-like: what exact, confidence-bearing rule
  could ever support them without semantic inference?
- How does lineage suppression compose with existing Bluesky mutes/blocks,
  follows, explicit allow/exempt rules, feed-exposure review, and indeterminate
  policy outcomes?
- What adapter can enforce item-level suppression while preserving exact
  preview/approval, ownership, and local portability?
- How are cached handles displayed after rename without changing the DID-bound
  policy?

## Qualification cases

Before implementation is promoted beyond backlog, require at least:

1. selected root author → direct reply suppressed;
2. deep descendant suppressed from its declared root;
3. the same respondent outside that lineage allowed;
4. unrelated same-topic post allowed;
5. deleted/unavailable root with valid retained root URI handled according to
   the documented URI-only rule;
6. handle changes after enrollment without silent DID rebinding;
7. overlapping origin policies with deterministic explanation;
8. policy removal immediately restoring visibility;
9. preview and receipt naming the root-origin policy rather than the reply
   author;
10. malformed, missing, or contradictory reply roots yielding the specified
    unresolved behavior;
11. repost and quote cases either correctly qualified or explicitly reported
    outside current semantics;
12. web-produced and CLI-produced portable policies round-tripping with the
    same behavior identity;
13. bounded large-feed evaluation with cache cold/warm measurements and no
    unbounded hydration;
14. legacy v1 policies remaining behaviorally unchanged.

## Broader anti-algorithm research

An anti-algorithm is a user-authored rule describing what may **not** recruit
the user's attention, including indirect propagation through other people. It
complements recommendation rather than trying only to build a better
recommender. Future candidates include:

- one exact discourse lineage forever or for a bounded time;
- stop a thread after N replies, participants, or a velocity threshold;
- suppress attributable quote cascades;
- “I've seen enough”: hide later descendants or derivatives;
- suppress material arriving through selected discourse brokers;
- adaptive quenching: learn from the user's repeated rejection of a source,
  lineage, or propagation neighborhood across Home, Discover, and custom
  feeds, and progressively tighten suppression of that class rather than
  requiring the user to enumerate every account or phrase; any learned rule
  must remain inspectable, explicable (“suppressed because this thread
  originates from X / matches a repeatedly rejected propagation
  neighborhood”), and reversible, so the mechanism never becomes an opaque
  replacement recommender;
- eventually, evidence-informed propagation rules.

Only explicit ATProto relationships belong in the deterministic first tranche.
Semantic derivatives and broker inference require substantially stronger
evidence and remain separate research.

Observatory NG has a distinct backlog question about discourse initiation and
cross-neighborhood transmission. The concepts should remain compatible, but
ACL must not depend on that inference. The progression is:

```text
explicit ATProto reply lineage policy
    first

inferred discourse-propagation policy
    only after independently qualified Observatory evidence and confidence
```

ACL must remain useful and correct when Observatory is absent, stale,
indeterminate, or never implements that research.

## Resume point

Future design work should begin with a read-only feed-view corpus and answer
the record-field/adapter questions above. Then specify a versioned policy and
three-valued item-decision contract before changing the guided editor. No UI
card should be built until the enforcement adapter and portable semantics are
real enough to preview honestly.

