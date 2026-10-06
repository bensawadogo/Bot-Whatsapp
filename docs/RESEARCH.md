# RESEARCH — Dorking avancé & benchmarks (AfriBot)

> Rapport généré par Google Dorking avancé (09/11/2026). Objectif : faire le point entre AfriBot (TODO.md) et l'offre bot de Meta, vérifier l'alignement avec les réalités africaines, et identifier les meilleurs projets GitHub à fork.

## 1. Le point — AfriBot vs offre bot Meta

### 1.1 Ce que Meta propose "par défaut" (3 niveaux)

| Niveau | Offre Meta | Cible | Limite face à AfriBot |
|---|---|---|---|
| 1 | **WhatsApp Business App** (gratuite) | Petit commerçant seul | Catalogue natif, réponses rapides, mais zéro automatisation de commande, zéro paiement, zéro SaaS |
| 2 | **Business Platform / Cloud API** | Commerçants + intégrateurs | C'est la couche qu'utilise AfriBot (via Evolution API `INTEGRATION=WHATSAPP-BUSINESS`). Meta fournit la tuyauterie, PAS la logique métier |
| 3 | **Meta AI assistant** (grand public) | Utilisateurs finaux | Assistant conversationnel dans WhatsApp, mais pas un outil commerce B2B : pas de catalogue marchand, pas de Mobile Money, pas de machines à états |

**Conclusion 1 : AfriBot n'entre PAS en concurrence avec Meta AI.** Meta fournit l'infrastructure (Cloud API) et un assistant grand public ; personne chez Meta ne construit le bot commerce localisé Afrique francophone (machines à états, wolof/dioula/mooré, COD, Mobile Money). C'est exactement le gap qu'attaque la TODO.

### 1.2 Fonctions Cloud API exploitables (confirmées via la référence officielle des messages)

Types de messages officiels disponibles dès maintenant :

- Texte, réaction, image, audio, document, sticker, vidéo, contact, location
- **Interactive messages** : list messages (listes numérotées), reply buttons → idéal catalogue AfriBot Phase 1
- **Single Product Message / Catalog API** : catalogue natif WhatsApp (`product_retailer_id`) → complément possible du catalogue Prisma AfriBot
- **WhatsApp Flows** : formulaires multi-écrans natifs (draft/published/flow templates) → alternative au flow de commande maison
- Templates (marketing/utility/authentication), média par ID ou URL, typing indicator + read receipts

### 1.3 Pricing Meta 2025 (doc officielle — per-message depuis le 01/07/2025)

Le pricing 2025 est un **avantage caché pour AfriBot** :

- On n'est facturé QUE sur les **templates** délivrés ; les messages non-template (`text`, `image`, ...) sont **gratuits** dans la fenêtre de service client (**CSW** 24h après un message du client)
- → **Le flow de commande conversationnel AfriBot est quasi GRATUIT** : le client écrit en premier ("C'est combien ?"), la CSW s'ouvre, tout le flow (catalogue → quantité → adresse → récap) est en messages non-template gratuits
- **Utility templates gratuits** quand délivrés dans une CSW ouverte → les récap/reçus AfriBot peuvent être des templates utility gratuits dans ce cas
- **FEP (Free Entry Point) 72h** : client arrivant d'une Click-to-WhatsApp Ad → 72h de messages gratuits → à exploiter pour les broadcasts Phase 4
- **Volume tiers** : tarifs dégressifs utility/authentication
- Conversation-based pricing (CBP) **déprécié**
- **Nouveau max-price** pour le marketing (2026, Marketing Messages API)
- **Nouvelle politique "AI Providers"** (en vigueur 16/02/2026, MAJ 12/05/2026) : si AfriBot devient un fournisseur de bots IA hébergés pour des tiers → obligations tarifaires Meta dédiées à surveiller (impact mode SaaS Phase 5 si IA générative)

### 1.4 Tableau de décision AfriBot vs Meta

| Capacité | Meta natif | AfriBot (TODO) | Verdict |
|---|---|---|---|
| Catalogue en chat | Catalogue + Single Product Message | Catalogue Prisma + listes numérotées | **Combiner** : AfriBot en front, catalogue Meta optionnel |
| Flow de commande | Flows natifs (formulaires) | Machine à états `ConversationRouter` | **Combiner** : AfriBot conversationnel (plus naturel, gratuit en CSW), Flows pour formulaires d'adresse |
| Paiements in-chat | Limité à quelques marchés (Brésil, Inde, Singapour) | CinetPay/FedaPay → Wave, OM, MTN, Moov | **AfriBot gagne** : Meta ne couvre PAS l'Afrique de l'Ouest |
| COD | Aucun | Phase 1 | **AfriBot gagne** : réalité n°1 du commerce africain |
| Langues locales | Meta AI : non supportées pour commerce | fr + wolof + dioula + mooré + haoussa (Phase 6) | **AfriBot gagne** (avantage concurrentiel majeur) |
| Escalade humaine | Aucune | Chatwoot Phase 3 | **AfriBot gagne** |
| Zéro ban | Officiel = zéro ban | Cloud API via Evolution API | **Égalité** (contrainte respectée) |
| 2G/3G léger | Message poids réel | Images <100 Ko, texte brut fallback | **AfriBot gagne** |
| Broadcasts | Templates marketing PAYANTS | n8n + opt-in + FEP | **À optimiser** : router les opt-in via CTWA/FEP (72h gratuits) |

**Verdict global : la stratégie AfriBot (API officielle + logique métier locale) est correcte et comble un vrai vide.** Améliorations concrètes listées en section 4.

## 2. Vérification des réalités africaines

| Réalité africaine | AfriBot (TODO) | Statut |
|---|---|---|
| Mobile Money dominant (M-Pesa, Wave, Orange Money, MTN MoMo, Moov) — la carte bancaire est marginale en Afrique de l'Ouest | Phase 2 : CinetPay/FedaPay → Wave, OM, MTN, Moov + COD Phase 1 | ✅ Bien aligné |
| Confiance : préférence COD, escalade vers un humain | Phase 1 COD + Phase 3 Chatwoot | ✅ Aligné |
| Réseaux 2G/3G, data chère, téléphones d'entrée de gamme | Images <100 Ko, texte brut si 2G, queue Redis instable | ✅ Aligné |
| Multilingue : français seconde langue, wolof/dioula/mooré/haoussa répandus | Phase 6 multilingue | ✅ Aligné (aucun concurrent ne le fait) |
| Notes vocales = usage massif chez les commerçants | **Non couvert** | ❌ **GAP** → tâche ajoutée (réception audio + transcription — Cloud API supporte `type:audio`) |
| Horaires ("fermé" selon pays) | Phase 6 horaires commerçant | ✅ Aligné |
| Coût de diffusion (marketing chers) | Phase 4 broadcasts | ⚠️ À optimiser via FEP 72h + CTWA (section 4) |
| Statut "AI Provider" Meta (2026) si IA hébergée | Mode SaaS Phase 5 | ⚠️ À surveiller (référence pricing) |

> ⚠️ Limites du dorking du jour : GSMA (SOTIR) et DataReportal ont renvoyé 403/erreurs, et DDG/Bing ont bloqué les bots (CAPTCHA). Les chiffres GSMA SOTIR (comptes/valeurs Mobile Money Afrique) et DataReportal (pénétration WhatsApp Afrique) restent à confirmer manuellement.

### 2.1 Compléments stats obtenus (dorking approfondi)

- **M-Pesa (Wikipedia)** : lancé en 2007 (Safaricom/Vodafone), présent dans **8 pays africains** (Kenya, Tanzanie, Lesotho, RDC, Ghana, Mozambique, Égypte, Éthiopie) ; ~17M comptes au Kenya dès 2012, 7M en Tanzanie en 2016 ; frais de retrait élevés (~10% sur petits montants : KES 29 pour KES 300) → argument commercial AfriBot : **réduire le coût des frais par micro-paiements** est une vraie douleur des commerçants
- **DataReportal Digital 2025 (Global Overview)** : confirme le **mobile-first africain** — moins de la moitié des internautes africains utilisent un ordinateur (hors Afrique du Sud : 79,1% desktop) → l'interface WhatsApp-first d'AfriBot est le bon choix ; les rapports pays complets (Digital 2025 Nigeria/Kenya/...) sont publiés sur datareportal.com fin février chaque année
- **Tarifs Meta par pays** : la table "Country calling codes" de la page pricing (developers.facebook.com/docs/whatsapp/pricing) contient les taux marketing/utility/authentication par indicatif — le fetch est tronqué, **à consulter manuellement** pour chiffrer le SaaS par pays (Phase 5 : facturation)

## 3. Meilleurs projets GitHub à fork (résultats du dorking)

### 3.1 Couche Cloud API — forks recommandés (Node.js/TypeScript = stack AfriBot)

| Repo | Stars | Lang | Pourquoi le fork |
|---|---|---|---|
| `Secreto31126/whatsapp-api-js` | 354 | TS | **Fork n°1** : lib TS sans dépendance, WebhookServer inclus — colle au TS strict AfriBot |
| `great-detail/WhatsApp-JS-SDK` | 39 | TS | SDK Node/Deno/Bun moderne, ESM+CJS — pattern d'API |
| `wapikit/wapi.js` | 67 | TS | Node SDK Business apps + webhook receiver/server |
| `fbsamples/whatsapp-api-examples` | 291 | JS | **Exemples OFFICIELS Meta** — point de départ conformité (licence Meta samples, push 07/2026) |
| `WhatsApp/WhatsApp-Nodejs-SDK` | 274 | TS | ⚠️ **ARCHIVÉ par Meta (push 06/2023) — déprécié, NE PAS l'utiliser** ; confirmer préférer un SDK tiers actif |
| `david-lev/pywa` | 591 | Python | Wrapper le plus riche (Flows, templates, webhook server, calling, **MIT**, push 08/2026) — **port patterns vers TS** |
| `Neurotech-HQ/heyoo` | 513 | Python | Wrapper d'une boîte tanzanienne, éprouvé en Afrique de l'Est |
| `netflie/whatsapp-cloud-api` | 679 | PHP | Référence PHP, doc d'architecture à lire |

### 3.2 CRM / Inbox / Dashboard (phases 3 & 5)

| Repo | Stars | Pourquoi |
|---|---|---|
| `chatwoot/chatwoot` | 36.7k | Déjà dans la stack — patterns d'escalade et d'inbox (MIT) |
| `Forgemind-git/ForgeChat` | 60 | ⚠️ **fair-code** (source-available, PAS open source) : CRM Cloud API chats/contacts/templates/**broadcasts**/visual automation builder (JS/Express/React/PostgreSQL, push 09/2026) → **patterns seulement**, pas fork commercial libre |
| `gokapso/whatsapp-cloud-inbox` | — | Inbox open source Cloud API |
| `receevi/receevi` | — | Webhook receiver → CRM (successeur de `whatsapp-webhook`) |
| `aldinokemal/go-whatsapp-web-multidevice` (GOWA) | 4.7k | REST API + **intégration Chatwoot + MCP** — à étudier pour l'architecture Chatwoot (attention : NOWEB/websocket = pas officiel → patterns seulement) |
| `lharries/whatsapp-mcp` | 6.3k | MCP server WhatsApp — tendance 2026, utile si AfriBot se pilote par agents IA |

### 3.3 Mobile Money — librairies OFFICIELLES (Phase 2)

| Org / Repo | Lang | Pourquoi |
|---|---|---|
| `CinetPay/cinetpay-mcp` | TS | ⚠️ **Sans licence, dépôt très récent et minuscule (03/2026)** — à surveiller mais préférer seamless/js pour la prod |
| `CinetPay/cinetpay-seamless` | TS | Intégration transparente **officielle MIT** — le candidat prod TS |
| `CinetPay/cinetpay-js` | TS | Officiel |
| `CinetPay/cinetpay-go` | Go | Officiel, **zéro dépendance**, paiements **ET transferts** |
| `CinetPay/cinetpay-python` | Python | Officiel (Django/FastAPI/Flask) |
| `fedapay/fedapay-node` | TS | Officiel Node (push 07/2025 — vérifier fraîcheur avant prod) |
| `fedapay/fedapay-php` | PHP | Officiel, 22★, la plus stable |
| `fedapay/woocommerce-gateway-fedapay`, `fedapay-odoo`, `fedapay-angular/reactjs` | — | Patterns d'intégration dashboard |

### 3.4 Récap validation des licences (dorking approfondi)

| Repo | Licence | Activité (push) | Verdict |
|---|---|---|---|
| `Secreto31126/whatsapp-api-js` | MIT | 09/2026 (actif, 58 forks) | ✅ Fork recommandé |
| `david-lev/pywa` | MIT | 08/2026 | ✅ Patterns |
| `fbsamples/whatsapp-api-examples` | Meta samples (NOASSERTION) | 07/2026 | ✅ Référence conformité |
| `WhatsApp/WhatsApp-Nodejs-SDK` | NOASSERTION | **06/2023 — ARCHIVÉ** | ❌ Déprécié |
| `Forgemind-git/ForgeChat` | fair-code (NOASSERTION) | 09/2026 | ⚠️ Patterns seulement |
| `CinetPay/cinetpay-mcp` | **aucune** | 03/2026 | ⚠️ Surveiller, préférer seamless/js |
| `fedapay/fedapay-node` | MIT | 07/2025 | ✅ OK, vérifier fraîcheur |

### 3.5 À ÉVITER absolument (risque de ban)

- Userbots Baileys populaires en Afrique trouvés par le dorking : `Kingjux/Venocyber-md`, `Prince-Mendiratta/BotsApp` (5.5k★), `orkestral/venom` (6.6k★), `whatsmeow`, `whatsapp-web-reveng`
- Conforme aux NOTES TECHNIQUES : "Ne JAMAIS activer Baileys en production". À utiliser UNIQUEMENT pour lire leurs machines à états si besoin (jamais en couche réseau).

## 4. Nouvelles tâches ajoutées à la TODO (suite au dorking)

Voir la section "DORKING & FORKS" de `docs/TODO.md` :

- Combiner catalogue AfriBot + Single Product Message / Catalog API
- WhatsApp Flows natifs pour le formulaire d'adresse
- Règle de coût : jamais de template dans le flow conversationnel (gratuit en CSW), utility templates gratuits dans CSW, FEP 72h via CTWA pour les broadcasts
- Notes vocales (réception + transcription) — GAP réalités africaines
- Surveiller la politique "AI Providers" Meta (2026) pour le mode SaaS

## 5. Dorks utilisés (reproductibles)

```text
site:developers.facebook.com WhatsApp Business Platform Cloud API interactive messages flows
developers.facebook.com/docs/whatsapp/pricing            (doc pricing 2025, markdown)
developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
ai.meta.com/blog/                                        (offre Meta AI/agents)
api.github.com/search/repositories?q=whatsapp+bot&sort=stars&order=desc
api.github.com/search/repositories?q=whatsapp+cloud+api&sort=stars&order=desc
api.github.com/search/repositories?q=whatsapp+africa&sort=stars&order=desc
api.github.com/search/repositories?q=mobile+money&sort=stars&order=desc
github.com/topics/whatsapp
github.com/topics/whatsapp-cloud-api
github.com/topics/mobile-money
github.com/orgs/CinetPay/repositories
github.com/orgs/fedapay/repositories
lite.duckduckgo.com/lite/?q=...                          (CAPTCHA bot — bloqué)
```
