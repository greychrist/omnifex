# Remote (daemon transport and lifetime)

- The tailnet is the security boundary. There is no login: the daemon binds the Tailscale interface, never `0.0.0.0` by default, and anyone who reaches it is the user.
- Config: `~/.omnifex/server.json` (`host`, `port` 47700, `webRoot`, `ringSize`, `permissionTimeoutMs` with null = never, `rpcAllow`, `rpcDeny`). Logs: `~/Library/Logs/omnifex-server.log`. Commands: `start`, `stop`, `status --json`, `ensure`, `restart`, `config`.
- The daemon re-derives `PATH` from the login shell on every start (`fixPath`) and refuses to start without `claude`.
- Idle watch: stops the daemon 30 s after the last client disconnects, but only once no turn is running; 2 min after start if no client ever connected. A disconnected client with a running CLI is an app reloading.
- On launch the app replaces a daemon whose `/healthz` version differs: at once when idle, otherwise it rechecks every 30 s. The updater's idle gate counts daemon turns too, and it stops the daemon before the bundle swap.
- Safari needs HTTPS for the Home Screen app (service worker, push). TLS comes from `tailscale serve --bg --https=443 http://127.0.0.1:47700`, never from the daemon.
- Web Push: `~/.omnifex/push.json` holds the VAPID pair and subscriptions (mode 0600). Push fires only for a permission request or a finished turn, and only when no client has that session subscribed. 404/410 drops a subscription. Deleting the file rotates the key and invalidates every subscription.
- `scripts/remote-smoke.mjs --url ws://127.0.0.1:47700/ws --project <dir>` drives one full turn over the protocol; `--resume <sessionId>` reuses one.
