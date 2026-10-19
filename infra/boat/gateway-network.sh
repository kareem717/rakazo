#!/bin/sh
set -eu
umask 077
if [ "$EGRESS_MODE" = all ]; then
  for tool in iptables ip6tables; do
    "$tool" -w -I OUTPUT 1 -m comment --comment rakazo-egress-reconfigure -j REJECT
    "$tool" -w -I FORWARD 1 -i rakazo0 -m comment --comment rakazo-egress-reconfigure -j REJECT
  done
fi
mkdir -p /state/wireguard
[ -s /state/wireguard/server.key ] || wg genkey > /state/wireguard/server.key
wg pubkey < /state/wireguard/server.key > /state/wireguard/server.pub
ip link show rakazo0 >/dev/null 2>&1 || ip link add rakazo0 type wireguard
wg set rakazo0 private-key /state/wireguard/server.key listen-port 51871 fwmark 0x51824
ip address replace 10.202.0.1/24 dev rakazo0
ip -6 address replace fd42:202:7261::1/64 dev rakazo0
ip link set rakazo0 up
for tool in iptables ip6tables; do
  # A failure partway through reconfiguration must not open a direct route.
  "$tool" -w -N RAKAZO_EGRESS_OUT 2>/dev/null || true
  "$tool" -w -N RAKAZO_EGRESS_FWD 2>/dev/null || true
  "$tool" -w -F RAKAZO_EGRESS_OUT
  "$tool" -w -F RAKAZO_EGRESS_FWD
  "$tool" -w -t nat -N RAKAZO_EGRESS_NAT 2>/dev/null || true
  "$tool" -w -t nat -F RAKAZO_EGRESS_NAT
  if [ "$tool" = iptables ]; then
    family=-4
    local_networks='0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4'
    source_network=10.202.0.0/24
  else
    family=-6
    local_networks='::1/128 fc00::/7 fe80::/10 ff00::/8'
    source_network=fd42:202:7261::/64
  fi
  while ip "$family" rule del priority 518 fwmark 0x51824 table main 2>/dev/null; do :; done
  ip "$family" rule add priority 518 fwmark 0x51824 table main
  # Exit defaults must never capture packets returning to computer tunnel addresses.
  while ip "$family" rule del priority 518 to "$source_network" table main 2>/dev/null; do :; done
  ip "$family" rule add priority 518 to "$source_network" table main
  if [ "$EGRESS_MODE" = all ]; then
    "$tool" -w -A RAKAZO_EGRESS_OUT -o lo -j RETURN
    # Tailscale's marked transport and the WireGuard envelope must reach their peers.
    "$tool" -w -A RAKAZO_EGRESS_OUT -m mark --mark 0x80000/0xff0000 -j RETURN
    "$tool" -w -A RAKAZO_EGRESS_OUT -m mark --mark 0x51824 -j RETURN
    "$tool" -w -A RAKAZO_EGRESS_OUT -m conntrack --ctdir REPLY -j RETURN
    for destination in $local_networks; do
      "$tool" -w -A RAKAZO_EGRESS_OUT -d "$destination" -j RETURN
      "$tool" -w -A RAKAZO_EGRESS_FWD -d "$destination" -j RETURN
    done
    "$tool" -w -A RAKAZO_EGRESS_OUT -o tailscale0 -j RETURN
    "$tool" -w -A RAKAZO_EGRESS_OUT -j REJECT
    "$tool" -w -A RAKAZO_EGRESS_FWD -o tailscale0 -j RETURN
    "$tool" -w -A RAKAZO_EGRESS_FWD -j REJECT
    "$tool" -w -t nat -A RAKAZO_EGRESS_NAT -s "$source_network" -o tailscale0 -j MASQUERADE
  fi
  "$tool" -w -C OUTPUT -j RAKAZO_EGRESS_OUT 2>/dev/null || "$tool" -w -I OUTPUT 1 -j RAKAZO_EGRESS_OUT
  "$tool" -w -C FORWARD -i rakazo0 -j RAKAZO_EGRESS_FWD 2>/dev/null || "$tool" -w -I FORWARD 1 -i rakazo0 -j RAKAZO_EGRESS_FWD
  "$tool" -w -t nat -C POSTROUTING -j RAKAZO_EGRESS_NAT 2>/dev/null || "$tool" -w -t nat -A POSTROUTING -j RAKAZO_EGRESS_NAT
  while "$tool" -w -C OUTPUT -m comment --comment rakazo-egress-reconfigure -j REJECT 2>/dev/null; do
    "$tool" -w -D OUTPUT -m comment --comment rakazo-egress-reconfigure -j REJECT
  done
  while "$tool" -w -C FORWARD -i rakazo0 -m comment --comment rakazo-egress-reconfigure -j REJECT 2>/dev/null; do
    "$tool" -w -D FORWARD -i rakazo0 -m comment --comment rakazo-egress-reconfigure -j REJECT
  done
done
