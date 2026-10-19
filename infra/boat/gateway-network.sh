#!/bin/sh
set -eu
umask 077
mkdir -p /state/wireguard
[ -s /state/wireguard/server.key ] || wg genkey > /state/wireguard/server.key
wg pubkey < /state/wireguard/server.key > /state/wireguard/server.pub
ip link show rakazo0 >/dev/null 2>&1 || ip link add rakazo0 type wireguard
wg set rakazo0 private-key /state/wireguard/server.key listen-port 51871
ip address replace 10.202.0.1/24 dev rakazo0
ip link set rakazo0 up
for tool in iptables ip6tables; do
 "$tool" -P OUTPUT ACCEPT
 for chain in RAKAZO_OUT RAKAZO_FWD; do
  "$tool" -F "$chain" 2>/dev/null || true
 done
done
