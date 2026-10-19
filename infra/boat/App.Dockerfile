ARG BASE_IMAGE=ghcr.io/elie222/rakazo/app:edge
FROM ${BASE_IMAGE}
USER root
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
