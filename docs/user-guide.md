# User guide

## Getting started

1. **Sign in.** Enter your Bluesky handle. You sign in on your account provider's
   own page, and it shows you what access you're granting. atproto-acl never asks
   for a password or an app password.

2. **Take a look first, if you want.** The dashboard's **Take a look** button reads
   a sample of your Following and Discover feeds and reports how many accounts
   would match, without saving a policy or changing your account. It's read-only:
   closing the browser doesn't cancel it, and a restart keeps whatever it had
   already counted and marks the attempt interrupted.

3. **Set up a scan.** A policy is a saved set of rules. Choose which accounts to
   check and what counts as posting too much. **Poasters Quarantine** is the
   starting example: it checks accounts found in your Following and Discover feeds
   against Cornell Tech's published posting-volume labels, including accounts that
   reach you through reposts and quoted posts, so you don't have to follow someone
   for them to show up. You can instead check every account on Cornell's public
   list, only accounts you follow, or specific handles you type in. **Bsky38 quiet
   mode** is a separate policy that uses the current 38-account leaderboard and
   needs neither follows nor Cornell data.

4. **Set the limit and conditions.** The limit is a ceiling on how much to read, so
   a scan stays quick — for feeds it counts posts per feed, for follows it counts
   followed accounts, and for Cornell's list it counts entries. The "What this will
   do" summary spells out in plain words what will happen. Existing policies keep
   the source they were saved with even when the defaults change.

## Reviewing and approving

5. **Save and scan now.** A status message appears while the server samples accounts
   and looks up posting data. You can go back to the dashboard while a feed
   measurement continues. Each feed shows its own count and status with the time it
   was taken. If a permission has gone stale, the affected feed says to sign in
   again rather than reporting an empty feed as a clean result.

6. **Read the list.** It opens on **To mute**. The other views — **People you
   follow**, **To unmute**, **Leaving alone**, **Couldn't tell**, **Everyone** — are
   counted, and views with nothing in them are hidden. Long lists are split into
   pages of 20, and you can search. Handles and display names lead; DIDs, hashes,
   and receipt data sit under *Technical decision details*.

   A no-match is shown separately from missing or unusable data. Accounts you follow
   are held in their own collapsed group and are never folded into the main batch.

7. **Tick and mute.** Tick only the accounts you mean to change; the button stays
   disabled until you do and tells you how many are selected. Ordinary mutes,
   mutes of accounts you follow, and unmutes are approved separately. Once approved,
   the batch cannot grow.

8. **Watch it run.** The results page updates in place and links back to the
   dashboard. The job is recorded durably, so leaving the page doesn't cancel it.
   It shows saved names and handles, confirmed changes, accounts still waiting,
   skips, failures, and changes the service couldn't confirm. **Check again**
   performs a read-only look at an uncertain item; it never repeats the action and
   never treats a matching current state as proof of ownership.

## Managing accounts

9. **Accounts to leave alone.** On the dashboard, add an account by handle or DID
   and choose what should happen: *Never touch this account* skips it entirely,
   *Always keep in my feed* wins over a mute rule, and *Never offer to unmute*
   stops a release being proposed. The list shows what you've set, with a Remove
   button on each row.

10. **Unmuting.** Unmutes are reviewed on their own. Each one is fresh authorization
    to unmute that account; past activity by this tool is never treated as proof
    that it currently owns a private mute.

11. **Sign out vs. disconnect.** **Sign out** in the header ends the browser session
    only. **Disconnect**, under *Connection and account data* on the dashboard,
    revokes the app's access to your account and stops remaining work. Either way,
    existing Bluesky mutes remain and retained data follows the published retention
    policy. Use **Delete my atproto-acl data** for erasure.

12. **Deleting.** Deletion first cancels queued work and refuses or cancels pending
    moderation actions. Choose **Delete my data, keep mutes**, or unmute people
    first and then delete. Deletion never authorizes an unmute by itself.

## Notes

Each Bsky38 scan keeps the exact membership it saw and explains a match as "On the
Bsky38 leaderboard when you scanned." Rankings move while voting is open. Scan again
for a new snapshot; an approved batch never expands or substitutes accounts, and a
member who leaves before execution is skipped.

"Following" is what Bluesky's API returns for your following timeline. Your Home tab
may mix in other posts, so a sample won't match it exactly, and an account appearing
in a scan means it was in the sample — not that you definitely read the post.

Names and handles link to DID-bound Bluesky profiles, and scan results and history
keep links to the sampled posts an account appeared in. These open on Bluesky in a
new tab; the app never embeds or proxies profile pages.

## Advanced YAML

Open **Advanced · View or edit the YAML** only when the form can't express what you
need. The same Python compiler validates both. Duplicate keys, unknown fields,
malformed structure, oversized documents, and unsupported semantics are rejected
before a revision is saved, and syntax errors include a line and column when the
parser provides one.

An invalid draft stays in the editor for repair and cannot be scanned or executed.
If a saved policy uses features the form can't represent, the app leaves the form
controls unavailable and the full YAML editable, rather than importing part of it
and silently dropping behavior.

## Help

[Message @neutral.zone on Bluesky](https://bsky.app/profile/neutral.zone) for ordinary
support. Report security issues through
[GitHub private vulnerability reporting](https://github.com/unpingable/atproto-acl/security/advisories/new).
If that route is unavailable, message @neutral.zone to arrange another private
channel; never send credentials, tokens, or exploit details in a Bluesky message.
