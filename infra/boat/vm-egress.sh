#!/bin/bash
set -euo pipefail
mode=$(cat /etc/rakazo-network/egress-mode)
case "$mode" in direct|browser|tools|all) ;; *) exit 1 ;; esac

remove_full_rules() {
  for tool in iptables ip6tables; do
    while "$tool" -w -C OUTPUT -m comment --comment rakazo-full-reconfigure -j REJECT 2>/dev/null; do
      "$tool" -w -D OUTPUT -m comment --comment rakazo-full-reconfigure -j REJECT
    done
    while "$tool" -w -C OUTPUT -j RAKAZO_FULL_OUT 2>/dev/null; do "$tool" -w -D OUTPUT -j RAKAZO_FULL_OUT; done
    "$tool" -w -F RAKAZO_FULL_OUT 2>/dev/null || true
    "$tool" -w -X RAKAZO_FULL_OUT 2>/dev/null || true
    while "$tool" -w -t mangle -C OUTPUT -m conntrack --ctdir REPLY -m comment --comment rakazo-egress-reply -j MARK --set-mark 0x51823 2>/dev/null; do
      "$tool" -w -t mangle -D OUTPUT -m conntrack --ctdir REPLY -m comment --comment rakazo-egress-reply -j MARK --set-mark 0x51823
    done
  done
  for family in -4 -6; do
    for mark in 0x51822 0x51823 $(cat /etc/rakazo-network/full-provider-mark 2>/dev/null || true); do
      while ip "$family" rule del priority 519 fwmark "$mark" table main 2>/dev/null; do :; done
    done
  done
  rm -f /etc/rakazo-network/full-provider-mark
}

if [ "${1:-}" = --check ]; then
  if [ "$mode" = tools ]; then
    systemctl is-active --quiet rakazo-terminal-tcp.service rakazo-terminal-dns.service rakazo-terminal-routes.service
    /usr/local/lib/rakazo-network/terminal-routes.sh --check
  elif [ "$mode" = all ]; then
    wg show rakazo0 allowed-ips | grep -q '0.0.0.0/0'
    wg show rakazo0 allowed-ips | grep -q '::/0'
    ip -4 route get 1.1.1.1 | grep -q 'dev rakazo0'
    ip -6 route get 2606:4700:4700::1111 | grep -q 'dev rakazo0'
    iptables -w -C OUTPUT -j RAKAZO_FULL_OUT
    iptables -w -C RAKAZO_FULL_OUT -o rakazo0 -j RETURN
    iptables -w -C RAKAZO_FULL_OUT -j REJECT
    ip6tables -w -C OUTPUT -j RAKAZO_FULL_OUT
    ip6tables -w -C RAKAZO_FULL_OUT -j REJECT
    for family in -4 -6; do
      ip "$family" rule show | grep -q 'fwmark 0x51823 lookup main'
    done
    if ip link show wg0 >/dev/null 2>&1; then
      provider_mark=$(wg show wg0 fwmark)
      [ "$provider_mark" != off ]
      for tool in iptables ip6tables; do "$tool" -w -C RAKAZO_FULL_OUT -m mark --mark "$provider_mark" -j RETURN; done
      for family in -4 -6; do ip "$family" rule show | grep -q "fwmark $provider_mark lookup main"; done
    fi
    grep -q '^nameserver 10.202.0.1$' /etc/resolv.conf
  else
    ! iptables -w -t nat -C OUTPUT -j RAKAZO_TERM_NAT 2>/dev/null
    ! iptables -w -C OUTPUT -j RAKAZO_FULL_OUT 2>/dev/null
    ! ip6tables -w -C OUTPUT -j RAKAZO_FULL_OUT 2>/dev/null
  fi
  exit 0
fi

if [ "$mode" != tools ]; then
  if [ -x /usr/local/lib/rakazo-network/terminal-routes.sh ]; then
    /usr/local/lib/rakazo-network/terminal-routes.sh --remove
  fi
  systemctl disable --now rakazo-terminal-routes.service rakazo-terminal-dns.service rakazo-terminal-tcp.service 2>/dev/null || true
  rm -f /etc/profile.d/rakazo-terminal-proxy.sh
fi

if [ "$mode" != all ]; then
  remove_full_rules
  if [ -f /etc/rakazo-network/resolv-before-full.conf ]; then
    cat /etc/rakazo-network/resolv-before-full.conf > /etc/resolv.conf
    rm -f /etc/rakazo-network/resolv-before-full.conf
  fi
  exit 0
fi

# Only the tunnel envelopes and replies to incoming management/viewer connections
# bypass full egress. Ordinary provider, browser and command connections use it.
# Guard both families before changing either policy.
for tool in iptables ip6tables; do
  "$tool" -w -I OUTPUT 1 -m comment --comment rakazo-full-reconfigure -j REJECT
done
provider_mark=""
if ip link show wg0 >/dev/null 2>&1; then
  provider_mark=$(wg show wg0 fwmark)
  if [ "$provider_mark" = off ]; then
    provider_mark=0x51822
    wg set wg0 fwmark "$provider_mark"
  fi
  printf '%s\n' "$provider_mark" > /etc/rakazo-network/full-provider-mark
fi
for family in -4 -6; do
  for mark in 0x51823 $provider_mark; do
    ip "$family" rule show | grep -q "fwmark $mark lookup main" || ip "$family" rule add priority 519 fwmark "$mark" table main
  done
done
for tool in iptables ip6tables; do
  "$tool" -w -N RAKAZO_FULL_OUT 2>/dev/null || true
  "$tool" -w -F RAKAZO_FULL_OUT
  "$tool" -w -A RAKAZO_FULL_OUT -o lo -j RETURN
  "$tool" -w -A RAKAZO_FULL_OUT -o rakazo0 -j RETURN
  "$tool" -w -A RAKAZO_FULL_OUT -m mark --mark 0x51821 -j RETURN
  if [ -n "$provider_mark" ]; then "$tool" -w -A RAKAZO_FULL_OUT -m mark --mark "$provider_mark" -j RETURN; fi
  "$tool" -w -A RAKAZO_FULL_OUT -m conntrack --ctdir REPLY -j RETURN
  if [ "$tool" = iptables ]; then destinations='10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16';
  else destinations='::1/128 fc00::/7 fe80::/10'; fi
  for destination in $destinations; do "$tool" -w -A RAKAZO_FULL_OUT -d "$destination" -j RETURN; done
  "$tool" -w -A RAKAZO_FULL_OUT -j REJECT
  "$tool" -w -C OUTPUT -j RAKAZO_FULL_OUT 2>/dev/null || "$tool" -w -I OUTPUT 1 -j RAKAZO_FULL_OUT
  "$tool" -w -t mangle -C OUTPUT -m conntrack --ctdir REPLY -m comment --comment rakazo-egress-reply -j MARK --set-mark 0x51823 2>/dev/null || \
    "$tool" -w -t mangle -A OUTPUT -m conntrack --ctdir REPLY -m comment --comment rakazo-egress-reply -j MARK --set-mark 0x51823
  while "$tool" -w -C OUTPUT -m comment --comment rakazo-full-reconfigure -j REJECT 2>/dev/null; do
    "$tool" -w -D OUTPUT -m comment --comment rakazo-full-reconfigure -j REJECT
  done
done
[ -f /etc/rakazo-network/resolv-before-full.conf ] || cp /etc/resolv.conf /etc/rakazo-network/resolv-before-full.conf
printf 'nameserver 10.202.0.1\noptions timeout:2 attempts:3\n' > /etc/resolv.conf
