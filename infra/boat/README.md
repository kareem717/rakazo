# Configurable network egress for Boat computers

This optional overlay connects Rakazo's native Box adapter to a local Boat controller. Core Rakazo defaults to ordinary networking and requires no proxy or Tailscale account. Web, Electron and mobile use the same backend policy.

## Choose a scope

| `mode` | Browser | Computer commands | Backend requests |
| --- | --- | --- | --- |
| `direct` | Direct | Direct | Direct |
| `browser` | SOCKS | Direct | Direct |
| `tools` | SOCKS | Public IPv4 TCP and DNS through SOCKS | Web fetch/search, remote MCP/OAuth and connector HTTP through SOCKS |
| `all` | Exit node | Exit node | Exit node, including models, memory, provider control and snapshots |

`tools` rejects unsupported public UDP and direct IPv6 from command scopes. It preserves the provider management path. Backend models, memory and provider requests keep ordinary networking in this mode. Authorized private backend endpoints remain direct; their existing authorization and URL checks still apply. A hosted connector or extraction service makes its own onward requests from that service's network.

The deployment-wide **Browser driver** setting also supports Patchright. Its optional adapter attaches to the same Chrome with default emulation overrides disabled, uses native browser input, and shares the protected DOM state with Standard. The Box adapter installs verified, pinned wheels in a separate user virtual environment before the first Patchright request on each computer. Existing and future computers use the saved choice automatically. Browser operations never install an unpinned package, replace the user's Chrome profile, or silently switch drivers after failure.

`all` routes public TCP, UDP and both IP families from the application network namespace and managed computers through a Tailscale exit node. Local/private destinations, tunnel envelopes and replies to incoming management connections are exceptions. Docker image pulls on the host, other host processes, client devices and external services' onward requests are outside this namespace. The exit node must support the desired IP families. Failed tunnel traffic is rejected rather than falling back to the ordinary public route.

This is deployment routing, not a sandbox security boundary against root commands. Administrators and privileged computer commands can alter kernel policy.

## Configuration

The gateway writes its boot policy to the dedicated `network-runtime` volume, readable by
the application group and mounted read-only as `RAKAZO_NETWORK_ACTIVE_CONFIG` on
API and worker. Saved edits remain in `RAKAZO_NETWORK_CONFIG`. An API-only update
therefore reloads the actual gateway policy and retains the pending-change notice.
Only a gateway restart changes that active snapshot. This directory volume also
works on first startup, before the snapshot file exists; it contains no keys.

Network settings can also apply a saved route from the app. The optional
`compose.apply.yml` overlay runs a restricted restart service from the updater
image. Build the updater image from this source, copy the overlay beside the
deployment Compose files, and set `RAKAZO_DEPLOY_DIR`, `RAKAZO_NETWORK_CONFIG_DIR`,
and `RAKAZO_COMPOSE_FILE` to the deployment's absolute directory, private config
directory, and full ordered list of relative Compose files (including this
overlay). Set the updater image/tag to the built image. The service has Docker
access and must remain private; only the API receives its restricted Unix socket.
It has no TCP listener, application credentials in its environment or network.

After saving, choose **Apply and restart**. Stop computers first using their
existing Stop control. The backend freezes new computer operations, checks the
provider's actual state, refuses pending work, recreates only the gateway and
application services, and reconnects the UI to the durable operation status.
It never stops a computer automatically or changes the selected image. If the
new route fails, it restores the previous route and retains the saved edit for
another attempt. Without the optional service, applying remains a server action.

An interrupted operation leaves its config and gateway locks in place. Inspect
the restart service's private recovery record, restore a healthy route, then
clear locks only after checking that no operation is still running. The UI
reports recovery requiring server access rather than claiming the change worked.

Create a private JSON file outside Git. Its schema is versioned and validated before startup; unknown fields and unsupported combinations fail closed. Choose one of these examples.

Ordinary networking:

```json
{"version":1,"mode":"direct"}
```

Browser-only SSH proxy over Tailscale:

```json
{
  "version": 1,
  "mode": "browser",
  "transport": {"type":"ssh","target":"proxy@egress.example.ts.net","tailscale":true}
}
```

Change `mode` to `tools` to include computer commands and backend tools. Set `tailscale` to `false` (the default) when the SSH host is reachable directly. SSH keys and pinned host keys stay in private state, outside this file.

An existing SOCKS server requires no Tailscale or SSH daemon:

```json
{
  "version": 1,
  "mode": "tools",
  "transport": {"type":"socks5","url":"socks5://proxy.example.test:1080"}
}
```

The gateway relays this server on its private computer listener. SOCKS username/password authentication is unsupported because Chromium's managed SOCKS configuration cannot use it. Keep the server protected by private networking or use SSH. `socks5h` is also accepted.

Full routing requires an exit node, since SSH SOCKS cannot carry every protocol:

```json
{
  "version": 1,
  "mode": "all",
  "transport": {"type":"tailscale-exit-node","exitNode":"exit.example.ts.net"}
}
```

The selected device must advertise an approved exit node and tailnet policy must allow its use. See [Tailscale exit nodes](https://tailscale.com/docs/features/exit-nodes). The gateway owns its namespace firewall and uses Tailscale's `--netfilter-mode=off` to prevent automatic rules from preceding its rejection policy. See [Tailscale netfilter modes](https://tailscale.com/docs/reference/netfilter-modes).

Validate a file with Node 22.22.2 or newer:

```sh
RAKAZO_NETWORK_CONFIG=/absolute/private/network.json node infra/boat/network-config.mjs --check
```

The backend reads `RAKAZO_NETWORK_CONFIG`; the overlay mounts the same file into API, worker and gateway. Config is read once per process: edit the file and recreate the deployment to apply it. `RAKAZO_NETWORK_CONFIG_DIR` selects a dedicated host directory containing `network.json`. The API mounts only this directory writable; gateway and worker mount it read-only. Never mount the gateway state or SSH key directory writable into the API. Copy the checked-in `network.example.json` into this private directory to start with `direct`.

Compatibility: when no new config is selected, the gateway still accepts `BROWSER_PROXY_SSH_TARGET` as the previous `tools` plus SSH/Tailscale setup; the backend still accepts `TOOL_EGRESS_PROXY_URL`. An explicit JSON config takes precedence over both. Remove those legacy settings when migrating.

## Settings UI

The deployment owner can open **Settings → General → Advanced → Network** on web or desktop,
or **Settings → Advanced → Network** on mobile. The four routing scopes share the same
validation and backend. Transport fields appear only when needed. **Save** stages the JSON;
the UI shows **Restart required** while it differs from the running process configuration.
With the optional restart controller, **Apply and restart** shows the affected computers and
asks for confirmation. The server claims maintenance across API and worker processes, waits
for active work, saves workspaces and stops computers before recreating the deployment. Save
open files first. A failed drain leaves the current route in place; failed checkpoints never
stop that computer. Computers start again when next used. Native desktop computers are not
stopped by server maintenance. Without the controller, stop computers and recreate the
deployment manually. Saving never silently moves existing sockets to another route.
Returning the saved config to its active value cancels the pending change.

The restart operation survives client disconnects and API recreation. Maintenance claims stay
fenced until the controller releases them after route verification or failure cleanup. An
interrupted controller keeps its recovery-required state; reconcile its journal and matching
`network:` maintenance claims before enabling another apply. Never clear a live operation's
claims. The internal drain endpoint requires the deployment's internal screen-proxy secret
and a matching, currently draining owner-authorized operation; it is not a client API.

A file-only or read-only mount remains visible but cannot be edited. To enable editing, use
only a dedicated config directory, mode 700 with `network.json` mode 600, writable by the API
user. When migrating the older `RAKAZO_NETWORK_CONFIG_FILE` mount, copy that file into the new
directory, set `RAKAZO_NETWORK_CONFIG_DIR`, and recreate all services together. The new Compose
overlay requires this directory explicitly so an old file setting cannot silently select a
direct default. A stale edit is rejected; reload before saving again. Concurrent writers use
an exclusive lock. If a process dies while saving, inspect the private config and remove its
`network.json.lock` after verifying no write is running, then reload.

## Deploy

Use a repository checkout and the images-based Compose deployment. Build `infra/boat/App.Dockerfile` with the repository root as context and select that application image for the services. Its browser driver, screen proxy and shared tool transport are required for this overlay. Keep deployment secrets, keys and real endpoints outside Git.

Set these deployment variables:

- `SANDBOX_PROVIDER=box` and `BOX_API_URL=http://127.0.0.1:8788/api/box/v1`.
- `BOX_API_KEY`: the same scoped runtime key saved in `boat-network/state/boat-key`.
- `BOAT_ENVIRONMENT_ID`: a dedicated credential-free Boat environment ID.
- `BOAT_ENVIRONMENT`: its name, default `rakazo`.
- `BOAT_WIREGUARD_ENDPOINT`: a reachable gateway address and UDP port, such as `vpn.example.com:51871`.
- `BOAT_BIND_IP`: optional listener address, default all interfaces.
- `RAKAZO_NETWORK_CONFIG_DIR`: absolute path to a dedicated private directory containing `network.json`, owned by the application user (UID 1000 in the standard image).

The controller forces the dedicated environment, refuses inherited credentials and preserves create idempotency. Allow inbound WireGuard UDP on the selected gateway port. Its SOCKS listener binds only `10.202.0.1:1080` and is never published as a Docker port.

Keep `boat-network/state` mode 700 and its files mode 600. For SSH, generate a dedicated `state/proxy_ed25519`, authorize its public key on the egress machine and pin that machine's verified SSH host key in `state/proxy_known_hosts`.

For Tailscale, open the owner's Network settings and choose **Connect Tailscale**, then **Continue in Tailscale** to authorize the gateway in your browser. The connection refreshes while authorization or device approval is pending. Connected setups show their tailnet and offer advertised exit nodes as input suggestions. Advertising an exit node still requires approval in Tailscale; an SSH-only proxy host is not automatically an exit node. The existing connection is preserved when Connect is retried. Identity persists under `state/tailscale`; no password or auth key is entered into Rakazo. CLI enrollment inside the gateway remains available.

The gateway exposes only status and interactive enrollment through a dedicated Unix socket volume. Only the API mounts that volume, read-only, at `RAKAZO_NETWORK_CONTROL_SOCKET`. It cannot access the raw Tailscale socket, daemon state or Docker socket. Without this mount, connection management stays server-managed. The gateway health check checks enrollment-service availability so owners can sign in before a route exists. Computer provisioning still requires a verified egress route and full routing continues to reject public traffic when the exit node is unavailable. Neither guest enrollment keys nor Tailscale in every computer are required.

Run Compose from the repository root with an images Compose file prepared there by the installer. Explicitly set the project directory so overlay paths resolve against the checkout:

```sh
docker compose --project-directory . --env-file .env \
  -f docker-compose.images.yml -f infra/boat/compose.boat.yml \
  up -d --build --force-recreate
```

The gateway image builds from the repository root, including the shared config parser. The overlay mounts its scripts from `infra/boat`, state from `boat-network/state`, and shares the gateway network namespace with application services. Private DNS/host pins belong on the gateway when namespace sharing is enabled.

Stop managed computers before changing `mode`, then recreate the deployment and resume them. Startup rejects a different mode while a tracked computer is running. Keep the old config available for rollback. Existing legacy `tools` computers can migrate to the equivalent JSON policy without restarting their browser. A change to `mode` rebuilds the computer tunnel and browser policy on resume; existing sockets must not cross modes. A gateway failure leaves full-routing rejection rules in computers intact.

## Enforcement and recovery

Selective modes install Chromium managed SOCKS settings, disable QUIC and restrict non-proxied WebRTC UDP. `direct` and `all` remove that browser proxy. The browser helper uses an inspector-isolated CDP world without subscribing to `Runtime.enable`; installing an unrelated Playwright patch does not change this driver.

In `tools`, Redsocks forwards public command TCP even if programs ignore proxy environment variables. Unbound sends command DNS over proxied TLS. Rules follow provider systemd command scopes, including sudo descendants; marked WireGuard envelopes and incoming preview replies preserve management access. New computers install these services only when needed. Readiness checks inspect actual services and kernel rules, repairing resumed policy before returning a computer.

Backend tool transport validates and pins destination IPs, preserves the original HTTP Host and TLS identity and never retries directly after proxy failure. Models and memory use their normal adapters; `all` covers their sockets through kernel routing rather than adding vendor-specific settings.

In `all`, the computer's WireGuard route includes IPv4 and IPv6 defaults; gateway NAT forwards it to the exit node. A gateway DNS resolver sends public DNS through that route. Rejection rules cover both families even if a working direct WAN remains. The computer preserves its previous DNS configuration and restores it when leaving full mode. Persistent boot policy applies before its default-route tunnel starts. Provider tunnel marks are preserved.

## Verification

Deterministic config, adapter and controller tests run offline. The explicit Linux packet check creates disposable guest and exit namespaces inside a privileged container with **no host networking or mounted state**:

```sh
node --test infra/boat/controller.test.mjs infra/boat/network-config.test.mjs
pnpm exec vitest run packages/adapters/src/egress-config.test.ts packages/adapters/src/tool-egress.test.ts
docker build -f infra/boat/Dockerfile -t rakazo/egress:local .
docker build -f infra/boat/NetworkTest.Dockerfile -t rakazo/egress-test:local .
docker run --rm --privileged --network none rakazo/egress-test:local
```

The packet check exercises actual WireGuard, IPv4/IPv6 TCP and UDP, DNS, tunnel failure with an available WAN, recovery and switching back to browser-only. It simulates the exit interface and route table; it does not authenticate to Tailscale or prove a particular exit node's connectivity. Deployment acceptance additionally checks browser/command public IPs, screen/preview and management access after resume, and the selected real exit node. The existing `check-terminal-proxy.py --rebind-wireguard` covers live `tools` commands, including a recreated tunnel socket.

Do not commit state, keys, conversation exports, migration inventories or live deployment receipts.
