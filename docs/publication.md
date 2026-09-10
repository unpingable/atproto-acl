# Public repository checklist

Publication uses a reviewed clean-root repository. Keep the original repository
and an immutable bundle private as custody evidence rather than trying to sanitize
only its latest tree.

Before changing visibility:

1. Inventory every branch, tag, release, package, Actions run, log, cache, and
   artifact in the clean-root repository.
2. Scan the working tree and every reachable Git object for credentials, session
   material, production data and identifiers, private hosts, absolute local paths,
   and campaign records.
3. Confirm that fixtures are synthetic, `.env.example` contains placeholders, and
   generated reports and databases are absent.
4. Run the complete offline test/build workflow and record the exact revision and
   artifact digest.
5. Deploy that artifact with open admission and external writes disabled for
   newly admitted accounts. Do not require or distribute invite codes.

Changing a GitHub repository from private to public can expose prior Actions logs
and disables push rulesets. Use this launch order:

1. Make the reviewed clean-root repository public.
2. Re-enable and verify rulesets and branch protection.
3. Enable private vulnerability reporting and verify secret scanning.
4. Inspect every now-public Actions log and artifact.
5. Complete the public-ready acceptance and approve its launch packet.
6. Keep open-preview admission in place; publishing the repository does not grant
   moderation-write access to newly admitted accounts.

Keep Issues and Discussions disabled. Ordinary support goes to `@neutral.zone` on
Bluesky; security reports use GitHub private vulnerability reporting.
