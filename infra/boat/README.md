# Boat computers with a browser-only SSH proxy

Overlay for the images-based self-hosted deployment. Rakazo uses its native Box adapter, with a local controller that pins computers to a dedicated credential-free Boat environment and preserves create idempotency. Browser traffic uses a SOCKS proxy over SSH to a Tailscale peer. Shell commands, Docker, model calls, and snapshots retain normal networking.

Build `App.Dockerfile` with the repository root as its build context and use that image for the application services. It includes the screen wake fix, large workspace uploads, and server-side private viewer authentication. Provider cookies stay inside the screen proxy; the app origin never receives them. The image also includes protected browser fills on Boat, named website accounts, and optional TOTP MFA. Runtime imports are checked during the build to catch shared-package version mismatches.

Copy these files into `boat-network/` alongside the images compose file, and save `compose.boat.yml` as `docker-compose.boat.yml`. Start Compose with both files. Set `SANDBOX_PROVIDER=box` and `BOX_API_URL=http://127.0.0.1:8788/api/box/v1`. Set `BOX_API_KEY` to the same scoped runtime key saved in `boat-network/state/boat-key`.

Set these deployment variables outside Git:

- `BOAT_ENVIRONMENT_ID`: ID of the dedicated credential-free environment.
- `BOAT_ENVIRONMENT`: its name, default `rakazo`.
- `BOAT_WIREGUARD_ENDPOINT`: public VPS hostname and UDP port, such as `vpn.example.com:51871`.
- `BOAT_BIND_IP`: VPS listener address; default all interfaces.
- `BROWSER_PROXY_SSH_TARGET`: SSH user and Tailscale address of the browser egress machine.

Provision the persistent Tailscale state interactively before starting the gateway. Generate a dedicated SSH key at `state/proxy_ed25519`, authorize its public key on the egress machine, and pin that machine's SSH host key in `state/proxy_known_hosts`. Keep the state directory mode 700 and private files mode 600. The Docker build context excludes state.

The guest WireGuard link routes only `10.202.0.1/32`; no default route or blanket firewall restriction is installed. The SOCKS listener binds that private address and is not published as a Docker port. Chrome/Chromium managed policies configure SOCKS, disable QUIC and restrict WebRTC UDP. Localhost stays direct. Browser access depends on the SSH proxy; other programs do not.

Network version 8 migrates archived computers on their next start, removing the earlier full-tunnel rules and provider snapshot override. Synchronous guarded bootstrap markers reconcile uncertain responses without duplicating writes or computers.

Run `node --test infra/boat/controller.test.mjs` from the repository root. Deployment acceptance also requires checking a real browser's public IP, normal shell networking, and screen connection after resume.

Do not commit state, keys, conversation exports, migration inventories, or live deployment receipts.
