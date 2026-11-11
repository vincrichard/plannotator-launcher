# Plannotator review launcher

Companion to [vincrichard/plannotator](https://github.com/vincrichard/plannotator), a personal fork of [backnotprop/plannotator](https://github.com/backnotprop/plannotator). This repository tracks the launcher, shared localhost gateway, mobile home page and durable review lifecycle used with the fork.

## Where changes belong

- **Application:** [the fork's `commentable-references` branch](https://github.com/vincrichard/plannotator/tree/commentable-references). Review UI lives in `packages/review-editor`, server features in `packages/server`, shared models in `packages/shared`, and portable guide components in `packages/core`.
- **Launcher and review home:** this repository's `plannotator/` directory. `launcher/` contains the home page; `server/` handles routing, access and caching; `durable.py` owns review processes; `lifecycle.py` handles save, close and resume.
- **Shared gateway:** `gateway.mjs`. `sites/` serves named HTML previews and local applications alongside reviews on the same SSH-forwarded port.

Make application changes in the fork and launcher changes here, then commit and push each affected repository. These repositories contain code and tests, not live review records, comments, screenshots, credentials or generated review links. The fork retains the 31 original feature commits; this companion repository starts with the current launcher snapshot because that directory was not previously versioned.

## Current feature baseline

Application base: **v0.28.20**, patched build **0.28.20-references.34**, source commit [`9bb6ab9`](https://github.com/vincrichard/plannotator/commit/9bb6ab927788a4fe1ad3d08ae1d59561a43f42a0).

Implemented in the fork:

- Commentable definitions/references, reference history, method expansion and stable search highlights.
- Inline read-only agent discussions using Codex, Claude Code and OpenCode forks; follow-ups reuse their discussion context.
- Last nonempty user-turn changes, captured by supported turn hooks.
- Guided reviews on explicit request, split into bounded source blocks with coverage checks and partial repairs; navigation back to the guide preserves position.
- Saved review snapshots, composer drafts, discussions and viewed-file state.

Implemented here:

- Detached reviews with retained feedback and process ownership.
- A newest-first home page with one compact **Close and save** / **Resume review** action.
- Resumable suspension when supported; explicit close fallback retains saved files when older reviews cannot checkpoint. Automatic suspension never force-closes on failure.
- Shared viewed-file progress across review rounds, compressed private responses and cached verified application bundles.
- Optional notifications and unsent resume prompts in the verified originating Herdr agent pane.

Known limits: fallback-closed reviews need a new review to continue; browser text not yet saved and unfinished model answers are not guaranteed to survive. Some AI/guide state is not resumable. First-load bundle size remains a performance opportunity. No automatic upstream-update pipeline is implemented. These are limitations, not promises of scheduled work.

## Run

Requires Linux, Python 3.10+, Node 24, Git and the matching patched Plannotator binary on PATH. Herdr is optional. The launcher deliberately checks the binary version; arbitrary upstream versions are not interchangeable. See the fork's build instructions to produce the patched application; this repository does not include compiled binaries.

From this repository:

```sh
mkdir -p ~/.local/bin
ln -s "$PWD/plannotator/mobile.py" ~/.local/bin/plannotator-mobile
ln -s "$PWD/sites/site.mjs" ~/.local/bin/agent-site
plannotator-mobile --proxy-status
```

Run `plannotator-mobile --detach --git --no-git-remote-check` from the checkout you want reviewed. Reuse that checkout for subsequent feedback rounds. Guide generation requires an explicit `--generate-guide` request; do not add it by default.

On your reviewing device:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:19433:127.0.0.1:19433 your-review-host
```

The dashboard is `http://127.0.0.1:19433/reviews/`. It is intentionally unlocked on the loopback gateway; review links and sites have their own access tokens. This is a personal SSH-forwarded service, not an internet-facing multi-user deployment. Generated sites share the browser origin with reviews: publish trusted content only.

See [review lifecycle and commands](plannotator/README.md) and [site publishing](sites/README.md).

## Verify

These checks use disposable records and ports:

```sh
python3 plannotator/test-durable.py
node --test --test-timeout=10000 plannotator/test-sessions.mjs plannotator/test-proxy.mjs plannotator/test-route-adapter.mjs
node --test --test-timeout=10000 sites/test.mjs
TEST_GATEWAY=1 node --test --test-timeout=10000 sites/test.mjs
```

Browser checks use Playwright from `plannotator/package.json` and the patched binary. Install development dependencies with `cd plannotator && npm ci && npx playwright install chromium`, then run `npm run test:auth`. Some broader checks use the shared gateway; inspect each test's setup before running it against an installed environment. Physical phone performance and Android app routing require device checks.

Preserve existing review processes when deploying. Replacing launcher code does not migrate already-running application binaries or supervisors. Reload only the owned gateway when its modules or assets change; keep saved records and route registrations. Runtime data lives outside this repository under the user's local state directory and temporary route directory.

The adapted Plannotator icon's license and attribution are in [THIRD-PARTY-NOTICES.md](plannotator/THIRD-PARTY-NOTICES.md).
