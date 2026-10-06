# 🤖 Escouade Anti-Bugs & Anti-Dette — AfriBot

> Lis ce fichier en premier. Il définit comment les sous-agents collaborent pour corriger bugs + dette technique.

## Contexte projet
- **AfriBot** : Bot WhatsApp commerçants africains — Node 20 + TypeScript strict + Express + Prisma (PostgreSQL) + Redis (ioredis) + Evolution API (Cloud API Meta officielle, jamais Baileys).
- Règles dures : `INTEGRATION=WHATSAPP-BUSINESS`, TTL session 1800s, images < 100 Ko, `no-explicit-any:error`, `no-floating-promises:error`, `no-console:warn`.
- Entrée : `src/index.ts` | Sessions : `src/shared/session.ts` | Router : `src/shared/conversation.router.ts` | Envoi : `src/shared/sender.ts` | Commandes : `src/modules/orders/` | Paiements : `src/modules/payments/` | Catalogue : `src/modules/catalog/`

## L'escouade (5 sous-agents)

| # | Nom | Fichier | Mission |
|---|-----|---------|---------|
| 1 | 🐞 **bug-hunter** | `.agents/bug-hunter.md` | Chasse les bugs runtime : crash, logique métier, race conditions, webhooks, sessions |
| 2 | 🧹 **dette-technique** | `.agents/dette-technique.md` | Chasse la dette : TODO, `any`, `console.log`, encodage, Float vs Int FCFA, pagination mémoire, duplication |
| 3 | 🛡️ **securite** | `.agents/securite.md` | Audit sécu : auth JWT, bcrypt, webhooks HMAC, injection, prix manipulables, secrets |
| 4 | 🧪 **tests-qualite** | `.agents/tests-qualite.md` | Qualité : `npm run typecheck + lint + test`, coverage, tests de non-régression |
| 5 | 🎯 **orchestrateur** | `.agents/orchestrateur.md` | Chef d'orchestre : ordonnance 1→2→3→4, fusionne rapports, met à jour `docs/TODO.md` |

## Comment les utiliser (Cline / Roo / Muse Spark)

### Option A — Copier-coller le prompt
Ouvre le fichier `.agents/<nom>.md` et colle son contenu en tête de ta demande :
> « Agis comme bug-hunter (voir .agents/bug-hunter.md). Audite src/modules/orders/order.service.ts et propose le fix. »

### Option B — Modes personnalisés (Roo / Cline)
Le fichier `.roomodes` à la racine déclare les 5 modes. Dans Roo Code : `... → Settings → Modes → Import` → sélectionne `.roomodes`.

### Option C — Orchestration complète
> « Agis comme orchestrateur (voir .agents/orchestrateur.md). Lance un cycle complet bugs + dette sur tout src/ et génère docs/AUDIT_DETTE.md »

## Workflow recommandé
```
1. orchestrateur → inventaire (TODO, FIXME, any, console.log, Float, pagination)
2. bug-hunter → corrige bugs P0/P1 (crash, paiement, stock, webhook)
3. dette-technique → corrige dette (encodage, types, pagination SQL, duplication)
4. securite → verrouille (prix serveur, HMAC, JWT, rate-limit)
5. tests-qualite → valide (typecheck + lint + test --coverage, 0 régression)
6. orchestrateur → met à jour docs/TODO.md § BUGS CONNUS + docs/AUDIT_DETTE.md
```

## Garde-fous AfriBot (tous les agents doivent respecter)
- ❌ Jamais Baileys, jamais de canal non-officiel. Uniquement Cloud API Meta via Evolution API.
- ❌ Jamais confiance au webhook seul : `verifyPayment()` obligatoire avant `PAID`.
- ❌ Jamais de prix venu du client : recalculer depuis la DB (`Product.price`).
- ❌ Jamais `any`, jamais `console.log` dans `src/` (utiliser `logger` winston).
- ❌ Jamais de broadcast sans opt-in + fenêtre 24h + template approuvé.
- ✅ Toujours `npm run typecheck && npm run lint && npm test` avant de déclarer fini.
- ✅ Toujours lire `docs/ARCHITECTURE.md` + `docs/CONFIGURATION.md` avant de toucher au code.
