FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
RUN npm ci --omit=dev
EXPOSE 3001
CMD ["node", "dist/index.js"]
