ARG BASE_IMAGE=ghcr.io/elie222/rakazo/app:edge
FROM ${BASE_IMAGE}
USER root
COPY packages/adapters/package.json /app/packages/adapters/package.json
COPY infra/boat/tool-egress-package-lock.json /opt/rakazo-tool-egress/package-lock.json
# Add the proxy socket library without replacing the base image's workspace
# dependencies. npm ci verifies this isolated lock against the adapter version.
RUN node -e 'const fs=require("node:fs"); const {socks}=JSON.parse(fs.readFileSync("/app/packages/adapters/package.json")).dependencies; fs.writeFileSync("/opt/rakazo-tool-egress/package.json",JSON.stringify({name:"rakazo-tool-egress",version:"1.0.0",private:true,dependencies:{socks}}))' \
 && npm ci --prefix /opt/rakazo-tool-egress --omit=dev --ignore-scripts --no-audit --no-fund \
 && ln -sfn /opt/rakazo-tool-egress/node_modules/socks /app/packages/adapters/node_modules/socks
COPY --chown=node:node packages/contracts/src/ /app/packages/contracts/src/
COPY --chown=node:node packages/adapter-kit/src/ /app/packages/adapter-kit/src/
COPY --chown=node:node packages/db/src/events.ts /app/packages/db/src/events.ts
COPY --chown=node:node apps/api/src/router.ts /app/apps/api/src/router.ts
COPY --chown=node:node apps/web/src/locales/ /app/apps/web/src/locales/
COPY --chown=node:node apps/web/src/components/AskCard.tsx /app/apps/web/src/components/AskCard.tsx
COPY --chown=node:node apps/web/src/pages/shell/bot-credentials.tsx /app/apps/web/src/pages/shell/bot-credentials.tsx
COPY --chown=node:node infra/sandboxes/computer/rakazo-page-browser /app/infra/sandboxes/computer/rakazo-page-browser
COPY --chown=node:node packages/adapters/src/ /app/packages/adapters/src/
COPY --chown=node:node apps/web/src/pages/memory-providers/ /app/apps/web/src/pages/memory-providers/
COPY --chown=node:node apps/web/vite.config.ts /app/apps/web/vite.config.ts
COPY --chown=node:node apps/web/src/box-screen-auth.ts /app/apps/web/src/box-screen-auth.ts
COPY --chown=node:node packages/core/src/thread-message-updates.ts /app/packages/core/src/thread-message-updates.ts
COPY --chown=node:node packages/core/src/node/screen-capability.ts /app/packages/core/src/node/screen-capability.ts
COPY --chown=node:node apps/web/src/pages/Shell.tsx /app/apps/web/src/pages/Shell.tsx
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm exec tsx -e 'Promise.all([import("./apps/api/src/router.ts"), import("./packages/adapters/src/executor.ts")]).then(() => console.log("Runtime imports verified"))'
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
USER node
