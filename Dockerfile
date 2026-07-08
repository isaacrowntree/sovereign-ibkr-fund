# IB Gateway + Fund Bot
# Based on gnzsnz/ib-gateway-docker for headless IB Gateway
FROM ghcr.io/gnzsnz/ib-gateway:stable AS gateway

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM ghcr.io/gnzsnz/ib-gateway:stable
WORKDIR /app

# Install Node.js
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

ENV NODE_ENV=production \
  IB_HOST=127.0.0.1 \
  IB_PORT=4002 \
  TRADING_MODE=paper \
  PORT=3001

EXPOSE 3001

# The ib-gateway-docker entrypoint starts IB Gateway + Xvfb
# We add our bot as an additional process
CMD ["bash", "-c", "sleep 30 && node dist/index.js"]
