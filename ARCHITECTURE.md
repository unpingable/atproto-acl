# Architecture

```text
AccountSource ── subjects/coverage ─┐
ObservationProvider ── evidence ────┤
                                   v
                      coverage and admissibility
                                   v
                      pure compiled policy evaluator
                                   v
                      exemptions and user overrides
                                   v
                         desired disposition
                                   v
                adapter eligibility and reconciliation plan
                                   v
                    explicit execution + durable receipt
```

The core is `atproto_acl.policy`: immutable compiled configuration, explicit
evaluation time, and three-valued predicates. Rule ordering has no meaning;
compiled rules are sorted by name for stable hashing and reporting. It imports
no persistence, credentials, network, or action adapters.

`model` defines structural interfaces for account sources, evidence providers,
and action adapters. An observation retains its publisher identity rather than
using a global label taxonomy. Numeric properties require an explicit provider
measurement contract. The live label provider supplies categorical observations
only; typed numeric observations are exercised through fixtures in V0.

Admissibility is evaluated before a predicate can contribute a match. A complete
subject query permits absence to count as false. A failed/partial query leaves
unexpired assertions unknown, including cached assertions that may have unseen
negations. Expired positive quarantine evidence loses standing even during an
outage. Its absence does not establish a negated predicate. Higher-precedence
allow rules require current coverage to establish their absence: an expired
allow assertion during an outage cannot silently enable a lower-priority mute.

`labels` resolves DID documents, verifies `#atproto_label` signatures, normalizes
account evidence, and polls with bounded pagination. Original signed labels and
retrieval provenance are retained. Record-level/version-specific labels are not
converted into account properties. Invalid subject evidence makes that subject's
query incomplete. Key rotation triggers a DID/key refresh on signature failure.

`sources` discovers accounts independently of rule meaning. Broad label polling
is resumable, but has no claim to universal history. Previously discovered label
subjects and historically affected subjects remain candidates for reevaluation.
An account leaving a timeline sample is not a release signal.

The Bsky38 adapter is a bounded external snapshot source. It fetches one fixed
HTTPS origin, rejects redirects, limits time and response size, and accepts only
an exact 38-DID structured snapshot. Snapshot observations participate only in
the current acquisition and are not promoted into the durable ATProto evidence
cache. A structural or transport failure yields incomplete coverage. Approval
still binds exact subject actions, and execution reevaluates current membership;
a changed roster can remove an approved action but cannot add or substitute one.

`runtime` combines these services, computes dispositions, resolves overrides, and
builds receipts. The private-mute adapter advertises conditional release through
review and no ability to prove current ownership. Runtime execution verifies
proposal eligibility, observes state immediately before a write, and reevaluates
evidence at write time. There is no automatic private unmute path.

`store` binds a SQLite database to one account and evidence mode. A file lock
serializes the runtime; journal transactions are committed before remote calls.
If the process vanishes after a request, the pending action and unresolved ledger
survive. A successful HTTP response records historical attribution, not exclusive
ownership of every future indistinguishable state.

Future native-list adapters can identify exact membership records in a managed
roster. Future feed adapters control internal inclusion. Neither capability is
inferred for private mutes.

The hosted boundary is a server-side BFF:

```text
browser ─ opaque session ─ Node web ─ exact approval ─ SQLite job
                              │                         │
                         OAuth SDK                 durable worker
                              │                         │
                    source/state reads       applicability recheck
                              └──── JSON protocol ──── Python engine
                                                        │
                                                 action journal
```

`web/` owns browser OAuth, application sessions, per-user rows, source
acquisition, approvals, and jobs. It invokes the narrow `atproto-acl-host` JSON
protocol; policy evaluation never runs in browser code. The protocol calls the
same compiler, evaluator, override store, receipts, and action journal as the CLI.
It is not an import dependency on another ATProto application.

An approval binds account DID, policy identifier and revision, effective context,
action kind, exact subject/action/fingerprint tuples, and a batch digest. The
worker recomputes a current receipt before effects. It may skip an approved item
whose evidence, policy, overrides, or moderation state changed. It cannot add or
substitute an item. One worker processes actions sequentially; a SQLite claim
prevents another worker from taking the same job.

The worker commits an `attempting` phase and Python journal row before an external
call. A clean response followed by exact readback confirms the outcome. A process
exit or ambiguous error after that phase becomes `uncertain` and is never replayed
automatically. Cancellation is observed between items. Closing a browser has no
effect on an approved job.
