# Deployment material

This directory contains an example immutable deployment, not an installed service.
Replace all example origins and filesystem paths for your host. Do not commit the
resulting environment file, credentials, state, or reverse-proxy inventory.

The `atproto-acl-web.service` and `atproto-acl-worker.service` units describe the
hosted service. The explicitly named `atproto-acl-cli.*` units are separate legacy
examples for periodically previewing one local policy; they are not part of the
hosted topology. Backup scheduling is operator-owned infrastructure, so this
repository supplies the consistency-enforcing `backup.py` command but does not
claim that the CLI timer schedules hosted backups.

Build and test a clean revision, then run:

```bash
deploy/build-candidate.sh /tmp/atproto-acl-candidate
```

The builder emits a tarball and SHA-256 digest containing the Python wheelhouse,
compiled web application, production Node dependencies, static assets,
and service examples. It must not contain credentials or runtime state. After
extracting an immutable release on its target host, create and validate that
release's interpreter before selecting it:

```bash
/path/to/release/deploy/prepare-release.sh /path/to/release
test -x /path/to/release/venv/bin/python
```

Set `ATPROTO_ACL_PYTHON=/opt/atproto-acl/current/venv/bin/python`. Both supplied
service units refuse to start unless that path is executable, and both processes
validate a fresh synthetic policy through the bridge during startup.

A production installation needs:

- a dedicated unprivileged system user and group;
- an immutable revision-and-digest release directory;
- owner-only persistent state and configuration directories;
- a P-256 OAuth signing JWK and random session and tombstone-HMAC secrets;
- separately supervised web and action-worker services sharing one state store;
- an HTTPS reverse proxy whose public origin exactly matches configuration; and
- protected, expiring backups plus the separate deletion-tombstone store.

`node web/scripts/generate-secrets.mjs DIRECTORY` creates an OAuth key, session
secret, and deletion-tombstone HMAC key with exclusive mode 0600 and refuses to overwrite existing files. Do not reuse app passwords or an
unrelated application's authority credentials. The hosted service accepts browser
OAuth only.

Follow the [operator guide](../docs/hosting.md) for write gates, backup, restore,
upgrade, and rollback. Validate a candidate with synthetic data before using a real
account.
