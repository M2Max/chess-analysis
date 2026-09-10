# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install bun
RUN npm install -g bun

# Install dependencies — postinstall copies the Stockfish WASM builds into
# public/ (scripts/fetch-engine.ts) and builds the opening index from the
# Lichess dataset (scripts/fetch-openings.ts).
# (scripts/ must exist before `bun install` because of the postinstall hook.)
COPY package.json bun.lock ./
COPY scripts ./scripts
RUN bun install

# Copy source and build (tsc typecheck + vite build; public/ → dist/)
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY src ./src
# static assets (logo, favicons); .dockerignore keeps the big stockfish dirs
# out of the context - postinstall re-creates them here before the build
COPY public ./public
RUN bun run build

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Install bun + su-exec (used by the entrypoint to drop to the `node` user)
RUN npm install -g bun && apk add --no-cache su-exec

# dist/ already contains the Stockfish WASM builds (copied from public/ by
# vite). The Bun server has no runtime dependencies.
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY server ./server
# the server imports the games API client (src/api/games.ts) to
# perform the retrieval itself - Bun runs the TS directly, no build needed
COPY src ./src

# SQLite database (games, analyses, per-player history) - mount a volume
# here to persist it (see docker-compose.yml / README "Data & backup").
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATABASE_PATH=/app/data/review.db
VOLUME ["/app/data"]

EXPOSE 3000

ENV NODE_ENV=production

# The server process runs as the unprivileged `node` user (uid 1000), not
# root. The entrypoint (running as root) makes the root-owned host mounts
# usable first: chown of the data dir + copying the TLS cert into a node-
# readable in-container file (a root-owned 600 key.pem on the host would
# otherwise silently degrade the server to plain HTTP).
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
