# Jorcord server image. Build from the repository root (the server depends on packages/shared):
#   docker build -f apps/server/Dockerfile -t jorcord-server .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# Dependencies first so source edits do not bust the install layer.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@jorcord/server..."

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared ./packages/shared
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/server/src ./apps/server/src
COPY apps/server/migrations ./apps/server/migrations
RUN mkdir -p /data && chown -R node:node /data
USER node
WORKDIR /app/apps/server
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The workspace runs TypeScript directly through tsx (a runtime dependency of the server package, so `pnpm install --prod` also works).
CMD ["node_modules/.bin/tsx", "src/index.ts"]
