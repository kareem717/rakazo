#!/bin/sh
set -eu
umask 077
mkdir -p /state
node /deployment/network-config.mjs /state/egress.env
. /state/egress.env
export EGRESS_MODE
node /deployment/controller.mjs --check-network-transition
/bin/sh /deployment/gateway-network.sh
daemon=""; controller=""; proxy=""; dns=""
trap 'kill ${daemon:+"$daemon"} ${controller:+"$controller"} ${proxy:+"$proxy"} ${dns:+"$dns"} 2>/dev/null || true' EXIT TERM INT

if [ "$EGRESS_USE_TAILSCALE" = true ]; then
  mkdir -p /state/tailscale /var/run/tailscale
  tailscaled --state=/state/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock > /state/tailscaled.log 2>&1 &
  daemon=$!
  while [ ! -S /var/run/tailscale/tailscaled.sock ]; do kill -0 "$daemon"; sleep 1; done
  allow_lan=false
  [ -z "$EGRESS_EXIT_NODE" ] || allow_lan=true
  until tailscale set --hostname=rakazo-egress --accept-dns=false --netfilter-mode=off --exit-node="$EGRESS_EXIT_NODE" --exit-node-allow-lan-access="$allow_lan"; do
    kill -0 "$daemon"
    sleep 2
  done
fi

case "$EGRESS_TRANSPORT" in
  ssh)
    (
      while true; do
        ssh -N -T -g -D 10.202.0.1:1080 -i /state/proxy_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/state/proxy_known_hosts -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 "$EGRESS_SSH_TARGET" || true
        sleep 3
      done
    ) &
    proxy=$!
    ;;
  socks5)
    socat TCP-LISTEN:1080,bind=10.202.0.1,reuseaddr,fork "TCP-CONNECT:$EGRESS_PROXY_HOST:$EGRESS_PROXY_PORT" &
    proxy=$!
    ;;
  tailscale-exit-node)
    # Bootstrap/control DNS is available before tailscaled establishes the exit route.
    dnsmasq --keep-in-foreground --no-resolv --no-hosts --cache-size=0 --server=1.1.1.1 --server=1.0.0.1 --listen-address=127.0.0.1,10.202.0.1 --bind-interfaces --user=nobody > /state/egress-dns.log 2>&1 &
    dns=$!
    printf 'nameserver 127.0.0.1\noptions timeout:2 attempts:3\n' > /etc/resolv.conf
    ;;
  direct) ;;
  *) exit 1 ;;
esac

node /deployment/controller.mjs &
controller=$!
while kill -0 "$controller" 2>/dev/null; do
  [ -z "$daemon" ] || kill -0 "$daemon"
  [ -z "$proxy" ] || kill -0 "$proxy"
  [ -z "$dns" ] || kill -0 "$dns"
  sleep 5
done
