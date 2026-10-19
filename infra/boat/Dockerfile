FROM tailscale/tailscale@sha256:87c55d6be56ad85b3d8bceca5f87f73de288c609131460dd1be1874c250cc41d
RUN apk add --no-cache nodejs wireguard-tools iproute2 iptables curl openssh-client
WORKDIR /deployment
ENTRYPOINT ["/bin/sh", "/deployment/entrypoint.sh"]
