# Plain Node: the scraper talks to Flipp's JSON API, no browser required.
# Multi-stage with explicit `dev` and `prod` targets — see backend/Dockerfile
# for why dependencies are installed here rather than at container start.

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --include=dev

# ── dev: hot-reloading target used by docker-compose.override.yml ────────────
FROM node:20-slim AS dev
WORKDIR /usr/src/app
ENV NODE_ENV=development
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
CMD ["npm", "run", "dev"]

# ── builder ──────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── prod: lean runtime. The default target. ──────────────────────────────────
FROM node:20-slim AS prod
WORKDIR /usr/src/app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=builder /usr/src/app/dist ./dist
CMD ["npm", "start"]
