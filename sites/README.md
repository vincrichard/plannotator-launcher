# Agent sites

A separate, dependency-free Node handler behind the shared gateway on
`127.0.0.1:19433`. Named sites open as `http://127.0.0.1:19433/sites/NAME/`.
Plannotator's launcher and PWA scope are `http://127.0.0.1:19433/reviews/`.
The gateway explicitly sends `/sites/` requests and WebSockets to this handler.
Node 24 is installed on this host. The `agent-site` command is a symlink to
`site.mjs`; all implementation code lives in this directory.

## Connect a device

Keep this SSH forward open on your PC or in your phone's SSH client:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:19433:127.0.0.1:19433 your-review-host
```

In a mobile SSH client, reuse the existing reviewer local forward:
listen on `127.0.0.1:19433`, destination `127.0.0.1:19433` on this host.
No additional port forward is needed. Each device needs its own forward;
the phone cannot use the PC's localhost. There is no public HTTP listener.

Open the full private link from `agent-site` in your browser. The numeric loopback
address needs no custom DNS or `.localhost` support. Sites are outside the Reviews
PWA's `/reviews/` scope. Update the installed Android WebAPK (or reinstall Reviews)
before testing link dispatch: an old WebAPK with root scope can still capture sites.
Set the intended browser as your default for links from other apps. A source app
can still use its own embedded browser. No home-screen installation is needed.
Desktop browser tests do not certify a physical phone's link dispatch.

## Publish a generated HTML folder

```bash
agent-site publish hello ~/dev/localhost-proxy/sites/demo
agent-site publish my-chart /absolute/path/to/chart-folder
```

Folders must contain `index.html`. Use relative asset URLs such as `./style.css`,
or URLs under `/sites/my-chart/`. There are no directory listings; dotfiles and paths
or symlinks escaping the published folder are refused. Changes to files appear
on refresh. Publish only folders intended for viewing; files inside are available
to anyone holding that site's access link. Generated sites and Reviews share a
browser origin. PWA scope and cookie paths do not isolate their data or prevent
same-origin JavaScript from requesting review APIs. Publish trusted agent output,
not untrusted third-party applications.

## Forward a local web app

```bash
# Run in the app's directory; configure its router for /sites/my-app/ too if needed.
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort --base /sites/my-app/
agent-site proxy my-app 5173
```

The upstream must serve `/sites/my-app/` and accept `127.0.0.1:19433` as its Host.
The proxy preserves the full path, query, request body, Host and Origin. It forwards
WebSocket upgrades and streams responses for live reload and event streams.
It sets `X-Forwarded-Prefix: /sites/my-app/`, `X-Forwarded-Host` and
`X-Forwarded-Proto: http`, and removes the sites and reviewer access cookies before forwarding.
It does not rewrite app HTML, root asset paths, redirects or upstream cookies;
apps must support their configured base path. Upstreams are HTTP on `127.0.0.1` only.

## Lifecycle and access

```bash
agent-site list          # recover full private links, including after reconnecting
agent-site status
agent-site start         # also runs automatically when publishing/registering
agent-site remove hello # keeps the source files and any upstream process
```

Publishing the same name and target reuses its stable access link. A name pointing
elsewhere is refused: choose a new name or remove the old registration first.
Removing and republishing rotates its access secret. Publishing never launches
or supervises an upstream app; keep that app running separately.

The shared gateway detaches from the agent's terminal and survives an SSH disconnect.
Registrations and logs live in the owner-only `~/.local/state/agent-sites/`.
After a host reboot, run `agent-site start` or publish a site to start it again;
this setup does not install a system service. Static files persist; upstream apps
need their own restart. Reconnect the tunnel when its SSH connection ends.

Access links set a path-scoped HttpOnly, SameSite=Lax cookie and remove the secret
from the address bar. A clean URL works only in a browser already unlocked by the
full link. Keep full links private. HTTP has no site-registration API; registrations
are written only by the local CLI. Host/Origin and cross-site request guards apply
to HTTP requests and WebSocket upgrades. The two handlers use separate URL prefixes
on the same origin. Neither exposes registration files through HTTP. No service
worker, root interception, or generated-site caching is installed by this service.

## Verify

```bash
node --test --test-timeout=10000 ~/dev/localhost-proxy/sites/test.mjs
TEST_GATEWAY=1 node --test --test-timeout=10000 ~/dev/localhost-proxy/sites/test.mjs
```

The second command runs the same checks through the shared gateway, including
WebSockets, host routing and authentication. Tests use disposable state and random loopback ports. They never touch the running
reviewer, the live sites service, or the user's registrations. Desktop Chromium
and Firefox are also checked with the installed Playwright browsers during setup;
physical phone link dispatch needs a real-device check.
