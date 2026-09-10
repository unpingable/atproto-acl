# Security policy

## Reporting a vulnerability

During the limited hosted preview,
[message @neutral.zone on Bluesky](https://bsky.app/profile/did:plc:dki5xu3vgyo7ubl7vaw55zzq)
to arrange a private reporting channel. Do not send credentials, OAuth tokens,
private account data, or exploit details in the message. GitHub private vulnerability
reporting will become the security channel when this repository is public.

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
