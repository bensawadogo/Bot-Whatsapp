# AfriBot 🌍

![Build](https://img.shields.io/badge/build-passing-brightgreen)
![Licence](https://img.shields.io/badge/licence-Apache%202.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-green)

Bot WhatsApp multi-fonctions pour commerçants africains, basé sur l'API officielle Meta (Cloud API), relayée par Evolution API. Zéro risque de bannissement.

---

## Problème résolu

- Les commerçants africains reçoivent des centaines de messages identiques par jour ("C'est combien ?", commandes perdues, paiements non confirmés).
- Même un téléphone haut de gamme ne suffit plus à gérer le volume de conversations.
- Les solutions existantes basées sur Baileys (non officiel) font bannir les numéros WhatsApp.

## Solution

AfriBot est un bot WhatsApp fonctionnant à 100 % sur la **Cloud API Meta officielle** (via Evolution API). Il automatise la réponse au catalogue, la prise de commande, les paiements Mobile Money (Wave, Orange Money, Moov, MTN), les livraisons par livreurs et la gestion du commerce depuis un dashboard — sans aucun risque de bannissement.

## Stack technique

| Composant | Technologie | Rôle |
|---|---|---|
| Couche WhatsApp | Evolution API (Cloud API Meta officiel) | Connexion officielle et sécurisée à WhatsApp |
| API | Node.js 20+ / TypeScript strict / Express 4 | Logique métier et API REST |
| Base de données | PostgreSQL + Prisma ORM | Stockage persistant (catalogue, commandes, paiements) |
| Cache / Sessions | Redis (ioredis) | Sessions conversationnelles (TTL 30 min) + cache |
| Validation | Zod | Validation fail-fast des variables d'environnement |
| Logs | winston + rotation quotidienne | Journalisation applicative |
| Tests | Jest + supertest + ts-jest | Tests unitaires et d'intégration |
| Paiements | CinetPay / FedaPay (+ PawaPay) | Intégration Wave, Orange Money, MTN, Moov |
| Support humain | Chatwoot (self-hosted) | Escalade vers un agent humain |
| Orchestration | n8n (self-hosted) | Automatisations (à venir) |
| Infrastructure | Docker Compose | Postgres, Redis, Evolution API, AfriBot, Chatwoot, n8n, Nginx |
| Reverse proxy | Nginx (SSL Let's Encrypt) | Exposition sécurisée en HTTPS |

## Fonctionnalités principales

### Fait ✅

- ✅ Réponse automatique catalogue (prix, stock, photos) + recherche par mot-clé, images compressées (< 100 Ko, optimisation 2G/3G via sharp)
- ✅ Prise de commande conversationnelle (machine à états, panier complet, commande cash à la livraison COD)
- ✅ Paiement Mobile Money : CinetPay et FedaPay (liens + webhooks re-vérifiés, reçu texte, notification commerçant), virement direct Wave / Orange Money / Moov (validation humaine), agrégateur PawaPay (repli automatique si non configuré)
- ✅ Remboursements (service + API dashboard ; l'appel fournisseur reste manuel dans le back-office marchand)
- ✅ Escalade vers un agent humain via Chatwoot (3 tentatives, mots-clés « humain » / « aide », reprise de main agent → bot)
- ✅ Livraisons par livreurs (notification WhatsApp, assignation, preuve photo, montant COD collecté) — flux « LIVRÉ <orderId> »
- ✅ Journal de conversation durable (conformité Meta — fenêtre 24 h / opt-in)
- ✅ Dashboard commerçant : API stats/commandes/catalogue/config + UI minimale web (`public/dashboard/`) avec authentification JWT
- ✅ Horaires d'ouverture (message « fermé » automatique, fuseau horaire + plage de nuit)
- ✅ Onboarding conversationnel guidé
- ✅ Support voix : disponibilité des providers de transcription (DigiDays primaire, SmilGo fallback) — transcription complète **à venir**

### À venir 🔜

- 🔜 Multilingue (wolof, dioula, mooré, haoussa…)
- 🔜 Automatisations n8n (rapports journalier/hebdo, alertes stock bas, relances 24 h, broadcasts opt-in) — le service est dans la stack, les workflows restent à créer
- 🔜 Fallback SMS si WhatsApp non lu, messages ultra-légers auto-adaptés aux réseaux 2G, mode hors-ligne partiel
- 🔜 Mode SaaS multi-clients (le projet est **mono-commerçant** par déploiement)
- 🔜 Rendu PDF des reçus de paiement

## Prérequis

- Node.js >= 20
- Docker & Docker Compose >= 2.0
- Compte Meta Business vérifié + numéro WhatsApp Business dédié
- Instances PostgreSQL et Redis locales (ou via Docker Compose)

## Structure du projet

```
afribot/
├── src/                      # Code source de l'application Express
│   ├── config/               # env.ts (Zod), logger (winston), prisma, redis
│   ├── shared/               # sender, sessions, conversation.router, webhook,
│   │                         # businessHours, images, templates, conformité Meta, auth JWT
│   ├── modules/              # agents, catalog, dashboard, delivery, onboarding,
│   │                         # orders, payments, voice
│   ├── routes/api/           # API REST du dashboard (catalog, orders, stats, refunds,
│   │                         # delivery, config, onboarding, templates, compliance, auth)
│   └── index.ts              # Point d'entrée Express (webhooks + API + /dashboard)
├── prisma/                   # Schéma, migrations et seed de la base de données
├── public/dashboard/         # UI web minimale du dashboard commerçant
├── docs/                     # ARCHITECTURE.md, CONFIGURATION.md, TODO.md, RESEARCH.md
├── scripts/                  # init-db.sh (création des bases au premier démarrage)
├── nginx/                    # Reverse proxy (nginx.conf, SSL)
├── n8n/                      # Workflows importables (à créer)
├── docker-compose.yml        # Orchestration de tous les services
├── .env.example              # Modèle des variables d'environnement
├── package.json              # Dépendances et scripts Node.js
└── README.md                 # Ce fichier
```

## Démarrage rapide

### 1. Configuration

```bash
cp .env.example .env
npm install
```

Remplir les secrets dans `.env` — minimum vital : `JWT_SECRET` (≥ 32 caractères), `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE_NAME`, `WA_BUSINESS_TOKEN_WEBHOOK`. Conserver `INTEGRATION=WHATSAPP-BUSINESS` (⚠️ Baileys est interdit : risque de bannissement).

### 2. Base de données et cache

Option A — conteneurs locaux :

```bash
docker compose up -d postgres redis
```

Option B — instances locales existantes : ajuster `DATABASE_URL` et `REDIS_URL` dans `.env`.

Puis :

```bash
npm run db:migrate deploy     # ou : npx prisma migrate deploy
npm run db:seed
```

### 3. Lancement

```bash
npm run dev
```

Le serveur écoute sur `PORT` (défaut 3001) ; le dashboard est servi sur `/dashboard`.

### 4. Stack complète (production)

```bash
docker compose up -d
```

Démarre Evolution API (Cloud API), Chatwoot, n8n et Nginx en plus de Postgres/Redis/AfriBot.

## Scripts utiles

| Commande | Description |
|---|---|
| `npm run dev` / `start:dev` | Serveur de développement (ts-node-dev, hot reload) |
| `npm run build` | Compilation TypeScript vers `dist/` |
| `npm start` | Lancement en production (`node dist/index.js`) |
| `npm run typecheck` | Vérification TypeScript (`tsc --noEmit`) |
| `npm run lint` / `lint:fix` | ESLint (flat config v9) sur `src/` |
| `npm run format` | Prettier sur `src/` |
| `npm test` / `test:watch` | Tests Jest (avec couverture) |
| `npm run db:migrate` / `db:deploy` | Migrations Prisma (dev / prod) |
| `npm run db:seed` | Seed des données initiales |
| `npm run db:studio` | Prisma Studio |

## Roadmap

Voir [docs/TODO.md](./docs/TODO.md) pour le backlog détaillé. État honnête :

- **Phases 0-2** (fondations, catalogue, commandes, paiements) : ✅ terminé
- **Phase 3** (support humain Chatwoot) : ✅ terminé
- **Phase 4** (automatisations n8n) : 🔜 service dans la stack, workflows à créer
- **Phase 5** (dashboard, SaaS) : ◐ backend des API fait + UI minimale ; dashboard complet et mode multi-clients **à venir**
- **Phase 6** (optimisations Afrique) : ◐ horaires + voix (disponibilité providers) faits ; multilingue, fallback SMS, notes vocales **à venir**

## Documentation

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — architecture technique (UML, machines à états, ADR)
- [CONFIGURATION.md](./docs/CONFIGURATION.md) — guide complet des variables d'environnement
- [TODO.md](./docs/TODO.md) — backlog et roadmap
- [RESEARCH.md](./docs/RESEARCH.md) — recherche AfriBot vs Meta, réalités africaines

## Licence

Distribué sous licence Apache 2.0.