ARG BASE_IMAGE=ghcr.io/elie222/rakazo/app:edge
FROM ${BASE_IMAGE}
USER root
COPY --chown=node:node packages/adapters/src/ /app/packages/adapters/src/
COPY --chown=node:node apps/web/src/pages/memory-providers/ /app/apps/web/src/pages/memory-providers/
RUN RAKAZO_ALLOW_DEV_SECRETS=1 pnpm --filter @rakazo/web build
USER node
