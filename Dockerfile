FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat && yarn global add pnpm@10

WORKDIR /app

COPY package.json pnpm-lock.yaml* source.config.ts next.config.mjs ./
# Docker Hub and npm registry can be slow or flaky on some networks.
# Give pnpm more time and retries so image builds are less brittle.
RUN pnpm i --frozen-lockfile --fetch-timeout=600000 --fetch-retries=5 --network-concurrency=8

# Rebuild the source code only when needed
FROM deps AS builder

WORKDIR /app

# NEXT_PUBLIC_* are inlined into the client bundle at build time. Defaults match
# code defaults so CI builds are unaffected; local compose overrides via build.args.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_APIPOOL_API_BASE_URL=https://api.apipool.dev/v1
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
COPY --from=builder --chown=nextjs:nodejs /app/src/config/db/migrations_sqlite ./migrations_sqlite
COPY --from=builder --chown=nextjs:nodejs /app/deploy/entrypoint.sh ./entrypoint.sh
RUN sed -i 's/\r$//' ./entrypoint.sh && chmod +x ./entrypoint.sh

USER nextjs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV MIGRATIONS_DIR=./migrations_sqlite

# entrypoint runs migrations (sqlite/turso) then starts the standalone server
CMD ["./entrypoint.sh"]
