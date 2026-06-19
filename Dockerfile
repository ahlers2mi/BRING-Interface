# ---- Build-Stufe: Abhängigkeiten (inkl. nativem better-sqlite3) ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app

# Build-Tools als Fallback, falls kein vorkompiliertes better-sqlite3-Binary
# verfügbar ist. Bleiben nur in dieser Stufe, das finale Image bleibt schlank.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Laufzeit-Stufe ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Verzeichnis für die persistente SQLite-Datenbank
RUN mkdir -p /data && chown node:node /data

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV PORT=3000
ENV DB_PATH=/data/recipes.db
EXPOSE 3000

USER node
CMD ["node", "server.js"]
