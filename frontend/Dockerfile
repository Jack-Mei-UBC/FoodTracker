# Multi-stage with explicit `dev` and `prod` targets. See backend/Dockerfile for
# the rationale — deps are installed at build time, and the compose dev override
# bind-mounts source over the top while an anonymous volume protects
# node_modules.
#
# NOTE: this image is the Docker *server* deploy (`next build` + `next start`).
# The Capacitor mobile bundle is a separate path (`BUILD_TARGET=static npm run
# build:mobile` → ./out) and is deliberately not built here.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install

# ── dev: hot-reloading target used by docker-compose.override.yml ────────────
FROM node:22-alpine AS dev
WORKDIR /usr/src/app
ENV NODE_ENV=development
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
RUN mkdir -p public
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ── builder: produce the .next production build ──────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
RUN mkdir -p public
# NEXT_PUBLIC_* is baked in at build time, so the deploy URL must be supplied here.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

# ── prod: lean runtime. The default target. ──────────────────────────────────
FROM node:22-alpine AS prod
WORKDIR /usr/src/app
ENV NODE_ENV=production
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/.next ./.next
COPY --from=builder /usr/src/app/public ./public
EXPOSE 3000
CMD ["npm", "start"]
