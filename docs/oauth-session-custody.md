# OAuth session custody

`atproto-acl` retains the complete `NodeSavedSession` required by
`@atproto/oauth-client-node`: token set, negotiated authentication method, and
the private DPoP JWK. The application database and its parent directory remain
owner-only (`0600` and `0700`). Credentials, token values, and DPoP material
must never appear in Git, receipts, logs, or capture artifacts.

The official client refreshes under the configured per-DID SQLite lock. Before
the token request leaves the process, ACL durably records a refresh intent
bound to the hash of the predecessor refresh token. The successor session and
intent deletion commit in one SQLite transaction. The client does not return
the refreshed session until that store callback succeeds. Store failure causes
the official client to revoke and delete the session. A process interruption
after the request begins leaves the intent behind, and future restores refuse
instead of replaying the predecessor.

The bounded Quench capture entry point accepts a DID, database path, OAuth key
path, origin, and a 1–500 item bound. It restores through the normal durable
custody path and invokes only `app.bsky.feed.getTimeline` and
`app.bsky.feed.getFeed`. The caller never receives raw credentials. A refresh
may update only the local OAuth credential row and refresh-intent journal; it
does not create policy, preview, approval, job, or ATProto repository state.

The older refresh-disabled primitives remain useful for selected-field diagnosis.
It must not be substituted for the durable capture path when an access token is
expired.

## One-time read-only reconnect

Deploy and qualify the custody repair before reconnecting. Then use the normal
sign-in form (`POST /oauth/start`) for `acltest.juche.social`; do not use the
moderation reconnect control. The normal sign-in calls `authorize(..., false)`
and requests exactly `READ_OAUTH_SCOPE`. Complete the callback once and verify,
without printing the stored value:

1. the controlled DID has one `oauth_sessions` row with a fresh update time;
2. it has no `oauth_refresh_intents` row;
3. the saved scope is exactly the existing read scope and lacks mute/unmute;
4. the application can restore the account after a controlled process restart;
5. the bounded capture entry point can run as the ACL service identity.

If callback settlement is uncertain, do not repeat it blindly. Inspect custody
standing by DID and reconcile the same attempt. A retained refresh intent, an
invalid/revoked session, a subject mismatch, or incomplete DPoP material all
require explicit reauthorization.

The saved-session JSON remains readable by the preceding release, but rollback
is allowed only when `oauth_refresh_intents` is empty. An older release does not
understand the intent journal and could replay a predecessor after an
interrupted refresh. If an intent exists, keep the repaired custody path in
place and reconcile or reauthorize; do not use code rollback as session repair.
