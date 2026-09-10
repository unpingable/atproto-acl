# Deployment material

This directory contains an example immutable deployment, not an installed service.
Replace all example origins and filesystem paths for your host. Do not commit the
resulting environment file, credentials, state, or reverse-proxy inventory.

Build and test a clean revision, then run:

```bash
deploy/build-candidate.sh /tmp/atproto-acl-candidate
```

The builder emits a tarball and SHA-256 digest containing the Python environment,
compiled web application, production Node dependencies, static assets, and service
examples. It must not contain credentials or runtime state.

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
