# State and receipts (version 1)

SQLite metadata binds `schema=1`, the operating account DID, and evidence mode
(`live` or `fixture`). Opening the same database with another binding fails.
This is the initial schema; future incompatible versions require an explicit
migration rather than reinterpretation.

Tables retain identity pins/migrations, overrides/audit entries, canonical
observations, discovery cursors/subjects, consequence ledger, attempts, and saved
receipts. Observation insertion is deduplicated by semantic digest. The first
retrieval and original provider evidence remain attached to that observation.

The ledger statuses are `attributed`, `released`, `suspended`, `unresolved`, and
`untracked`. An attempt is durably `pending` before its request. Confirmed HTTP
success makes it `confirmed`; failure leaves it `unresolved`. Process loss can
leave `pending`, with the subject already unresolved. Neither status admits a
retry without explicit user reconciliation.

Receipts contain schema, UUID, account, canonical policy/hash, override hash,
explicit evaluation time, identity history, source coverage, relevant evidence,
adapter capabilities, per-subject decisions/actions, and execution results.
Evidence includes publisher, subject, property/value, observation/expiry times,
stable digest, provider-specific identifier, original evidence, retrieval time,
and endpoint provenance. Raw credentials are never retained.

Per-subject rows separate `evaluation.outcome` from `desired`, and include
`observed`, `action`, `reason`, `ownership`, `manual_review_required`, matched and
unresolved rules, disagreements, and applicable overrides. A fingerprint binds
the proposal's decision inputs and observed state, excluding retrieval time.

Release selection refers to a saved proposal UUID and explicit DIDs. Runtime
compares policy/account/override bindings and per-subject fingerprints after fresh
collection. Before each effect, it re-observes state and re-evaluates temporal
standing. An old proposal cannot release a now-justified quarantine.

Preview records its evidence and proposal locally but performs no remote writes.
Fixture input has `version`, `account`, `subjects`, `observations`, `coverage`, and
optional `identities`, `discovery`, and `remote` fields; see `examples/demo.json`.
Fixture evidence is explicitly trusted local input for offline demonstrations,
not a signed-provider import mechanism. It can never enforce.

For recovery, retain the database together with its WAL until SQLite has closed
or use SQLite's backup API. Inspect the saved proposal, attempt status, and remote
state. `resume --acknowledge-unknown-history` discards attribution and audits the
decision. It does not assume whether an uncertain request committed.

## Additions in 0.1.1

These fields are additive within receipt schema 1. Existing database and receipt
records remain readable; no SQLite migration is needed. Older release proposals
without `effective_config_hash` require a fresh preview and review. Existing
`policy_hash`, `override_hash`, `basis`, and outcome strings retain their meaning.

### Disposition reasons

`evaluation.reason_codes` explains the current pure policy result. Each row's
`disposition_reasons` includes applicable explicit overrides and grounded
historical transitions:

- `allow_won`: a conclusive allow rule defeated lower-precedence dispositions.
- `quarantine_evidence_expired`: expiry (including policy maximum age) removes
  standing that could otherwise contribute to quarantine. This is an explanation
  of the current basis, not a claim that the rule previously matched. The
  diagnostic checks the full Boolean rule; unrelated expired evidence is not
  reported as the cause of an independently false rule.
- `quarantine_rule_no_longer_matches`: a rule matched in the saved receipt of a
  confirmed historical mute and is now conclusively false for a non-expiry reason.
  `no_longer_matching_rules` names those rules and `previous_quarantine_receipt`
  links the prior evidence. Attribution is not current ownership.
- `no_matching_quarantine_rule`: there is no current matching justification and
  insufficient history to assert a transition.
- `explicit_allow_override`: the user's override changes desired disposition.
  The original evaluator result remains separate.

Rule details include `expiry_blocks_match`; `quarantine_rule_matched` and
`unresolved_precedence` describe the other evaluator outcomes. Multiple causes
can be recorded when independently applicable. Indeterminate evidence is never
reported as a conclusively ceased match.

### Completeness

Top-level `complete` is a Boolean conjunction of `completeness.discovery`,
`evidence`, `evaluation`, `remote_state`, `relationship`, and `execution`. `incomplete_reasons`
lists the false components. Evidence, evaluation, and state requirements apply
to nonexempt subjects; missing reads cannot be hidden by an empty coverage array.
Every configured account source must supply a discovery result. A bounded
completed timeline sample is complete within that sample, not across ATProto.
An exhausted label endpoint does not establish complete historical coverage.

Preview exit status remains 0 for a successfully generated partial report.
Unknown remote state, inconclusive evaluation, partial acquisition, refused
execution, and skipped/uncertain writes remain explicit. A pending manual release
is a fully described proposal and does not itself make acquisition incomplete.

Hosted feed previews retain a body-free exposure snapshot for 30 minutes. Approval
binds the user DID, policy revision, effective context, exact subjects/actions, and
row fingerprints. Execution reuses that saved subject snapshot instead of sampling
an algorithmic feed again, then refreshes labels, follow relationships, and mute
state. Changed standing skips the item; it cannot substitute or add an account.

### Hashes

All digests use SHA-256. `policy_source_hash` hashes the exact supplied UTF-8 text,
including comments, whitespace, and line endings. Other hashes use canonical
JSON. `policy_hash` remains the canonical compiled policy hash, including account
sources and configured providers, with rule order normalized.

`effective_configuration` is stored with `effective_config_hash`. It binds its
contract version, engine version, operating DID, evidence mode, semantic policy
hash, resolved overrides, current identity pins, adapter, and capabilities.
Publisher catalogs currently do not influence evaluation; the configuration
explicitly records `publisher_catalog.status: not_consulted` and
`affects_evaluation: false`. The catalog CLI is an inspection tool, not an
implicit policy input.

`decision_context` is stored with `decision_context_hash`. It binds its contract
version, effective configuration hash, normalized evaluation time, subject set,
discovery results, coverage (including check times), semantic evidence IDs,
observed moderation state, ledger snapshot, and historical receipt references.
Evidence transport metadata such as refetch time and endpoint spelling does not
renew standing or change this hash by itself. Original transport provenance is
still retained alongside the evidence. This is the pre-execution decision
snapshot, not an execution log hash; writes retain their separate journal.

Release validation compares effective configuration and per-subject fingerprints.
It does not compare the entire decision-context hash: time and read-check times
naturally advance between review and execution. Changed pins now invalidate a
review even if the selected subject's remote state looks unchanged. Comment-only
YAML edits do not invalidate a semantically unchanged proposal.
