# 1. Install dependencies & build typescript
FROM node:18-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# 2. Production runner stage
FROM node:18-alpine AS runner
WORKDIR /usr/src/app

ENV NODE_ENV production

COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/dist ./dist

# Install only production dependencies to keep the container minimal
RUN npm install --only=production

EXPOSE 4000

CMD ["node", "dist/server.js"]
