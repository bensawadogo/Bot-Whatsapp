#!/usr/bin/env bash
# =============================================================================
# INSTALL.sh — Installation automatique du projet AfriBot
#
# Ce script est IDEMPOTENT : il peut être relancé sans casser le projet.
#   - Le fichier .env existant n'est jamais écrasé
#   - Les dépendances npm sont réinstallées sans danger
#   - Les vérifications se contentent d'informer si tout est déjà en place
#
# Usage :
#   chmod +x INSTALL.sh && ./INSTALL.sh
#   (ou simplement : bash INSTALL.sh)
# =============================================================================

set -u

# Couleurs pour l'affichage dans le terminal
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[ATTENTION]${NC} $1"; }
fail() { echo -e "${RED}[ERREUR]${NC} $1" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Étape 1/6 — Vérification de Node.js >= 20
# -----------------------------------------------------------------------------
info "Étape 1/6 : Vérification de Node.js..."
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js n'est pas installé. Installez Node.js 20 ou supérieur : https://nodejs.org"
fi

NODE_MAJOR=$(node -p 'parseInt(process.versions.node, 10)')
if [ "${NODE_MAJOR}" -lt 20 ]; then
  fail "Node.js ${NODE_MAJOR} détecté. La version 20 ou supérieure est requise (moteurs : >=20.0.0)."
fi
info "Node.js $(node -v) détecté — OK"

# -----------------------------------------------------------------------------
# Étape 2/6 — Vérification de Docker et Docker Compose
# -----------------------------------------------------------------------------
info "Étape 2/6 : Vérification de Docker et Docker Compose..."
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker n'est pas installé. Installez Docker : https://docs.docker.com/get-docker/"
fi
info "Docker détecté : $(docker --version)"

if docker compose version >/dev/null 2>&1; then
  info "Docker Compose v2 (plugin Docker) détecté — OK"
elif command -v docker-compose >/dev/null 2>&1; then
  info "Docker Compose détecté (binaire docker-compose) — OK"
else
  fail "Docker Compose n'est pas installé. Installez-le : https://docs.docker.com/compose/install/"
fi

# -----------------------------------------------------------------------------
# Étape 3/6 — Installation des dépendances npm
# -----------------------------------------------------------------------------
info "Étape 3/6 : Installation des dépendances npm..."
if npm install; then
  info "Dépendances npm installées — OK"
else
  fail "L'installation npm a échoué. Vérifiez votre connexion et relancez le script."
fi

# -----------------------------------------------------------------------------
# Étape 4/6 — Création du fichier .env depuis .env.example (si absent)
# -----------------------------------------------------------------------------
info "Étape 4/6 : Préparation du fichier .env..."
if [ ! -f .env.example ]; then
  warn "Le fichier .env.example est introuvable à la racine du projet."
  warn "Créez-le en suivant le guide : docs/CONFIGURATION.md"
else
  if [ -f .env ]; then
    info "Le fichier .env existe déjà — il est conservé (aucun écrasement)."
  else
    cp .env.example .env
    info "Fichier .env créé depuis .env.example."
    echo ""
    warn ">>> INSTRUCTION : ouvrez .env et remplissez chaque variable en suivant docs/CONFIGURATION.md <<<"
  fi
fi

# -----------------------------------------------------------------------------
# Étape 5/6 — Vérification que le fichier .env existe
# -----------------------------------------------------------------------------
info "Étape 5/6 : Vérification de la présence du fichier .env..."
if [ ! -f .env ]; then
  fail "Le fichier .env est introuvable à la racine du projet. Copiez .env.example vers .env puis complétez-le."
fi
info "Fichier .env trouvé — OK"

# -----------------------------------------------------------------------------
# Étape 6/6 — Génération du client Prisma (si le schéma existe)
# -----------------------------------------------------------------------------
info "Étape 6/6 : Génération du client Prisma..."
if [ -f prisma/schema.prisma ]; then
  if npx prisma generate; then
    info "Client Prisma généré — OK"
  else
    fail "La génération du client Prisma a échoué."
  fi
else
  warn "prisma/schema.prisma introuvable — étape ignorée."
  warn "Le client Prisma sera généré après la création du schéma, via : npm run db:generate"
fi

# -----------------------------------------------------------------------------
# Succès — prochaines étapes
# -----------------------------------------------------------------------------
echo ""
echo -e "${GREEN}=================================================${NC}"
echo -e "${GREEN}   Installation d'AfriBot terminée avec succès   ${NC}"
echo -e "${GREEN}=================================================${NC}"
echo ""
echo "Prochaines étapes :"
echo "  1. Remplis .env avec tes clés Meta et Evolution API"
echo "  2. Lance : docker compose up -d"
echo "  3. Puis  : npm run db:deploy"
echo "  4. Puis  : npm run dev"
echo ""
