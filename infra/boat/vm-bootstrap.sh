#!/bin/bash
set -euo pipefail
umask 077
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
for tool in Xvfb x11vnc fluxbox xterm websockify; do command -v "$tool" >/dev/null || missing=true; done
[ -f /usr/share/novnc/vnc.html ] || missing=true
if [ "$missing" = true ]; then timeout --kill-after=10s 480s python3 /home/user/.rakazo-network/desktop-install.py; fi
rm -f /home/user/.rakazo-network/wireguard.conf
printf '%s %s\n' "$operation" "$boot" > /home/user/.rakazo-network/bootstrap-complete
echo RAKAZO_NETWORK_BOOTSTRAP_COMPLETE
