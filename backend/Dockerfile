# Multi-stage with explicit `dev` and `prod` targets.
#
# Dependencies are installed HERE, at image build time — not in the container's
# start command. docker-compose.override.yml bind-mounts the source for hot
# reload but masks node_modules with an anonymous volume, so the modules baked
# into this image survive and boot is fast.
#
# Consequence (the correct tradeoff): changing package.json needs an image
# rebuild — `docker compose up -d --build backend` — not just a restart.

# ── deps: node_modules incl. devDependencies (ts-node-dev, typescript) ────────
FROM node:18-alpine AS deps
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --include=dev

# ── dev: hot-reloading target used by docker-compose.override.yml ────────────
FROM node:18-alpine AS dev
WORKDIR /usr/src/app
ENV NODE_ENV=development
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
EXPOSE 4000
CMD ["npm", "run", "dev"]

# ── builder: compile TypeScript ──────────────────────────────────────────────
FROM node:18-alpine AS builder
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── prod: lean runtime, production deps only. The default target. ────────────
FROM node:18-alpine AS prod
WORKDIR /usr/src/app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /usr/src/app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server.js"]
