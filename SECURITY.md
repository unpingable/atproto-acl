# Security policy

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** form in the repository Security
tab. It creates a private report and is the preferred channel for security issues.
Do not include credentials, OAuth tokens, private account data, or an exploit
against a real user's account in a public issue or discussion.

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
