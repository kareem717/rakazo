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

The backend reads `RAKAZO_NETWORK_CONFIG`; the overlay mounts the same file into API, worker and gateway. Config is read once per process: edit the file and recreate the deployment to apply it. `RAKAZO_NETWORK_CONFIG_FILE` selects the host file mounted by Compose. The checked-in example defaults to `direct`.

Compatibility: when no new config is selected, the gateway still accepts `BROWSER_PROXY_SSH_TARGET` as the previous `tools` plus SSH/Tailscale setup; the backend still accepts `TOOL_EGRESS_PROXY_URL`. An explicit JSON config takes precedence over both. Remove those legacy settings when migrating.

## Deploy

Use a repository checkout and the images-based Compose deployment. Build `infra/boat/App.Dockerfile` with the repository root as context and select that application image for the services. Its browser driver, screen proxy and shared tool transport are required for this overlay. Keep deployment secrets, keys and real endpoints outside Git.

Set these deployment variables:

- `SANDBOX_PROVIDER=box` and `BOX_API_URL=http://127.0.0.1:8788/api/box/v1`.
- `BOX_API_KEY`: the same scoped runtime key saved in `boat-network/state/boat-key`.
- `BOAT_ENVIRONMENT_ID`: a dedicated credential-free Boat environment ID.
- `BOAT_ENVIRONMENT`: its name, default `rakazo`.
- `BOAT_WIREGUARD_ENDPOINT`: a reachable gateway address and UDP port, such as `vpn.example.com:51871`.
- `BOAT_BIND_IP`: optional listener address, default all interfaces.
- `RAKAZO_NETWORK_CONFIG_FILE`: absolute path to the private JSON config.

The controller forces the dedicated environment, refuses inherited credentials and preserves create idempotency. Allow inbound WireGuard UDP on the selected gateway port. Its SOCKS listener binds only `10.202.0.1:1080` and is never published as a Docker port.

Keep `boat-network/state` mode 700 and its files mode 600. For SSH, generate a dedicated `state/proxy_ed25519`, authorize its public key on the egress machine and pin that machine's verified SSH host key in `state/proxy_known_hosts`. For transports using Tailscale, authorize the gateway interactively using `tailscale login` inside its container; its identity persists under `state/tailscale`. Neither guest enrollment keys nor Tailscale in every computer are required.

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
