# App image for compose.prod.yml (ADR-0002). Postgres runs in its own container.
FROM oven/bun:1.3.10-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.10-slim AS geoip
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/fetch-geoip.sh scripts/
# The deploy passes the current month. A changed ARG invalidates the cached RUN below, so a new
# month's build downloads again instead of keeping the database of whichever month first built it.
ARG GEOIP_MONTH
RUN bash scripts/fetch-geoip.sh data/dbip-country-lite.mmdb

FROM oven/bun:1.3.10-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules node_modules
COPY --from=geoip /app/data data
COPY package.json tsconfig.json ./
COPY openapi.yaml ./
COPY migrations migrations
COPY content content
COPY src src
USER bun
EXPOSE 3000
CMD ["bun", "src/server.ts"]
