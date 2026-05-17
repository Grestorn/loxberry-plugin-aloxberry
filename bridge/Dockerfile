# Aloxberry bridge — production image.
# Multi-stage so the runtime image carries no build tooling.

# ---------- build stage ----------
FROM node:24-alpine AS build

WORKDIR /app

# Copy manifests first so dependency installation is its own cache layer.
# `npm ci` requires package-lock.json and installs exactly what's pinned —
# no version drift between builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- runtime stage ----------
FROM node:24-alpine AS runtime

WORKDIR /app

# node:24-alpine ships a non-root `node` user (uid 1000). Use it.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Docker probes /health every 30s. Container is healthy when /health returns
# 200; unhealthy after 3 consecutive failures. Node 24's built-in fetch
# means we don't need curl/wget in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
