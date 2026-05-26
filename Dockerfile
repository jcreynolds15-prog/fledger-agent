# ─── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# mssql requires these native libs on Alpine
RUN apk add --no-cache libc6-compat

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# Drop root privileges
RUN addgroup -S fledger && adduser -S fledger -G fledger
USER fledger

CMD ["node", "dist/index.js"]
