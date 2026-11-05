# Review launcher and lifecycle

This directory contains the proxy and durable launcher for the [Plannotator fork](https://github.com/vincrichard/plannotator/tree/commentable-references). The current binary pin is **0.28.20-references.29**. Installation, component ownership and baseline features are documented in the [repository README](../README.md).

## Commands

Run a new review from its Git checkout:

```sh
plannotator-mobile --detach --title "My review" --git --diff-type uncommitted --no-git-remote-check
```

The JSON response is a launch receipt, not feedback. It contains the review ID and private direct/proxy links. Use the same ID to retrieve status or feedback:

```sh
plannotator-mobile --status ID
plannotator-mobile --result ID
plannotator-mobile --wait ID
plannotator-mobile --list
plannotator-mobile --notifications
plannotator-mobile --ack ID
plannotator-mobile --suspend ID
plannotator-mobile --resume ID
plannotator-mobile --prepare-resume ID
plannotator-mobile --cancel ID
```

`--result` exits 0 only for submitted feedback, 2 while pending or suspended, and 1 for failed/cancelled/interrupted or unknown reviews. Cancelling a waiter leaves its review running. `--cancel` explicitly stops the review without submitting feedback and retains existing saved files. `--ack` marks a completion notification read; it does not delete feedback.

Guide generation is opt-in via `--generate-guide`, only when explicitly requested. Inline questions run in a read-only fork of the explicitly identified launching Codex, Claude Code or OpenCode session. Never infer a parent by selecting the latest agent conversation. Herdr integration is optional; `PLANNOTATOR_REVIEW_NOTIFY=0` disables automatic delivery.

## Resumable review lifecycle

Supported reviews save and suspend after 72 hours without reviewer interaction. Background polling does not count as activity. `--suspend ID` queues that same operation; inspect `--status` for `suspended` or `suspend_error`. A busy review, changed checkout, unsupported state or save failure leaves the process running.

Resume preserves the review ID, proxy URL, saved diff, comments, composer drafts, discussions and viewed marks. The direct port can change. Keep the original checkout available. The snapshot stays frozen until explicitly refreshed; live AI, References and editing are disabled while frozen.

The home page's **Close and save** first attempts this resumable save. If the application explicitly refuses unsupported state (including agent jobs, Ask AI sessions, external annotations, active answers, unsupported review type/size or an outdated diff), the action cancels the review through its owning supervisor. Existing saved files remain, but continuing requires a new review. Temporary save errors and unknown failures do not trigger this fallback. Automatic suspension and the CLI's `--suspend` never use the close fallback.

The UI shows **Resume review** only for successfully suspended reviews. Saved files alone are not a resumable checkpoint. Text not yet saved by a browser and unfinished model answers are not guaranteed to survive cancellation. No close action submits feedback or approves code.

After suspension, the supervisor can append an unsent resume prompt to the original verified idle Herdr agent pane. It never presses Enter or clears existing input. Unknown, replaced or busy agents receive nothing; the saved record retains the prompt. Feedback notification delivery likewise verifies the original agent identity.

## Storage and access

Review records, logs, drafts, feedback and checkpoints are retained under `~/.local/state/plannotator-reviews/ID/`, overridden by `PLANNOTATOR_REVIEW_STATE_DIR` for isolated tests. Shared viewed progress lives under the application data directory; unchanged-file fingerprints determine reuse. Browser cookie paths and routes are scoped by review ID. Keep private URLs and records out of Git.

Routes and the gateway PID/log live in `/tmp/plannotator-mobile-UID/`. The shared gateway binds only `127.0.0.1:19433`; each viewing device needs its own SSH forward. The dashboard is intentionally unlocked. Individual private access links establish HttpOnly path-scoped cookies, then remove the token from the address bar. Host/Origin guards protect requests.

Verified application bundles are cached by hash; private review responses remain `no-store`. Finite JSON responses are compressed, and concurrent identical snapshot polls share a transfer. Streaming responses stay immediate. Unknown inline bundles are not automatically published as shared assets. A new application build needs explicit compatibility and bundle-pin verification.

## Tests

```sh
python3 test-durable.py
node --test --test-timeout=10000 test-sessions.mjs test-proxy.mjs test-route-adapter.mjs
```

The fake CLI lifecycle suite uses disposable processes and state. Browser checks require the matching patched binary and Playwright (`npm ci`, `npx playwright install chromium`); `npm run test:auth` exercises access and launcher behavior. The broad `npm test` also uses the shared gateway with disposable review fixtures. Do not stop unrelated reviews as test cleanup.
