#!/bin/bash
# Explicit Linux-only packet test. Never run in a host network namespace.
set -euo pipefail
[ "${RAKAZO_ISOLATED_NETWORK_TEST:-}" = 1 ] && [ -f /.dockerenv ] || {
  echo 'Run this acceptance check inside its privileged, network-none test container.' >&2
  exit 1
}
ip -j link show | python3 -c 'import json,sys; links=json.load(sys.stdin); assert len(links)==1 and links[0]["ifname"]=="lo", "Test requires a fresh --network none namespace"'
server=""; dns=""
trap 'kill ${server:+"$server"} ${dns:+"$dns"} 2>/dev/null || true; ip netns delete rzguest 2>/dev/null || true; ip netns delete rzexit 2>/dev/null || true' EXIT
mkdir -p /tmp/egress-test /etc/rakazo-network
umask 077
sysctl -qw net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1 net.ipv4.conf.all.rp_filter=0 net.ipv6.conf.all.disable_ipv6=0
ip netns add rzguest
ip netns add rzexit
for namespace in rzguest rzexit; do
  ip netns exec "$namespace" sysctl -qw net.ipv6.conf.all.disable_ipv6=0 net.ipv4.conf.all.rp_filter=0
  ip -n "$namespace" link set lo up
done
link() {
  local own=$1 peer=$2 namespace=$3 ipv4=$4 other4=$5 ipv6=$6 other6=$7
  ip link add "$own" type veth peer name "$peer"
  ip link set "$peer" netns "$namespace"
  ip address add "$ipv4" dev "$own"
  ip -6 address add "$ipv6" dev "$own" nodad
  ip link set "$own" up
  ip -n "$namespace" address add "$other4" dev "$peer"
  ip -n "$namespace" -6 address add "$other6" dev "$peer" nodad
  ip -n "$namespace" link set "$peer" up
}
link guestwan outer rzguest 10.10.0.1/24 10.10.0.2/24 fd10::1/64 fd10::2/64
link tailscale0 exitvpn rzexit 10.250.0.1/24 10.250.0.2/24 fd20::1/64 fd20::2/64
link direct0 exitwan rzexit 10.251.0.1/24 10.251.0.2/24 fd21::1/64 fd21::2/64
ip -n rzguest route add default via 10.10.0.1
ip -n rzguest -6 route add default via fd10::1
ip route add default via 10.251.0.2
ip -6 route add default via fd21::2
ip -n rzexit address add 198.51.100.10/32 dev lo
ip -n rzexit -6 address add 2001:db8::10/128 dev lo nodad
ip -n rzexit route add 10.10.0.0/24 via 10.251.0.1
ip -n rzexit -6 route add fd10::/64 via fd21::1

cat > /tmp/egress-test/server.py <<'PY'
import socket,struct,threading,time
def serve(family,kind,port):
    server=socket.socket(family,kind)
    if family==socket.AF_INET6:server.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
    server.bind(('2001:db8::10' if family==socket.AF_INET6 else '198.51.100.10',port))
    if kind==socket.SOCK_STREAM:server.listen(8)
    while True:
        if kind==socket.SOCK_STREAM:
            client,peer=server.accept()
            with client:
                client.recv(4096)
                body=peer[0].encode()
                client.sendall(b'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
        else:
            data,peer=server.recvfrom(4096)
            if port!=53:server.sendto(peer[0].encode(),peer);continue
            offset=12
            while data[offset]:offset+=data[offset]+1
            offset+=1
            question_type=struct.unpack('!H',data[offset:offset+2])[0]
            question=data[12:offset+4]
            if question_type not in (1,28):continue
            address=socket.inet_pton(socket.AF_INET if question_type==1 else socket.AF_INET6,'198.51.100.10' if question_type==1 else '2001:db8::10')
            answer=b'\xc0\x0c'+struct.pack('!HHIH',question_type,1,0,len(address))+address
            server.sendto(data[:2]+struct.pack('!HHHHH',0x8180,1,1,0,0)+question+answer,peer)
for family in (socket.AF_INET,socket.AF_INET6):
    for kind,port in ((socket.SOCK_STREAM,18080),(socket.SOCK_DGRAM,18081),(socket.SOCK_DGRAM,53)):
        threading.Thread(target=serve,args=(family,kind,port),daemon=True).start()
open('/tmp/egress-test/server-ready','w').close()
while True:time.sleep(1)
PY
ip netns exec rzexit python3 /tmp/egress-test/server.py &
server=$!
for attempt in $(seq 1 50); do [ -f /tmp/egress-test/server-ready ] && break; sleep 0.1; done

# Prove that an ordinary WAN fallback exists before testing that it is rejected.
[ "$(curl --noproxy '*' -4 -fsS --max-time 3 http://198.51.100.10:18080)" = 10.251.0.1 ]
EGRESS_MODE=all sh /source/infra/boat/gateway-network.sh
ip route add default via 10.250.0.2 dev tailscale0 table 52
ip -6 route add default via fd20::2 dev tailscale0 table 52
ip rule add priority 5270 table 52
ip -6 rule add priority 5270 table 52
wg genkey > /tmp/egress-test/client.key
wg pubkey < /tmp/egress-test/client.key > /tmp/egress-test/client.pub
wg set rakazo0 peer "$(cat /tmp/egress-test/client.pub)" allowed-ips 10.202.0.2/32,fd42:202:7261::2/128
cat > /tmp/egress-test/rakazo0.conf <<EOF
[Interface]
PrivateKey = $(cat /tmp/egress-test/client.key)
Address = 10.202.0.2/32, fd42:202:7261::2/128
ListenPort = 51872
FwMark = 0x51821
MTU = 1280
[Peer]
PublicKey = $(cat /state/wireguard/server.pub)
Endpoint = 10.10.0.1:51871
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
EOF
ip netns exec rzguest wg-quick up /tmp/egress-test/rakazo0.conf > /tmp/egress-test/wg.log 2>&1
ip -n rzguest link add wg0 type wireguard
ip netns exec rzguest wg set wg0 fwmark 0x9090
printf 'all\n' > /etc/rakazo-network/egress-mode
ip netns exec rzguest bash /source/infra/boat/vm-egress.sh
ip netns exec rzguest bash /source/infra/boat/vm-egress.sh --check
[ "$(ip netns exec rzguest wg show wg0 fwmark)" = 0x9090 ]
dnsmasq --keep-in-foreground --no-resolv --no-hosts --cache-size=0 --server=198.51.100.10 --listen-address=10.202.0.1 --bind-interfaces > /tmp/egress-test/dns.log 2>&1 &
dns=$!

cat > /tmp/egress-test/probe.py <<'PY'
import socket,struct,sys,urllib.request
offline=sys.argv[1]=='offline'
for family,host,expected in ((socket.AF_INET,'198.51.100.10','10.250.0.1'),(socket.AF_INET6,'2001:db8::10','fd20::1')):
    bracket='['+host+']' if family==socket.AF_INET6 else host
    try:
        client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with client.open('http://'+bracket+':18080',timeout=2) as response:value=response.read().decode()
    except (OSError,ValueError):
        if not offline:raise
    else:
        assert not offline,'TCP escaped through the direct WAN'
        assert value==expected,(value,expected)
    with socket.socket(family,socket.SOCK_DGRAM) as client:
        client.settimeout(2)
        try:
            client.sendto(b'probe',(host,18081))
            value=client.recv(1024).decode()
        except OSError:
            if not offline:raise
        else:
            assert not offline,'UDP escaped through the direct WAN'
            assert value==expected,(value,expected)
# A real DNS query must also fail without falling back or serving cached data.
query=b'\x12\x34'+struct.pack('!HHHHH',0x100,1,0,0,0)+b'\x07routing\x07example\x04test\x00'+struct.pack('!HH',1,1)
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as client:
    client.settimeout(2)
    try:
        client.sendto(query,('10.202.0.1',53))
        reply=client.recv(4096)
        resolved=len(reply)>=12 and reply[3]&15==0 and struct.unpack('!H',reply[6:8])[0]>0
    except OSError:
        resolved=False
    assert resolved!=offline,'DNS did not follow the selected tunnel state'
if not offline:
    addresses={entry[4][0] for entry in socket.getaddrinfo('routing.example.test',18080)}
    assert '198.51.100.10' in addresses and '2001:db8::10' in addresses
print('Public TCP, UDP and DNS use the full tunnel' if not offline else 'TCP, UDP and DNS fail closed with an available direct WAN')
PY
python3 /tmp/egress-test/probe.py online
ip netns exec rzguest python3 /tmp/egress-test/probe.py online
ip link set tailscale0 down
ip route flush table 52
ip -6 route flush table 52
ip route get 198.51.100.10 | grep -q 'dev direct0'
python3 /tmp/egress-test/probe.py offline
ip netns exec rzguest python3 /tmp/egress-test/probe.py offline

# Restoring the tunnel recovers traffic without removing either rejection policy.
ip link set tailscale0 up
ip -6 address replace fd20::1/64 dev tailscale0 nodad
ip route add default via 10.250.0.2 dev tailscale0 table 52
ip -6 route add default via fd20::2 dev tailscale0 table 52
ip netns exec rzguest python3 /tmp/egress-test/probe.py online

# Switching back to browser-only removes terminal/full routing and restores WAN access.
ip netns exec rzguest wg-quick down /tmp/egress-test/rakazo0.conf >> /tmp/egress-test/wg.log 2>&1
sed -i 's@AllowedIPs = 0.0.0.0/0, ::/0@AllowedIPs = 10.202.0.1/32@' /tmp/egress-test/rakazo0.conf
ip netns exec rzguest wg-quick up /tmp/egress-test/rakazo0.conf >> /tmp/egress-test/wg.log 2>&1
printf 'browser\n' > /etc/rakazo-network/egress-mode
ip netns exec rzguest bash /source/infra/boat/vm-egress.sh
ip netns exec rzguest bash /source/infra/boat/vm-egress.sh --check
ip rule delete priority 5270 table 52
ip -6 rule delete priority 5270 table 52
EGRESS_MODE=browser sh /source/infra/boat/gateway-network.sh
[ "$(curl --noproxy '*' -4 -fsS --max-time 3 http://198.51.100.10:18080)" = 10.251.0.1 ]
[ "$(ip netns exec rzguest curl --noproxy '*' -4 -fsS --max-time 3 http://198.51.100.10:18080)" = 10.10.0.2 ]
echo 'Full-to-browser transition restores direct terminal traffic and removes full-routing rules'
[ "$(ip netns exec rzguest wg show wg0 fwmark)" = 0x9090 ]
[ "$(curl --noproxy '*' -6 -fsS --max-time 3 'http://[2001:db8::10]:18080')" = fd21::1 ]
[ "$(ip netns exec rzguest curl --noproxy '*' -6 -fsS --max-time 3 'http://[2001:db8::10]:18080')" = fd10::2 ]
