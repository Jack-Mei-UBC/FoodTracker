# 1. Install dependencies
FROM node:18-alpine AS deps
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install

# 2. Rebuild the source code only when needed
FROM node:18-alpine AS builder
WORKDIR /usr/src/app
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .
RUN mkdir -p public
RUN npm run build

# 3. Production image, copy all the files and run next
FROM node:18-alpine AS runner
WORKDIR /usr/src/app

ENV NODE_ENV production

COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/.next ./.next
COPY --from=builder /usr/src/app/public ./public

EXPOSE 3000

CMD ["npm", "start"]
