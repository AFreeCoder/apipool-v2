FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat && yarn global add pnpm@10

WORKDIR /app

COPY package.json pnpm-lock.yaml* source.config.ts next.config.mjs ./
RUN pnpm i --frozen-lockfile

# Rebuild the source code only when needed
FROM deps AS builder

WORKDIR /app

# NEXT_PUBLIC_* are inlined into the client bundle at build time. Defaults match
# code defaults so CI builds are unaffected; local compose overrides via build.args.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_APIPOOL_API_BASE_URL=https://api2.apipool.dev
ARG NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL=gpt-4o-mini
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_APIPOOL_API_BASE_URL=$NEXT_PUBLIC_APIPOOL_API_BASE_URL \
    NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL=$NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL

# Cap V8 heap during build so memory-constrained Docker hosts GC instead of OOM-killing.
# Default 4096 matches CI/Vercel; local compose passes a lower value via build arg.
ARG NODE_BUILD_MEMORY=4096

COPY . .
RUN NODE_OPTIONS=--max-old-space-size=$NODE_BUILD_MEMORY pnpm build

# Bundle a self-contained SQLite migrator (drizzle-orm bundled in; @libsql/client
# kept external — it is already part of the standalone runtime the portal uses).
RUN node_modules/.bin/esbuild deploy/migrate.src.mjs \
      --bundle --platform=node --format=cjs \
      --external:@libsql/client \
      --outfile=deploy/migrate.cjs

# Idempotent catalog initialization runs after schema migrations so production
# releases can add missing models/listings without overwriting operator changes.
RUN node_modules/.bin/esbuild scripts/init-catalog.ts \
      --bundle --platform=node --format=esm --conditions=react-server \
      --external:@libsql/client \
      --outfile=deploy/catalog-init.mjs

# VPS-only live smoke runner. GitHub Actions deliberately avoids production
# secrets; deploy/live-smoke.sh runs this bundle with server-local env.
RUN node_modules/.bin/esbuild scripts/smoke-mvp-runner.ts \
      --bundle --platform=node --format=cjs --conditions=react-server \
      --external:@libsql/client \
      --outfile=deploy/smoke-mvp.cjs
RUN node_modules/.bin/esbuild scripts/smoke-gateway-runner.ts \
      --bundle --platform=node --format=cjs --conditions=react-server \
      --external:@libsql/client \
      --outfile=deploy/smoke-gateway.cjs
RUN node_modules/.bin/esbuild scripts/smoke-image-runner.ts \
      --bundle --platform=node --format=cjs --conditions=react-server \
      --external:@libsql/client \
      --outfile=deploy/smoke-image.cjs
RUN node_modules/.bin/esbuild scripts/smoke-recharge-runner.ts \
      --bundle --platform=node --format=cjs --conditions=react-server \
      --external:@libsql/client \
      --outfile=deploy/smoke-recharge.cjs
RUN node_modules/.bin/esbuild scripts/maintain-newapi-runtime-pool.ts \
      --bundle --platform=node --format=cjs --conditions=react-server \
      --external:@libsql/client \
      --outfile=deploy/runtime-pool-maintenance.cjs

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    mkdir .next && \
    chown nextjs:nodejs .next

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Migration assets (entrypoint runs them only for sqlite/turso providers)
COPY --from=builder --chown=nextjs:nodejs /app/deploy/migrate.cjs ./migrate.cjs
COPY --from=builder --chown=nextjs:nodejs /app/deploy/catalog-init.mjs ./catalog-init.mjs
COPY --from=builder --chown=nextjs:nodejs /app/deploy/smoke-mvp.cjs ./smoke-mvp.cjs
COPY --from=builder --chown=nextjs:nodejs /app/deploy/smoke-gateway.cjs ./smoke-gateway.cjs
COPY --from=builder --chown=nextjs:nodejs /app/deploy/smoke-image.cjs ./smoke-image.cjs
COPY --from=builder --chown=nextjs:nodejs /app/deploy/smoke-recharge.cjs ./smoke-recharge.cjs
COPY --from=builder --chown=nextjs:nodejs /app/deploy/runtime-pool-maintenance.cjs ./runtime-pool-maintenance.cjs
COPY --from=builder --chown=nextjs:nodejs /app/src/config/db/migrations_sqlite ./migrations_sqlite
COPY --from=builder --chown=nextjs:nodejs /app/deploy/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER nextjs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV MIGRATIONS_DIR=./migrations_sqlite

# entrypoint runs migrations (sqlite/turso) then starts the standalone server
CMD ["./entrypoint.sh"]
