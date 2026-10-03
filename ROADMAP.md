# Roadmap

## Public beta gate

- [x] Open admission without invite codes; new accounts start preview-only.
- [ ] Verify two new users under concurrent acquisition with strict isolation.
- [ ] Diagnose and qualify Chrome OAuth while retaining Firefox coverage.
- [x] Enforce durable admission, write, queue, and global capacity controls.
- [x] Verify restore-after-deletion suppression across every retained backup
  generation in the controlled restore fixture.
- [ ] Complete a bounded mute, confirmed readback, reviewed release, and unmute.
- [x] Publish a clean-root repository and verify its post-publication security
  settings and artifacts.
- [ ] Verify the support contact and approve the immutable launch packet.

Publishing the repository and calling the service a public beta remain separate
decisions after the open-preview tranche. Open preview does not grant moderation-write
access.

## Current accepted build (2026-10-03)

Structural Quench exact-root preview and durable OAuth custody are built and
synthetic/browser/installed-artifact qualified (PR #2). Live runtime remains
`38151f17d6675711916a1af439be72b1726852c8`; build acceptance is not a runtime
cutover or public-beta acceptance. Exact declared-lineage suppress/allow/unknown
has no feed-enforcement adapter and performs no actor mute or approval.
The capture CLI now contains upstream exceptions in fixed diagnostics and
closes its database before emitting a coherent body-free capture; deterministic
refusal tests do not establish live OAuth interoperability.

## Later

- Expand the guided editor while preserving exact refusal for unsupported YAML.
- Add UI-assisted handle pin review and explicit rebinding.
- Evaluate moderation-list and feed-filter adapters with explicit ownership.
- Qualify a currently maintained self-hosted PDS.
- Add policy packs only when their observation and ownership semantics are clear.
- Structural exact-root preview is implemented; guided editing and a separately
  authorized feed/client adapter remain future product work. Inferred/adaptive
  negative-attention research stays unscheduled; see
  [negative-attention design](docs/design/negative-attention-policy.md).
