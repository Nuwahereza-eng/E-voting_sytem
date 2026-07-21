# Small production image for the Sauti USSD/SMS bridge.
# Used by fly.io (see fly.toml). Render can also use this via
# Dockerfile deploys.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Only install production deps for the runtime image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Create an empty /data directory. In production a Fly volume is mounted
# here (see fly.toml); the initial members.json / registry.json must be
# uploaded via `fly ssh sftp shell` or seeded through the API. We never
# bake real custodial secrets into the image.
RUN mkdir -p /app/data

EXPOSE 8080
ENV PORT=8080

# The build output is CommonJS-friendly ESM emitted from tsconfig.
CMD ["node", "dist/server.js"]
