# Privacy policy

Effective date: 2026-09-09

atproto-acl is operated by James Beck. For privacy questions or ordinary support,
[message @neutral.zone on Bluesky](https://bsky.app/profile/neutral.zone). Security
reports should use the private process in [SECURITY.md](SECURITY.md).

## Data used by the service

The service processes:

- your DID, handle, display name, PDS, OAuth grant, token material, and DPoP keys;
- policies, publisher and account-source choices, exemptions, and enforcement
  overrides;
- account identities, relationship and mute state needed to evaluate a policy;
- label evidence and its publisher, timestamps, expiry, and integrity metadata;
- sampled feed provenance such as post URIs and CIDs, without retaining post
  bodies;
- previews, exact approvals, jobs, per-account outcomes, action history, and
  mute-ownership records; and
- invite/admission standing and operational timestamps.

This data is used to authenticate the account, acquire the sources you selected,
evaluate your policy on the server, show a preview, execute only an approved
batch, reconcile uncertain effects, and preserve an understandable history. The
application does not add advertising, behavioral analytics, or sale of personal
data.

## Other services involved

The hosted service runs on Linode infrastructure, operated by Akamai. OAuth, feed,
profile, relationship, and moderation requests go to the applicable ATProto PDS,
AppView, or authorization server. Evidence requests go to the observation
publishers configured in a policy. Those services receive the requests necessary
to answer them and apply their own privacy and retention policies.

GitHub hosts the public source and private vulnerability-reporting channel. User
account data is not intentionally stored in the public repository or its CI
artifacts.

## Retention and deletion

Policies, action history, approved-preview evidence, and mute-ownership records
remain until you request deletion. Unapproved previews and measurements expire
after 30 days.

The application offers two explicit deletion paths:

- **Delete data; leave existing Bluesky mutes unchanged**
- **Review releases, then delete data**

Queued work is cancelled and pending actions are refused before deletion. Deleting
atproto-acl data never silently authorizes an unmute. Existing Bluesky mutes remain
unless you separately review and approve releases while the required evidence and
ownership standing are available.

Live per-user data, credentials, and derived engine state are removed promptly
once deletion can safely complete. Ordinary protected backups expire
within 30 days. A minimal HMAC-keyed deletion tombstone is kept outside ordinary
application backups for 31 days. It contains a non-reversible keyed identifier and
deletion/expiry times so every retained backup can be purged before restored data
serves traffic. The tombstone is removed after all backups capable of restoring
the deleted data have expired.

If this retention policy changes after beta, the revised policy will be published
before surprising deletion or retention behavior is applied.

## Account control

Disconnecting revokes and deletes the application's OAuth credentials and prevents
new execution, but it does not erase the saved policies and history described
above. **Delete my atproto-acl data** is a separate control. Neither operation
automatically removes existing Bluesky mutes.
