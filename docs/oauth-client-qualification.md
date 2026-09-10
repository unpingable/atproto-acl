# OAuth client qualification

The hosted release keeps `@atproto/oauth-client-node` 0.5.4 pinned while the
Chrome callback problem is diagnosed. Dependency upgrades and browser diagnosis
are separate changes so a version change cannot disguise the cause.

Run the isolated 0.5.5 qualification from `web/`:

```sh
npm run qualify:oauth-0.5.5
```

The command copies the Node project to a temporary directory, installs 0.5.5
there, builds it, and runs the admission and OAuth-scope tests. It does not
change the working tree lockfile or dependencies. A candidate may replace 0.5.4
only after that check and real Firefox and Chrome journeys cover initial sign
in, callback completion, reconnect, token refresh, and revocation. Keep 0.5.4
if the candidate introduces a regression and record the failing evidence.

On 2026-09-09 the isolated check reached the public npm registry, which returned
`ETARGET` because it did not yet offer version 0.5.5. The working dependency and
lock therefore remain at 0.5.4. Repeat the isolated check once 0.5.5 is
published; registry availability alone is not qualification.

OAuth diagnostics may retain only random correlation IDs, stages, timestamps,
and bounded error categories. They must not contain handles, authorization
codes, callback queries, application state, PKCE material, tokens, DPoP keys,
authorization headers, or remote URLs containing query strings.
