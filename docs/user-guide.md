# User guide

1. Sign in with your ATProto handle. Your account provider shows the permissions;
   atproto-acl never asks for an app password.
2. Choose a preset. **Poasters Quarantine** checks Cornell activity labels for
   authors found in authenticated Timeline and Discover samples by default. It
   includes original authors of reposts and available quoted posts, so the account
   need not be followed. You can instead enumerate Cornell's current label stream,
   run an optional follows cleanup, or enter specific accounts. **Bsky38 quiet
   mode** checks the current 38-account leaderboard snapshot without requiring
   follows or Cornell evidence.
3. Set the scan limit and conditions. A feed limit counts feed items per surface, a
   follows limit counts followed accounts, and the Cornell label-stream limit
   counts label records. The plain-language summary says what will be checked.
   Existing policies retain their saved source when defaults change.
4. Choose **Save and preview**. A visible status message appears while the server
   samples accounts and checks evidence. You can return to the dashboard while a
   durable feed measurement continues. Start with accounts discovered, accounts
   checked, usable policy
   evidence, and proposed changes. A no-match is shown separately from missing or
   unusable evidence. Handles and display names lead; DIDs, hashes, and receipt
   data are under technical details.
   Each feed source shows its own item count and status with the snapshot time.
   If a grant is stale, the affected source says to reconnect instead of showing
   an empty feed as a clean result.
5. The preview opens on **Proposed changes**. Use the counted **Followed review**,
   **No change**, **Unresolved**, and **All results** filters when you need them;
   large groups are split into 20-account pages. Search the results and select
   only the accounts you intend to affect. Accounts
   you follow appear in a collapsed, separate review group. Approve ordinary mutes,
   followed-account mutes, and releases separately. The resulting batch cannot grow
   after approval.
6. The action page shows progress in the same tab and links back to the dashboard.
   Action history records the job durably, so returning to the dashboard does not
   cancel it. The page refreshes progress automatically while open and shows saved
   names and handles, confirmed changes, waiting accounts, skips, failures, and
   changes the service could not confirm. **Check state again** performs a
   read-only observation of an uncertain item; it never repeats the action or
   establishes ownership from a matching current state.
7. Add an exemption when an account should always be skipped. Use allow when a
   policy class should win over quarantine. Use keep muted to prevent a release
   proposal. The web form accepts a handle or DID and stores the resolved DID.
8. Review releases separately. A release is fresh authorization to unmute the
   selected account; historical tool activity is never treated as current
   ownership of a private mute.
9. Disconnect when you want to revoke the application connection. Existing
   Bluesky mutes remain, and retained policy/history data follows the published
   retention policy. Use **Delete my atproto-acl data** for erasure instead.
10. Deletion first cancels queued acquisition and refuses or cancels pending
    moderation actions. Choose either **Delete data; leave existing Bluesky mutes
    unchanged** or review eligible releases before deletion. Deletion itself never
    authorizes an unmute.

For help, [message @neutral.zone on Bluesky](https://bsky.app/profile/neutral.zone).
Use GitHub private vulnerability reporting for security issues rather than sending
sensitive details through an ordinary message.

Each Bsky38 preview preserves its exact membership snapshot and explains a match
as “Included in the Bsky38 leaderboard snapshot.” Rankings may move while voting
is open. Refresh to create a new preview; an approved batch never expands or
substitutes accounts, and a member who leaves before execution is skipped.

The dashboard's **Measure feed coverage** action is read-only. It samples Timeline
and Discover once, shows author and relationship yield at 100, 250, and 500 items,
then reports publisher checks, positive labels, matches, proposals, and unresolved
cases. It starts a durable progress record before acquisition. Closing the browser
does not cancel the check; a service restart preserves captured counts and marks
the attempt interrupted. Completed reports show the unique union and what each
later source added. “Found in your sample” records acquisition provenance; it does
not claim you personally saw the post. Timeline is the server's `getTimeline`
result and may not match every surface Bluesky presents as Home.

Account names and handles link to DID-bound Bluesky profiles. Feed previews and
action history retain links to the sampled posts that supplied exposure provenance.
These open directly on Bluesky in a new tab; the app does not embed or proxy profile
pages.

## Advanced YAML

Open **Advanced · View or edit policy YAML** only when the guided editor cannot
represent the policy you need. The same Python compiler validates guided and YAML
policies on the server. Duplicate keys, unknown fields, malformed structure,
oversized documents, and unsupported semantics are rejected before a revision is
saved. Syntax errors include a line and column when the YAML parser provides one.

An invalid draft remains in the editor for repair and cannot be previewed or
executed. If a saved policy contains features outside the guided editor, the app
keeps the guided controls unavailable and leaves the complete YAML editable; it
never performs a partial import that could discard policy behavior.
