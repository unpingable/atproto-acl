# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/unpingable/atproto-acl/security/advisories/new)
to report a vulnerability. Do not open a public issue or discussion. If private
reporting is unavailable, [message @neutral.zone on Bluesky](https://bsky.app/profile/did:plc:dki5xu3vgyo7ubl7vaw55zzq)
to arrange another private reporting channel; do not send credentials, OAuth
tokens, private account data, or exploit details in the message.

GitHub Issues are not a support channel. For ordinary beta support,
[message @neutral.zone on Bluesky](https://bsky.app/profile/neutral.zone).

Include the affected revision, the component and route involved, reproduction
steps using synthetic data where possible, and the impact you believe is possible.
The operator will acknowledge a report as capacity permits and coordinate a fix
and disclosure with the reporter. The beta does not promise a fixed response SLA.

## Supported versions

Only the revision currently deployed at the hosted beta receives security fixes.
The repository does not currently maintain parallel supported release branches.

## Secrets and live data

Never commit app passwords, OAuth material, session secrets, signing keys, database
files, live receipts, production logs, or real-user fixtures. If such material is
committed or included in a CI artifact, revoke it first; removing it from the
latest tree is not sufficient because Git history and artifacts remain reachable.
