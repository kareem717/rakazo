ARG BASE_IMAGE=ghcr.io/elie222/rakazo/app:edge
FROM ${BASE_IMAGE}
USER root
COPY packages/adapters/package.json /app/packages/adapters/package.json
COPY infra/boat/tool-egress-package-lock.json /opt/rakazo-tool-egress/package-lock.json
# Add the adapter runtime libraries without replacing the base image's workspace
# dependencies. npm ci verifies this isolated lock against the adapter version.
RUN node -e 'const fs=require("node:fs"); const {socks,yaml}=JSON.parse(fs.readFileSync("/app/packages/adapters/package.json")).dependencies; fs.writeFileSync("/opt/rakazo-tool-egress/package.json",JSON.stringify({name:"rakazo-tool-egress",version:"1.0.0",private:true,dependencies:{socks,yaml}}))' \
 && npm ci --prefix /opt/rakazo-tool-egress --omit=dev --ignore-scripts --no-audit --no-fund \
 && ln -sfn /opt/rakazo-tool-egress/node_modules/socks /app/packages/adapters/node_modules/socks \
 && ln -sfn /opt/rakazo-tool-egress/node_modules/yaml /app/packages/adapters/node_modules/yaml
COPY --chown=node:node packages/contracts/src/ /app/packages/contracts/src/
COPY --chown=node:node packages/adapter-kit/src/ /app/packages/adapter-kit/src/
COPY --chown=node:node packages/db/src/ /app/packages/db/src/
COPY --chown=node:node packages/db/prisma/schema.prisma /app/packages/db/prisma/schema.prisma
COPY --chown=node:node packages/db/prisma/migrations/ /app/packages/db/prisma/migrations/
RUN pnpm --filter @rakazo/db generate
COPY --chown=node:node apps/api/src/router.ts /app/apps/api/src/router.ts
COPY --chown=node:node apps/web/src/ /app/apps/web/src/
COPY --chown=node:node infra/sandboxes/computer/rakazo-page-browser /app/infra/sandboxes/computer/rakazo-page-browser
COPY --chown=node:node infra/sandboxes/computer/rakazo-patchright-browser infra/sandboxes/computer/install-browser-driver.py infra/sandboxes/computer/requirements-patchright.txt /app/infra/sandboxes/computer/
COPY --chown=node:node packages/adapters/src/ /app/packages/adapters/src/
COPY --chown=node:node apps/web/vite.config.ts /app/apps/web/vite.config.ts
COPY --chown=node:node packages/core/src/ /app/packages/core/src/
COPY --chown=node:node packages/core/package.json /app/packages/core/package.json
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm exec tsx -e 'Promise.all([import("./apps/api/src/router.ts"), import("./packages/adapters/src/executor.ts")]).then(() => console.log("Runtime imports verified"))'
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
COPY --chown=node:node infra/sandboxes/supervisor/src/ /app/infra/sandboxes/supervisor/src/
COPY --chown=node:node infra/sandboxes/supervisor/package.json /app/infra/sandboxes/supervisor/package.json
RUN mkdir -p /app/infra/sandboxes/supervisor/node_modules/@rakazo \
 && ln -sfn /app/packages/contracts /app/infra/sandboxes/supervisor/node_modules/@rakazo/contracts
USER node
