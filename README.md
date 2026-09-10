# atproto-acl

atproto-acl helps you decide which accounts you want to hear from in ATProto
feeds. It samples accounts that appear in selected feeds or account sources,
checks observations published about them, evaluates your policy, and shows the
result before anything changes.

The hosted beta is at [atproto-acl.neutral.zone](https://atproto-acl.neutral.zone).
Admission is currently restricted while browser and multi-user qualification is
completed. Firefox is supported for the pilot; Chrome OAuth remains under
investigation.

## What it does

The central boundary is simple: publishers observe, users decide, and adapters
enforce. A match means only that available observations matched a policy the user
chose. The application does not infer intent, mental state, ideology, toxicity,
or information quality.

**Poasters Quarantine** is the first example policy. It looks for publisher-defined
posting-frequency labels among accounts found in Timeline and Discover samples.
It can suggest private mutes, including for accounts injected through reposts and
quoted posts. It is optional and is not the name or semantic boundary of the
engine.

The normal workflow is:

1. Sign in with ATProto OAuth and confirm the active account.
2. Choose account sources and configure a policy with the guided editor.
3. Preview the results and inspect why each account matched or is unresolved.
4. Select an exact set of proposed changes and approve it.
5. Follow durable per-account outcomes in Action history.

The advanced YAML editor uses the same server-side parser and policy validator as
the guided editor. An invalid draft can be repaired but cannot be previewed or
executed.

## Safety model

- No policy is implicitly enabled, and preview is always safe and read-only.
- Policy composition is order-independent: `allow > quarantine > neutral`.
- Missing, expired, or unavailable evidence is distinct from a negative result.
  If unresolved higher-precedence evidence could change an answer, the answer is
  `indeterminate` and cannot authorize a new mute.
- Approval is bound to the account, policy revision, evidence, and exact action
  set. Changed conditions cannot silently expand or substitute the batch.
- Existing mutes are preserved. The tool records whether a confirmed mute was
  created by an approved action, but historical authorship does not prove current
  ownership after arbitrary out-of-band changes.
- Releases are proposed and reviewed separately. atproto-acl never automatically
  unmutes an account merely because a policy stopped matching.
- Pending, failed, skipped, and uncertain effects remain different states.
  Uncertain writes are reconciled by observation rather than blindly repeated.

## What the hosted service reads and stores

The hosted service reads the signed-in account identity, PDS, selected feed or
account-source results, relationship and mute state needed for evaluation, and
observations from configured publishers. Feed exposure records retain post
URI/CID references and provenance, not post bodies.

Server-side storage includes OAuth credentials, policies and overrides, evidence,
previews, approvals, jobs, action history, and mute-ownership records. Browser
sessions contain an opaque application identifier; users are never asked to paste
an app password into the hosted product. The project does not add analytics or
behavioral telemetry.

Policies, approved evidence, action history, and ownership records remain until
the user deletes their data. Unapproved previews and measurements expire after 30
days. Ordinary backups expire within 30 days; keyed deletion tombstones remain for
31 days so an older backup cannot restore a deleted account. Deleting application
data does not automatically remove existing Bluesky mutes. See [Privacy](PRIVACY.md)
for the complete policy.

## Try the offline CLI

Python 3.10 or newer is required.

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test]'

atproto-acl preview --policy examples/demo.yaml \
  --fixture examples/demo.json --now 2026-09-08T12:00:00Z
```

The synthetic fixture demonstrates quarantine, a higher-precedence allow, and an
indeterminate result. It never connects to ATProto or changes an account. Fixture
and live state databases are separate and cannot be interchanged.

For live CLI use, copy `examples/poasters-quarantine.yaml`, edit the account and
sources, and validate before previewing:

```bash
cp examples/poasters-quarantine.yaml policy.local.yaml
atproto-acl validate --policy policy.local.yaml
atproto-acl catalog --policy policy.local.yaml
atproto-acl preview --policy policy.local.yaml
```

The CLI accepts an app password through `ATPROTO_ACL_APP_PASSWORD` or a protected
file supplied with `--app-password-file`. Do not put credentials in a policy,
shell history, repository, or receipt. The hosted application uses browser OAuth
and never accepts app passwords.

`sync` remains a preview unless `--apply` authorizes additions. Private-mute
releases require the receipt and each selected DID:

```bash
atproto-acl sync --policy policy.local.yaml --apply
atproto-acl sync --policy policy.local.yaml --release RECEIPT_ID --did DID
```

Use `atproto-acl --help` and the [policy reference](docs/policy.md) for the full
CLI and schema.

## Run the web application

The web application requires Node.js 24, Python 3.10 or newer, HTTPS at its public
origin, persistent SQLite storage, and an OAuth signing key. For a disposable
local fixture instance:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[test]'

cd web
npm ci
npm run build
ATPROTO_ACL_FIXTURE_MODE=1 npm start
```

Fixture mode is for offline testing and is not a production authentication mode.
For an OAuth deployment, copy `.env.example`, replace every placeholder, generate
owner-only secrets with `web/scripts/generate-secrets.mjs`, and follow the
[operator guide](docs/hosting.md). Keep the web and worker processes on the same
durable state store. Put an HTTPS reverse proxy in front of the web process and
do not expose the SQLite files or secret directory.

## Development

```bash
make test
make build

cd web
npm ci
ATPROTO_ACL_TEST_PYTHON=../.venv/bin/python npm run check
npx playwright install chromium
ATPROTO_ACL_TEST_PYTHON=../.venv/bin/python npm run test:browser
```

Tests use synthetic identities and reject network access. Live interoperability
evidence is kept outside the public source tree.

See [architecture](ARCHITECTURE.md), [invariants](INVARIANTS.md),
[state contracts](docs/state-and-receipts.md), [user guide](docs/user-guide.md),
[operator guide](docs/hosting.md), [security policy](SECURITY.md), and
[contributing](CONTRIBUTING.md).

## License

Licensed under either the [MIT License](LICENSE-MIT) or the
[Apache License 2.0](LICENSE-APACHE), at your option. Contributions are accepted
under the same terms. See [third-party notices](THIRD_PARTY_NOTICES.md) for direct
runtime dependencies.
