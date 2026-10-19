#!/bin/sh
set -eu
umask 077
mkdir -p /state/tailscale /var/run/tailscale
/bin/sh /deployment/gateway-network.sh
tailscaled --state=/state/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock > /state/tailscaled.log 2>&1 &
daemon=$!
controller=""
trap 'kill "$daemon" ${controller:+"$controller"} 2>/dev/null || true' EXIT TERM INT
while [ ! -S /var/run/tailscale/tailscaled.sock ]; do sleep 1; done
until tailscale set --hostname=rakazo-egress --accept-dns=false --exit-node= --exit-node-allow-lan-access=false; do
  kill -0 "$daemon"
  sleep 2
done
(
 while true; do
  ssh -N -T -g -D 10.202.0.1:1080 -i /state/proxy_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/state/proxy_known_hosts -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 "${BROWSER_PROXY_SSH_TARGET:?Set BROWSER_PROXY_SSH_TARGET}" || true
  sleep 3
 done
) &
node /deployment/controller.mjs &
controller=$!
while kill -0 "$daemon" 2>/dev/null && kill -0 "$controller" 2>/dev/null; do sleep 5; done
