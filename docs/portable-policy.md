# Portable policy YAML

The portability invariant is:

> An exported policy contains everything necessary to reproduce the user's
> intended policy behavior using the standalone CLI, excluding only
> observational and history artifacts whose absence cannot change intended
> policy.

The v1 portable document is a transport envelope, not evaluator policy v2. Its
`policy` value remains exactly the v1 evaluator input. `provenance` is custody
metadata and does not affect behavior or `policy_hash`. `account_rules` carries
the hosted service's adjacent user intent as three independent sets:
`leave_alone`, `always_keep`, and `never_unmute`. A DID may occur in multiple
sets; the evaluator composes those sets with inline `exempt`, `allow`, and
`keep_muted` using the existing runtime semantics.

`policy_hash` identifies the embedded evaluator policy.
`portable_behavior_hash` identifies the normalized policy plus normalized
independent account-rule sets. Handle annotations and export timestamps affect
neither identity.

The CLI accepts both portable envelopes and legacy bare `version: 1` policies.
Routing uses the `format: atproto-acl.portable-policy` discriminator. Unknown
format, `format_version`, or `account_rules.version` values are refused rather
than guessed.

Hosted imports parse and validate first, show policy and account-rule changes
separately, and require explicit confirmation. Replacement replaces all three
account-rule sets; it never silently merges them. An optional live scan creates
ordinary retained preview evidence but is not structural validation.

If the hosted service disappears, use the file directly:

```bash
atproto-acl preview --policy atproto-acl-policy.yaml --authenticate
```

Only credentials or local contact configuration are supplied separately.
Receipts, scan history, jobs, and service database state are deliberately not
part of the portable policy.
