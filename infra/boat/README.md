# Boat computers and backend tools through an SSH proxy

Overlay for the images-based self-hosted deployment. Rakazo uses its native Box adapter, with a local controller that pins computers to a dedicated credential-free Boat environment and preserves create idempotency. Browsers, bot terminal commands, backend web tools, remote MCP, and connector API requests use a SOCKS proxy over SSH to a Tailscale peer. Model calls, Hindsight, provider control, snapshots, and Docker daemon networking retain normal networking.

Build `App.Dockerfile` with the repository root as its build context and use that image for the application services. It includes the screen wake fix, large workspace uploads, and server-side private viewer authentication. Provider cookies stay inside the screen proxy; the app origin never receives them. The image also includes protected browser fills on Boat, named website accounts, and optional TOTP MFA. Runtime imports are checked during the build to catch shared-package version mismatches.

The browser helper resolves its named inspector-isolated world with `Page.createIsolatedWorld` without subscribing to `Runtime.enable` events. Chromium retains that world across helper connections, preserving element references between a snapshot and its actions. New snapshots refresh references; navigation clears the world. Protected-field masking survives helper reconnects. Page-owned helper objects are outside this world. This removes one automation signal; browser fingerprints, IP reputation, and site-specific behavior still affect detection. Installing Playwright or Puppeteer patches alone does not change this raw-CDP driver.

Copy these files into `boat-network/` alongside the images compose file, and save `compose.boat.yml` as `docker-compose.boat.yml`. Start Compose with both files. Set `SANDBOX_PROVIDER=box` and `BOX_API_URL=http://127.0.0.1:8788/api/box/v1`. Set `BOX_API_KEY` to the same scoped runtime key saved in `boat-network/state/boat-key`.

Set these deployment variables outside Git:

- `BOAT_ENVIRONMENT_ID`: ID of the dedicated credential-free environment.
- `BOAT_ENVIRONMENT`: its name, default `rakazo`.
- `BOAT_WIREGUARD_ENDPOINT`: public VPS hostname and UDP port, such as `vpn.example.com:51871`.
- `BOAT_BIND_IP`: VPS listener address; default all interfaces.
- `BROWSER_PROXY_SSH_TARGET`: SSH user and Tailscale address of the browser egress machine.

Provision the persistent Tailscale state interactively before starting the gateway. Generate a dedicated SSH key at `state/proxy_ed25519`, authorize its public key on the egress machine, and pin that machine's SSH host key in `state/proxy_known_hosts`. Keep the state directory mode 700 and private files mode 600. The Docker build context excludes state.

The guest WireGuard link routes only `10.202.0.1/32`; no default route or blanket firewall restriction is installed. The SOCKS listener binds that private address and is not published as a Docker port. Chrome/Chromium managed policies configure SOCKS, disable QUIC and restrict WebRTC UDP. Localhost stays direct. Browser and terminal internet access depend on the SSH proxy.

Network version 8 migrates archived computers on their next start, removing the earlier full-tunnel rules and provider snapshot override. Synchronous guarded bootstrap markers reconcile uncertain responses without duplicating writes or computers.

Terminal routing matches the provider's systemd user command scopes, including subprocesses run with `sudo`. Redsocks forwards public IPv4 TCP even when programs ignore proxy environment variables. A dedicated Unbound instance forwards terminal DNS through DNS-over-TLS over the same SOCKS connection. Loopback and private IPv4 TCP services remain direct. Unsupported public UDP and direct IPv6 from command scopes are rejected; the proxy does not silently fall back to Boat egress. The provider daemon lives in a separate system cgroup and keeps its direct control connection. Marked WireGuard transport for the proxy and provider preview tunnels remains direct, including when a tunnel socket is recreated inside a command scope. Incoming preview connection replies also retain their original route.

The bootstrap enables persistent proxy services for new computers. To update an existing running computer without restarting its browser or management agent, run the updated bootstrap there with `sudo bash vm-bootstrap.sh --terminal-proxy-only`. Startup checks resolve a test hostname through the actual DNS service before reporting readiness.

The controller checks terminal service versions and actual kernel rules whenever an existing computer becomes ready, repairing stale or missing terminal routing without restarting its browser. Older network configurations still migrate through the full bootstrap. Existing bots without a computer use the same defaults when they first provision one.

`TOOL_EGRESS_PROXY_URL` is an optional deployment setting shared by API and worker. This overlay sets it to the existing private SOCKS listener for every bot, including future bots. The shared adapter transport covers built-in page fetching/search, remote MCP discovery, calls, SSE and OAuth, installed REST/GraphQL connectors, and managed connector SDK/token requests. It pins SOCKS connections to the IP checked by the existing URL policy, keeps the original HTTP Host and TLS identity, and never retries directly when the proxy fails. Authorized private, loopback, Docker and tailnet endpoints retain direct access; their authorization checks remain required. DNS validation runs on the backend before dialing the proxy. An external connector or extraction service makes its own onward requests from that service's network.

Without this setting, the core product retains its ordinary networking and requires no proxy provider. Do not set a global Node dispatcher or blanket HTTP proxy for the application: that would also affect models, memory and infrastructure requests. Hosted MCP runs on its provider; local stdio MCP subprocesses are outside this HTTP transport and remain disabled in this deployment.

For an intentional rollback, first run `/usr/local/lib/rakazo-network/terminal-routes.sh --remove` as root, then disable the three `rakazo-terminal-{tcp,dns,routes}` services and remove `/etc/profile.d/rakazo-terminal-proxy.sh`. Open a new terminal afterward. Stopping a proxy daemon alone deliberately leaves the routing in place to prevent direct fallback.

Run `node --test infra/boat/controller.test.mjs` from the repository root and check the bootstrap and embedded route script with `bash -n`. Deployment acceptance also requires checking browser and terminal public IPs, proxy-independent Node/Python clients, a sudo child, localhost access, the direct management path, failure without fallback, and screen connection after resume. Run `python3 check-terminal-proxy.py --rebind-wireguard` inside a managed bot terminal for the explicit online check, including a tunnel socket recreated inside the command cgroup.

Do not commit state, keys, conversation exports, migration inventories, or live deployment receipts.
