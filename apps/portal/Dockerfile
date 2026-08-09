# Static build served by nginx. The SPA needs no Node at runtime.

FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/portal/package.json ./apps/portal/
COPY packages/domain/package.json ./packages/domain/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/ubl/package.json ./packages/ubl/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps/portal ./apps/portal

WORKDIR /app/apps/portal
RUN pnpm exec vite build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/portal/dist /usr/share/nginx/html
COPY apps/portal/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
