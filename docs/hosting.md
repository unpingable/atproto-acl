# Operator guide

This guide describes the deployment contract. It deliberately omits production
hostnames, account identifiers, secret locations, and campaign records.

## Topology and privileges

Run an HTTPS reverse proxy in front of two unprivileged processes:

```text
public HTTPS origin -> reverse proxy -> web process
                                      -> persistent SQLite state
persistent SQLite state -> action worker -> ATProto services
```

Use a dedicated operating-system account with no login shell. Install immutable
releases in revision-and-digest-named directories and select one with a stable
symlink. Keep configuration and state outside the release, owner-only. Supply the
OAuth private JWK, session secret, and deletion-tombstone HMAC key through protected
files or service-manager credentials; never environment files committed with the
release.

Copy the root `.env.example` and replace its placeholders. The origin must be the
exact external HTTPS origin used by OAuth. Run the web process without its embedded
worker and run the action worker separately against the same state directory.

The application health endpoints belong behind the operator's monitoring path.
Readiness must fail when migrations are incomplete, the durable state is unusable,
or a restore has not applied retained deletion tombstones.

## Write and admission controls

The database-backed admission and external-write gates are the immediate controls.
The worker reads the write gate immediately before every ATProto mutation and
refuses writes when the gate cannot be read. A service environment switch remains
an outer failsafe.

Disabling writes pauses remaining work. Enabling the gate does not resume jobs.
Resume each eligible job explicitly; an expired approval requires a new preview
and approval. Admission freeze rejects new sign-ins without disconnecting existing
sessions. Keep global acquisition/effect limits conservative for the available
host capacity.

Run the operator utility as the service account against the live application
database. It never needs OAuth or session secret material:

```bash
cd /path/to/release/web
npm run ops -- /path/to/state/app.db status
npm run ops -- /path/to/state/app.db admissions disable operator "capacity review"
npm run ops -- /path/to/state/app.db writes disable operator "emergency stop"
npm run ops -- /path/to/state/app.db writes enable operator "incident resolved"
npm run ops -- /path/to/state/app.db resume job_identifier
npm run ops -- /path/to/state/app.db invite create 14
npm run ops -- /path/to/state/app.db account-writes did:example:account enable
```

Enabling writes changes only the gate. Use `resume` separately for each paused
job. The command refuses expired approvals. Invite plaintext is displayed once;
deliver it through the chosen private channel and do not put it in logs.

## Backup

Create a consistent SQLite snapshot with the supplied backup tool and copy each
per-user engine database while holding its file lock. Encrypt backups at rest,
restrict them to the operator, verify their checksums and SQLite integrity, and
expire every ordinary generation within 30 days.

Back up service configuration and signing material separately in the protected
operator vault. Keep the minimal keyed deletion-tombstone database outside ordinary
application backups and retain it for 31 days. Losing that store makes a restore
unsafe until the operator can otherwise prove which retained users were deleted.

```bash
python deploy/backup.py /path/to/state /path/to/backups/generation
python deploy/restore-check.py /path/to/backups/generation
```

Copy the separate tombstone database through the protected operator backup path,
never into an ordinary application generation. Retain daily ordinary generations
for at most 30 days and the deletion ledger for at least 31 days.

## Restore

1. Stop web and worker processes and preserve the failed state directory.
2. Verify checksums and SQLite integrity in an isolated directory.
3. Restore the snapshot into a new owner-only state directory.
4. Load every unexpired deletion tombstone and purge matching per-user rows,
   credentials, evidence, journals, and derived engine state.
5. Record successful tombstone reconciliation for this restored generation.
6. Start the web process only and require readiness to confirm migrations and
   restore reconciliation.
7. Inspect pending, paused, and attempting items. Reconcile ambiguous attempts by
   observation and never replay them blindly.
8. Start the worker only after the operator enables writes and explicitly resumes
   eligible jobs.

Rehearse restoration against every retained backup generation. A deleted fixture
must remain absent from each restored generation before the service accepts
traffic.

## Upgrade and rollback

Build and test off-host. Record source revision, artifact digest, dependency lock,
configuration schema, migration, and backup generation in the launch packet.
Install the candidate alongside the previous release, move the selector, restart
web and worker, and check readiness plus OAuth metadata.

Rollback selects the previous compatible release and restarts the services. It
never rolls back remote moderation state. If a database migration is not backward
compatible, restore the pre-upgrade snapshot, apply deletion tombstones, and keep
writes disabled until uncertain journal rows are reconciled.
