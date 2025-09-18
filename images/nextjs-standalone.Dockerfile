# Build stage
FROM node:20-bullseye AS base
ENV PNPM_HOME=/home/node/.local/share/pnpm NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apt-get update && apt-get install -y \
    python3 build-essential git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm fetch

FROM base AS build
COPY --from=deps /root/.local/share/pnpm/store /root/.local/share/pnpm/store
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm build

# Runtime stage
FROM node:20-bullseye AS runner

# Create non-root user for runtime
RUN useradd -m -s /bin/bash -g users nextjs || true
RUN mkdir -p /app /home/nextjs
RUN chown -R nextjs:users /app /home/nextjs

ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
WORKDIR /app

# Copy from build stage (files will inherit build permissions)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Ensure final permissions are correct
RUN chown -R nextjs:users /app

EXPOSE 3000
USER nextjs
CMD ["node", "server.js"]