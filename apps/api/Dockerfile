# One image, two processes: the HTTP API and the queue worker differ only by
# their entrypoint, so they share a build and stay in lockstep by construction.

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# --- Dependencies ----------------------------------------------------------
# Manifests are copied before sources so a code change does not invalidate the
# dependency layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/domain/package.json ./packages/domain/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/ubl/package.json ./packages/ubl/
RUN pnpm install --frozen-lockfile

# --- Runtime ---------------------------------------------------------------
FROM base AS runtime

# argon2 is a native module; alpine needs libstdc++ at runtime.
RUN apk add --no-cache libstdc++ tini

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/ubl/node_modules ./packages/ubl/node_modules

COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/api ./apps/api

WORKDIR /app/apps/api

# Run as an unprivileged user. The node image ships one already.
USER node

# tini reaps zombies and forwards signals, so SIGTERM reaches the graceful
# shutdown handler instead of being swallowed by PID 1.
ENTRYPOINT ["/sbin/tini", "--"]

# Overridden to src/worker.ts for the worker service.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]
