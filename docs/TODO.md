# TODO — AfriBot Backlog

Ce fichier est le backlog de référence du projet AfriBot. Chaque tâche est suffisamment précise pour être confiée directement à une IA de code ou à un développeur, sans contexte supplémentaire.

## Légende des statuts

- `[ ]` À faire
- `[~]` En cours
- `[x]` Terminé
- `[!]` Bloquant (doit être fait avant les autres)

## PHASE 0 — Fondations (Semaine 1) [PRIORITÉ ABSOLUE]

### Infrastructure Docker

- [x] [!] Créer `docker-compose.yml` avec les services : `evolution-api`, `postgres`, `redis`, `afribot`, `nginx` (+ chatwoot-rails, chatwoot-sidekiq)
- [x] [!] Créer `.env.example` avec toutes les variables documentées
- [x] [!] Configurer Evolution API en mode Cloud API Meta uniquement (variable `INTEGRATION=WHATSAPP-BUSINESS`)
- [x] [!] Configurer Nginx reverse proxy avec SSL
- [x] Créer un script d'installation automatique (`install.sh`)
- [ ] Tester la connexion Evolution API → Meta Cloud API

### Base Node.js/TypeScript

- [x] [!] Initialiser le projet Node.js 20 + TypeScript strict
- [x] [!] Installer et configurer ESLint + Prettier — ESLint migré en flat config v9 (`eslint.config.js`, scripts `eslint src`) [AJOUT 16/09]
- [x] [!] Créer la structure des dossiers `src/`
- [x] [!] Configurer Prisma ORM et le schéma de base de données
- [x] [!] Créer les migrations Prisma initiales
- [x] Configurer Jest pour les tests unitaires

### Webhook & Sessions

- [x] [!] Créer le `WebhookController` (réception des messages depuis Evolution API)
- [x] [!] Créer le `SessionManager` (Redis, TTL 30 minutes)
- [x] [!] Créer la machine à états `ConversationRouter`
- [x] [!] Créer le module `Sender` (envoi des messages via Evolution API)
- [ ] Tester la réception et l'envoi d'un message simple
- [x] Ajouter GET /webhook — vérification initiale Meta (hub.challenge) [AJOUT 11/09]
- [ ] Valider les formats de payload du Sender contre l'instance Evolution API réelle [AJOUT 11/09]

## PHASE 1 — Catalogue & Commandes (Semaine 2)

### Module Catalogue

- [x] Créer le schéma Prisma `Product` (id, nom, prix, stock, photos, catégorie, actif)
- [x] API REST catalogue — **lecture** : `GET /api/catalog` (liste paginée `?page&limit&q`) + `GET /api/catalog/:id` (détail), service `listProductsPaginated` (pagination SQL), monté sur `/api` dans `index.ts`
- [x] API REST catalogue — **écriture** : Create/Update/Delete produits — `src/routes/api/catalog.admin.routes.ts` : `POST /api/catalog`, `PUT /api/catalog/:id`, `PATCH /api/catalog/:id/stock`, `DELETE /api/catalog/:id` (soft delete), protégés JWT dashboard + UI web (`public/dashboard/index.html`)
- [x] Créer la réponse catalogue WhatsApp (liste avec numéros)
- [x] Créer la réponse détail produit (photo + prix + stock)
- [x] Gérer la recherche produit par mot-clé dans WhatsApp
- [x] Optimiser la taille des images (< 100 Ko pour 2G/3G) — `src/shared/images.ts` : sharp (EXIF rotate, resize max 1024 px, JPEG mozjpeg qualité dégressive 80→40) + 3 tests unitaires

### Module Commandes

- [x] Créer le schéma Prisma `Order` + `OrderItem`
- [x] Implémenter le flow de commande conversationnel : sélection produit → quantité → adresse → récap → confirmation
- [x] Gérer le panier (ajout, suppression, modification) — session `cart` : ajout avec fusion de quantité, « retirer N », « modifier N Q » (avec re-vérification stock), « vider », « annuler »
- [x] Gérer les commandes cash on delivery (COD)
- [x] Envoyer le récapitulatif de commande au client
- [x] Notifier le commerçant pour chaque nouvelle commande

## PHASE 2 — Paiements Mobile Money (Semaine 3)

### Module Paiement

- [ ] Créer un compte CinetPay (ou FedaPay selon le pays) — démarche commerciale (hors code) ; la config est déjà câblée (`CINETPAY_SITE_ID` / `CINETPAY_API_KEY` / `CINETPAY_NOTIFY_URL`)
- [x] Intégrer l'API CinetPay (génération de lien de paiement) — `payment.service.ts` : `createCinetPayLink()` (API checkout v2 `api-checkout.cinetpay.com/v2/payment` via axios, `transaction_id` = commande+uuid, persisté en PENDING avant envoi du lien)
- [x] Gérer les webhooks de confirmation de paiement — `POST /webhook/payment` (`webhook.controller.ts`) → `PaymentModule.handleWebhook()` : détection fournisseur (CinetPay `cpm_*` / FedaPay `event transaction.*`), **re-vérification auprès du fournisseur** (`verifyPayment()` — anti-webhook falsifié), paiement → SUCCESS + commande → PAID
- [x] Gérer les paiements Wave (Sénégal, Côte d'Ivoire, Burkina Faso) — via CinetPay `channels: 'ALL'` (Wave = canal Mobile Money de CinetPay, aucun code spécifique requis)
- [x] Gérer les paiements Orange Money (17 pays d'Afrique) — via CinetPay `channels: 'ALL'` (aucun code spécifique requis)
- [x] Gérer les paiements MTN Mobile Money — via CinetPay `channels: 'ALL'` (aucun code spécifique requis)
- [x] Gérer les paiements Moov Money — via CinetPay `channels: 'ALL'` (aucun code spécifique requis)
- [x] Envoyer le reçu de paiement au client (PDF ou texte formaté) — texte formaté dans `handleWebhook()` (`🧾 Reçu — Commande #xxxx` + total + statut PAYÉE) ;  PDF = Phase 4 (workflow n8n)
- [x] Envoyer la notification commerçant (paiement reçu + montant) — `notifyMerchant()` (`merchantNotifPhone` s'il est configuré, sinon `MERCHANT_PHONE` du .env ; log de repli si absent) appelé à l'initiation ET à la confirmation
- [x] Gérer les paiements échoués (retry, message d'erreur clair) — `PaymentModule.handle()` : « relancer » / « réessayer » / « payer » re-génère le lien ; erreurs d'initiation → message clair + repli « aide » ; `cancelPaymentAndOrder()` sur « annuler »
- [x] Gérer les remboursements — `src/modules/payments/refund.service.ts` : `refundOrder()` (transactionnel : paiement REFUNDED + commande CANCELLED + **remise en stock** atomique), `isRefundable()`, idempotent ; API dashboard protégée JWT `POST /api/refunds/:id` + `GET /api/refunds/:id/refundable` (`refunds.routes.ts`) ; ⚠️ l'appel fournisseur reste **manuel** (CinetPay v2 et SDK FedaPay 1.x n'exposent pas d'API refund — le service retourne le `transactionId` à valider dans le back-office marchand)

## PHASE 3 — Support Humain & Chatwoot (Semaine 4)

### Module Escalade

- [x] Installer et configurer Chatwoot (self-hosted)
- [x] Connecter Evolution API → Chatwoot (via AfriBot : module agent + webhook)
- [x] Implémenter la détection de blocage (3 tentatives = escalade)
- [x] Implémenter la commande "humain" ou "aide" → escalade
- [x] Gérer la reprise de main agent → retour bot (`resolveEscalation()`)
- [x] Envoyer l'historique de conversation à l'agent (historique Redis)

## PHASE 4 — Automatisations n8n (Semaine 5)

### Workflows n8n

- [ ] Installer et configurer n8n (self-hosted)
- [ ] Créer le workflow de rapport journalier commerçant (ventes, commandes)
- [ ] Créer le workflow d'alerte stock bas (< seuil configurable)
- [ ] Créer le workflow de relance client si commande abandonnée (24h)
- [ ] Créer le workflow de broadcast promotions aux clients opt-in
- [ ] Créer le workflow de rapport hebdomadaire PDF

## PHASE 5 — Dashboard & SaaS (Semaine 6-7)

### Dashboard commerçant

- [ ] Créer l'interface web de gestion du catalogue (ajout/modification/suppression)
- [ ] Créer l'interface web de suivi des commandes — **backend fait** : `GET /api/orders` (liste paginée `?page&limit&status&phone`) + `GET /api/orders/:id`, `listOrders` (pagination SQL, filtres statut/numéro) + 6 tests ; **reste l'UI web** (avec JWT Phase 5)
- [ ] Créer l'interface web de statistiques (messages, commandes, revenus)
- [ ] Créer l'interface web de configuration du bot (menus, messages)

### Mode SaaS multi-clients

- [ ] Concevoir le système de tenants (un serveur = plusieurs commerçants)
- [ ] Implémenter l'isolation des données par commerçant
- [ ] Implémenter la facturation automatique (Stripe ou CinetPay)
- [ ] Créer l'onboarding nouveau commerçant en self-service

## PHASE 6 — Optimisations Afrique (Continu)

- [ ] Ajouter le support multilingue : français, wolof, dioula, mooré, haoussa
- [ ] Implémenter le fallback SMS si WhatsApp non lu après 4h
- [ ] Implémenter des messages ultra-légers (texte brut si 2G détectée)
- [ ] Implémenter un mode hors-ligne partiel (queue Redis si serveur instable)
- [x] Ajouter le support des horaires commerçant (message "fermé" automatique) — `src/shared/businessHours.ts` : `isShopOpen()` (timezone IANA `MERCHANT_TIMEZONE`, plage nuit supportée 22h→6h), hook dans ConversationRouter à l'état IDLE (les flows engagés ne sont jamais coupés), `MERCHANT_OPEN_HOUR/CLOSE_HOUR` validés (ensemble ou rien) + 7 tests

## BUGS CONNUS

(vide au démarrage)

## NOTES TECHNIQUES

- Toujours activer `INTEGRATION=WHATSAPP-BUSINESS` dans Evolution API
- Ne JAMAIS activer Baileys en production
- Redis TTL sessions = 1800 secondes (30 minutes)
- Taille max image catalogue = 100 Ko (optimisation 2G)
- Toujours vérifier la signature du webhook avant traitement

## DORKING & FORKS — Découvertes & tâches (09/11/2026)

> Résultats détaillés dans `docs/RESEARCH.md` (AfriBot vs Meta, réalités africaines, forks recommandés).

### Tâches découvertes (à intégrer dans les phases)

- [ ] [Phase 1] Évaluer les **Single Product Messages / Catalog API** natifs WhatsApp en complément du catalogue Prisma (détail produit natif)
- [ ] [Phase 1] Évaluer les **WhatsApp Flows** natifs pour le formulaire d'adresse (alternative au flow maison)
- [ ] [Phase 2] Règle de coût pricing 2025 : JAMAIS de template dans le flow conversationnel (gratuit en CSW 24h) ; récap/reçus = utility templates gratuits dans CSW
- [ ] [Phase 2] Activer les **volume tiers** utility/authentication pour réduire les coûts
- [ ] [Phase 4] Router les broadcasts via **CTWA + FEP 72h** (messages gratuits) avant d'utiliser des templates marketing payants
- [ ] [Phase 6] **GAP réalités africaines : notes vocales** — réception `type:audio` + transcription + réponse vocale (usage massif des commerçants)
- [ ] [Phase 5] Surveiller la politique **"AI Providers"** Meta (en vigueur 16/02/2026) : impact tarifaire si AfriBot héberge des bots IA pour des tiers
- [ ] Étudier les forks : `Secreto31126/whatsapp-api-js` (TS MIT actif, fork n°1), `fbsamples/whatsapp-api-examples` (officiel Meta), `david-lev/pywa` (patterns Flows), `Forgemind-git/ForgeChat` (fair-code → patterns seulement), `CinetPay/cinetpay-seamless|js` (MIT, prod TS) + `fedapay/fedapay-node` (MIT) ; ⚠️ NE PAS utiliser `WhatsApp/WhatsApp-Nodejs-SDK` (ARCHIVÉ par Meta) ni `CinetPay/cinetpay-mcp` (sans licence)
- [ ] NE PAS fork les userbots Baileys (`Venocyber-md`, `BotsApp`, `venom`, `whatsmeow`) — risque de ban (voir NOTES TECHNIQUES)
