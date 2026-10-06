# =============================================================================
# AfriBot — Dockerfile multi-stage optimisé (Node.js 20, production)
# Aucune dépendance liée à Baileys/QR code : Cloud API Meta officielle via
# Evolution API uniquement.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 : builder — installation des dépendances + compilation TypeScript
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Copie des manifests puis npm ci pour un cache Docker efficace
COPY package.json package-lock.json ./
RUN npm ci

# Copie du code source et de la configuration TypeScript/Prisma
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
# Dashboard web statique (servi par Express sur /dashboard)
COPY public ./public

# Compilation TypeScript -> dist/ après génération du client Prisma
RUN npx prisma generate
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2 : runner — image de production minimale, sans root
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runner

# ffmpeg (traitement médias) et curl (HEALTHCHECK)
RUN apk add --no-cache ffmpeg curl

WORKDIR /app

# Artefacts de production depuis le builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# Dossiers persistants (médias catalogue et logs) accessibles à l'utilisateur node
RUN mkdir -p /app/uploads /app/logs && chown -R node:node /app/uploads /app/logs

# Ne jamais exécuter en root en production
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
