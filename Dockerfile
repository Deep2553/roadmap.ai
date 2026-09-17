# syntax=docker/dockerfile:1

FROM node:22-slim AS deps
WORKDIR /app
# better-sqlite3 (local-dev-only DB driver) has no prebuilt binary for every
# platform/Node combo and falls back to compiling from source via node-gyp.
# Acquire::Retries — apt does not retry a dropped download by default, and this
# stage pulls ~73MB of build tooling; on a slow link the 10MB gcc-12 package
# reliably stalls out ("Connection failed"), failing the build after ~9 minutes.
# Both apt-get invocations need the flags — index fetches drop too.
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 update \
  && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=60 install -y \
  --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time values are placeholders — the app reads real env vars at request
# time in production (Turso client, Auth.js), nothing secret is baked in.
ENV AUTH_SECRET=build-placeholder
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
