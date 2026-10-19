ARG GATEWAY_IMAGE=rakazo/egress:local
FROM ${GATEWAY_IMAGE}
# A privileged fixture can inherit a host path-based AppArmor profile for wg.
# Keep the test binary at a separate path; the host policy stays untouched.
RUN apk add --no-cache bash python3 && cp /usr/bin/wg /usr/local/bin/wg && cp /usr/bin/wg-quick /usr/local/bin/wg-quick
COPY infra/boat /source/infra/boat
ENV RAKAZO_ISOLATED_NETWORK_TEST=1
ENTRYPOINT ["bash", "/source/infra/boat/check-network-egress.sh"]
