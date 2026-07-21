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

# Seed the /data directory that fly.toml (or a bind mount) can override
# with a persistent volume. This is fine to bake into the image because
# the mount will shadow it in production.
COPY data ./data

EXPOSE 8080
ENV PORT=8080

# The build output is CommonJS-friendly ESM emitted from tsconfig.
CMD ["node", "dist/server.js"]
