# App image for compose.prod.yml (ADR-0002). Postgres runs in its own container.
FROM oven/bun:1.3.10-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.10-slim AS geoip
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/fetch-geoip.sh scripts/
RUN bash scripts/fetch-geoip.sh data/dbip-country-lite.mmdb

FROM oven/bun:1.3.10-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules node_modules
COPY --from=geoip /app/data data
COPY package.json tsconfig.json ./
COPY openapi.yaml ./
COPY migrations migrations
COPY src src
USER bun
EXPOSE 3000
CMD ["bun", "src/server.ts"]
