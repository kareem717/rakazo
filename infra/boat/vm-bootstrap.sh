#!/bin/bash
set -euo pipefail
umask 077

install_terminal_proxy() {
  exec 8>/run/lock/rakazo-terminal-proxy.lock
  flock -w 300 8
  if ! command -v redsocks >/dev/null 2>&1 || ! command -v unbound >/dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq redsocks unbound
  fi
  systemctl disable --now redsocks.service unbound.service unbound-resolvconf.service
  install -d -m 755 /etc/rakazo-terminal-proxy /usr/local/lib/rakazo-network
  terminal_uid=$(id -u user)
  cat > /etc/rakazo-terminal-proxy/redsocks.conf <<'TCP_PROXY'
base {
 log_debug = off;
 log_info = off;
 log = stderr;
 daemon = off;
 redirector = iptables;
}
redsocks {
 local_ip = 127.0.0.1;
 local_port = 12345;
 ip = 10.202.0.1;
 port = 1080;
 type = socks5;
}
TCP_PROXY
  cat > /etc/unbound/rakazo-terminal.conf <<'DNS_PROXY'
server:
 interface: 127.0.0.1@1053
 access-control: 127.0.0.0/8 allow
 username: ""
 chroot: ""
 directory: "/etc/unbound"
 pidfile: ""
 do-daemonize: no
 use-syslog: no
 verbosity: 0
 do-ip6: no
 tls-cert-bundle: /etc/ssl/certs/ca-certificates.crt
forward-zone:
 name: "."
 forward-addr: 1.1.1.1@853#cloudflare-dns.com
 forward-addr: 1.0.0.1@853#cloudflare-dns.com
 forward-tls-upstream: yes
 forward-first: no
DNS_PROXY
  chmod 644 /etc/rakazo-terminal-proxy/*.conf /etc/unbound/rakazo-terminal.conf
  redsocks -t -c /etc/rakazo-terminal-proxy/redsocks.conf
  unbound-checkconf /etc/unbound/rakazo-terminal.conf
  cat > /etc/systemd/system/rakazo-terminal-tcp.service <<'TCP_UNIT'
[Unit]
Description=Terminal TCP forwarding to the private SOCKS proxy
After=network-online.target rakazo-wireguard.service
Wants=rakazo-wireguard.service
[Service]
User=nobody
Group=nogroup
ExecStart=/usr/sbin/redsocks -c /etc/rakazo-terminal-proxy/redsocks.conf
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
TCP_UNIT
  cat > /etc/systemd/system/rakazo-terminal-dns.service <<'DNS_UNIT'
[Unit]
Description=Terminal DNS over proxied TLS
After=rakazo-terminal-tcp.service
Requires=rakazo-terminal-tcp.service
[Service]
User=unbound
Group=unbound
ExecStart=/usr/sbin/unbound -d -c /etc/unbound/rakazo-terminal.conf
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
DNS_UNIT
  cat > /usr/local/lib/rakazo-network/terminal-routes.sh <<'ROUTES'
#!/bin/bash
set -euo pipefail
terminal_uid=$(id -u user)
terminal_group="user.slice/user-${terminal_uid}.slice/user@${terminal_uid}.service/app.slice"
dns_uid=$(id -u unbound)
if [ "${1:-}" = "--remove" ]; then
 while iptables -w -t nat -C OUTPUT -j RAKAZO_TERM_NAT 2>/dev/null; do iptables -w -t nat -D OUTPUT -j RAKAZO_TERM_NAT; done
 while iptables -w -C OUTPUT -m cgroup --path "$terminal_group" -j RAKAZO_TERM_OUT 2>/dev/null; do iptables -w -D OUTPUT -m cgroup --path "$terminal_group" -j RAKAZO_TERM_OUT; done
 while ip6tables -w -C OUTPUT -m cgroup --path "$terminal_group" -j RAKAZO_TERM_OUT6 2>/dev/null; do ip6tables -w -D OUTPUT -m cgroup --path "$terminal_group" -j RAKAZO_TERM_OUT6; done
 for chain in RAKAZO_TERM_NAT RAKAZO_TERM_APP; do iptables -w -t nat -F "$chain" 2>/dev/null || true; done
 for chain in RAKAZO_TERM_NAT RAKAZO_TERM_APP; do iptables -w -t nat -X "$chain" 2>/dev/null || true; done
 iptables -w -F RAKAZO_TERM_OUT 2>/dev/null || true
 iptables -w -X RAKAZO_TERM_OUT 2>/dev/null || true
 ip6tables -w -F RAKAZO_TERM_OUT6 2>/dev/null || true
 ip6tables -w -X RAKAZO_TERM_OUT6 2>/dev/null || true
 exit 0
fi
# Match the SDK's command scopes, including sudo descendants. The provider daemon
# lives in system.slice and retains its direct management connection.
if [ ! -d "/sys/fs/cgroup/$terminal_group" ]; then
 runuser -u user -- env XDG_RUNTIME_DIR="/run/user/$terminal_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$terminal_uid/bus" systemctl --user start app.slice
fi
[ -d "/sys/fs/cgroup/$terminal_group" ]
# The provider preview tunnel can also inherit a command cgroup when its socket
# is recreated. Mark its transport without changing its routes or peer config.
provider_mark=""
if ip link show wg0 >/dev/null 2>&1; then
 provider_mark=$(wg show wg0 fwmark)
 if [ "$provider_mark" = "off" ]; then
  provider_mark=0x51822
  wg set wg0 fwmark "$provider_mark"
 fi
fi
iptables -w -t nat -N RAKAZO_TERM_NAT 2>/dev/null || true
iptables -w -t nat -N RAKAZO_TERM_APP 2>/dev/null || true
iptables -w -t nat -F RAKAZO_TERM_NAT
iptables -w -t nat -F RAKAZO_TERM_APP
iptables -w -t nat -A RAKAZO_TERM_NAT -m owner --uid-owner "$dns_uid" -p tcp --dport 853 -j REDIRECT --to-ports 12345
iptables -w -t nat -A RAKAZO_TERM_NAT -m cgroup --path "$terminal_group" -m conntrack --ctdir ORIGINAL -j RAKAZO_TERM_APP
iptables -w -t nat -A RAKAZO_TERM_APP -p udp --dport 53 -j REDIRECT --to-ports 1053
iptables -w -t nat -A RAKAZO_TERM_APP -p tcp --dport 53 -j REDIRECT --to-ports 1053
for destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
 iptables -w -t nat -A RAKAZO_TERM_APP -d "$destination" -j RETURN
done
iptables -w -t nat -A RAKAZO_TERM_APP -p tcp -j REDIRECT --to-ports 12345
iptables -w -t nat -C OUTPUT -j RAKAZO_TERM_NAT 2>/dev/null || iptables -w -t nat -I OUTPUT 1 -j RAKAZO_TERM_NAT
# SSH's SOCKS server transports TCP, not UDP. Block unsupported public UDP and
# direct IPv6 for command scopes rather than silently using the Boat address.
iptables -w -N RAKAZO_TERM_OUT 2>/dev/null || true
iptables -w -F RAKAZO_TERM_OUT
iptables -w -A RAKAZO_TERM_OUT -d 127.0.0.0/8 -j RETURN
# WireGuard sockets can inherit the bootstrap command cgroup. Preserve the
# tunnel transport itself; its mark is set in clientConfig.
iptables -w -A RAKAZO_TERM_OUT -m mark --mark 0x51821 -j RETURN
if [ -n "$provider_mark" ]; then
 iptables -w -A RAKAZO_TERM_OUT -m mark --mark "$provider_mark" -j RETURN
fi
iptables -w -A RAKAZO_TERM_OUT -p udp -j REJECT
iptables -w -C OUTPUT -m cgroup --path "$terminal_group" -j RAKAZO_TERM_OUT 2>/dev/null || iptables -w -I OUTPUT 1 -m cgroup --path "$terminal_group" -j RAKAZO_TERM_OUT
ip6tables -w -N RAKAZO_TERM_OUT6 2>/dev/null || true
ip6tables -w -F RAKAZO_TERM_OUT6
ip6tables -w -A RAKAZO_TERM_OUT6 -d ::1/128 -j RETURN
ip6tables -w -A RAKAZO_TERM_OUT6 -m mark --mark 0x51821 -j RETURN
if [ -n "$provider_mark" ]; then
 ip6tables -w -A RAKAZO_TERM_OUT6 -m mark --mark "$provider_mark" -j RETURN
fi
# Replies to provider-forwarded preview connections must retain their route.
ip6tables -w -A RAKAZO_TERM_OUT6 -m conntrack --ctdir REPLY -j RETURN
ip6tables -w -A RAKAZO_TERM_OUT6 -j REJECT
ip6tables -w -C OUTPUT -m cgroup --path "$terminal_group" -j RAKAZO_TERM_OUT6 2>/dev/null || ip6tables -w -I OUTPUT 1 -m cgroup --path "$terminal_group" -j RAKAZO_TERM_OUT6
ROUTES
  chmod 700 /usr/local/lib/rakazo-network/terminal-routes.sh
  cat > /etc/systemd/system/rakazo-terminal-routes.service <<ROUTE_UNIT
[Unit]
Description=Route bot terminal process groups through SOCKS
After=rakazo-terminal-tcp.service rakazo-terminal-dns.service user@${terminal_uid}.service
Requires=rakazo-terminal-tcp.service rakazo-terminal-dns.service
Wants=user@${terminal_uid}.service
[Service]
Type=oneshot
ExecStart=/usr/local/lib/rakazo-network/terminal-routes.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
ROUTE_UNIT
  chmod 644 /etc/systemd/system/rakazo-terminal-*.service
  systemctl daemon-reload
  systemctl enable rakazo-terminal-tcp.service rakazo-terminal-dns.service rakazo-terminal-routes.service
  systemctl restart rakazo-terminal-tcp.service rakazo-terminal-dns.service
  systemctl is-active --quiet rakazo-terminal-tcp.service rakazo-terminal-dns.service
  systemctl restart rakazo-terminal-routes.service
  # Test DNS after the unprivileged daemon has started, including AppArmor and
  # the TCP tunnel. A parsed config alone does not establish readiness.
  python3 - <<'DNS_READY'
import os, socket, struct, time
for attempt in range(6):
    identifier = os.urandom(2)
    query = identifier + struct.pack("!HHHHH", 0x100, 1, 0, 0, 0) + b"\x07example\x03com\x00" + struct.pack("!HH", 1, 1)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(5)
            client.sendto(query, ("127.0.0.1", 1053))
            reply = client.recv(4096)
        if len(reply) >= 12 and reply[:2] == identifier and reply[3] & 15 == 0 and struct.unpack("!H", reply[6:8])[0] > 0:
            break
    except OSError:
        pass
    if attempt == 5:
        raise SystemExit("Terminal proxy DNS is not ready")
    time.sleep(1)
DNS_READY
  # Keep environment-aware tools on remote hostname resolution as well. TCP
  # routing above also covers tools which deliberately ignore these variables.
  cat > /etc/profile.d/rakazo-terminal-proxy.sh <<'PROXY_ENV'
export ALL_PROXY=socks5h://10.202.0.1:1080
export all_proxy="$ALL_PROXY"
export NO_PROXY=localhost,127.0.0.1,::1,10.202.0.1
export no_proxy="$NO_PROXY"
PROXY_ENV
  chmod 644 /etc/profile.d/rakazo-terminal-proxy.sh
  flock -u 8
  exec 8>&-
}

# Update a running computer without restarting its browser or provider daemon.
if [ "${1:-}" = "--terminal-proxy-only" ]; then
  install_terminal_proxy
  echo RAKAZO_TERMINAL_PROXY_READY
  exit 0
fi
exec 9>/run/lock/rakazo-network-bootstrap.lock
flock -n 9 || exit 75
operation=$(cat /home/user/.rakazo-network/bootstrap-operation)
boot=$(cat /proc/sys/kernel/random/boot_id)
[[ "$operation" =~ ^[0-9a-f-]{36}$ ]]
install -d -m 700 /etc/wireguard /usr/local/lib/rakazo-network
systemctl disable --now rakazo-network-lock.service rakazo-network-dns.service rakazo-wireguard.service wg-quick@rakazo0.service 2>/dev/null || true
install -m 700 /home/user/.rakazo-network/lock.sh /usr/local/lib/rakazo-network/lock.sh
/usr/local/lib/rakazo-network/lock.sh
ip link delete rakazo0 2>/dev/null || true
rm -f /etc/systemd/system/ascii-agent.service.d/70-rakazo-capture.conf /etc/rakazo-boat-backup-direct
install -m 600 /home/user/.rakazo-network/wireguard.conf /etc/wireguard/rakazo0.conf
cat > /etc/systemd/system/rakazo-wireguard.service <<'UNIT'
[Unit]
Description=Private link for Rakazo browser SOCKS proxy
After=network.target
[Service]
Type=oneshot
ExecStart=/usr/bin/wg-quick up rakazo0
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable rakazo-wireguard.service
systemctl restart rakazo-wireguard.service
# Chromium policy applies to all managed desktop browser profiles.
for directory in /etc/chromium/policies/managed /etc/chromium-browser/policies/managed /etc/opt/chrome/policies/managed; do
 install -d -m 755 "$directory"
 cat > "$directory/rakazo-proxy.json" <<'POLICY'
{"ProxySettings":{"ProxyMode":"fixed_servers","ProxyServer":"socks5://10.202.0.1:1080","ProxyBypassList":"localhost;127.0.0.1;[::1]"},"QuicAllowed":false,"WebRtcIPHandling":"disable_non_proxied_udp"}
POLICY
 chmod 644 "$directory/rakazo-proxy.json"
done
if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then
 sed -i 's|http://archive.ubuntu.com|https://archive.ubuntu.com|g; s|http://security.ubuntu.com|https://security.ubuntu.com|g' /etc/apt/sources.list.d/ubuntu.sources
fi
missing=false
for tool in Xvfb x11vnc fluxbox xterm websockify redsocks unbound; do command -v "$tool" >/dev/null || missing=true; done
[ -f /usr/share/novnc/vnc.html ] || missing=true
if [ "$missing" = true ]; then timeout --kill-after=10s 480s python3 /home/user/.rakazo-network/desktop-install.py; fi
install_terminal_proxy
rm -f /home/user/.rakazo-network/wireguard.conf
printf '%s %s\n' "$operation" "$boot" > /home/user/.rakazo-network/bootstrap-complete
echo RAKAZO_NETWORK_BOOTSTRAP_COMPLETE
