# Configuration — AfriBot

Ce fichier est la référence complète des variables d'environnement du projet AfriBot. Il permet de configurer le projet de zéro, que ce soit en développement ou en production.

## Comment utiliser ce fichier

1. Copier `.env.example` vers `.env`
2. Remplir chaque variable selon ce guide
3. Ne JAMAIS commiter le fichier `.env`
4. Utiliser `.env.example` pour documenter les nouvelles variables

## Section 1 — Evolution API (CRITIQUE)

### Variables obligatoires pour le mode Cloud API Meta

| Variable | Exemple | Description |
|---|---|---|
| `EVOLUTION_API_URL` | `http://localhost:8080` | URL de l'instance Evolution API |
| `EVOLUTION_API_KEY` | `mon-secret-api-key` | Clé d'authentification Evolution API |
| `EVOLUTION_INSTANCE_NAME` | `afribot-prod` | Nom de l'instance WhatsApp |
| `INTEGRATION` | `WHATSAPP-BUSINESS` | Mode connexion (TOUJOURS cette valeur) |
| `WA_BUSINESS_TOKEN_WEBHOOK` | `evolution` | Token de validation webhook Meta |
| `WA_BUSINESS_URL` | `https://graph.facebook.com` | URL API Graph Meta |
| `WA_BUSINESS_VERSION` | `v20.0` | Version API Graph Meta |

> ⚠️ **AVERTISSEMENT CRITIQUE**
>
> - `INTEGRATION=WHATSAPP-BAILEYS` = **risque de bannissement définitif du numéro**. Cette valeur est interdite en production et expose le numéro du commerçant à une suspension sans recours auprès de Meta.
> - `INTEGRATION=WHATSAPP-BUSINESS` = **seule option autorisée en production**. Cette valeur force la connexion via la Cloud API Meta officielle, contractuelle et stable.

## Section 2 — Meta Cloud API (Facebook Developer)

| Variable | Exemple | Description |
|---|---|---|
| `META_PHONE_NUMBER_ID` | `123456789` | ID du numéro WhatsApp Business |
| `META_WHATSAPP_BUSINESS_ACCOUNT_ID` | `987654321` | ID du compte WhatsApp Business |
| `META_ACCESS_TOKEN` | `EAABwzL...` | Token d'accès permanent Meta |
| `META_WEBHOOK_VERIFY_TOKEN` | `mon-token-secret` | Token de vérification du webhook |

### Comment obtenir ces valeurs

Guide étape par étape :

1. Créer une application sur [developers.facebook.com](https://developers.facebook.com) (type Business).
2. Ajouter le produit "WhatsApp Business" à l'application.
3. Récupérer le **Phone Number ID** dans le panneau WhatsApp Business de l'application.
4. Générer un **token d'accès permanent** via un System User du compte Meta Business (profil avec permission `whatsapp_business_messaging`).
5. Configurer le **webhook** dans l'application Meta avec l'URL publique d'Evolution API et le token de vérification (`META_WEBHOOK_VERIFY_TOKEN`).

## Section 3 — Base de données PostgreSQL

| Variable | Exemple | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://afribot_user:supersecret@localhost:5432/afribot` | URL complète de connexion (utilisée par Prisma) |
| `DB_HOST` | `localhost` | Hôte PostgreSQL |
| `DB_PORT` | `5432` | Port PostgreSQL |
| `DB_NAME` | `afribot` | Nom de la base de données |
| `DB_USER` | `afribot_user` | Utilisateur de la base |
| `DB_PASSWORD` | `supersecret` | Mot de passe de la base |

> 💡 **Note** : `DATABASE_URL` doit être cohérente avec `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` et `DB_PASSWORD`. En Docker Compose, utiliser le nom du service (ex. `postgres`) comme hôte.

> ⚠️ Le script `scripts/init-db.sh` crée automatiquement la base `chatwoot_db` au premier démarrage (monté dans `/docker-entrypoint-initdb.d/`). Ne pas supprimer ce fichier. Le script ne s'exécute que si le volume `postgres_data` est vide : si le volume existe déjà, créer la base à la main avec `docker compose exec postgres createdb -U $POSTGRES_USER chatwoot_db`.

## Section 4 — Redis (Sessions)

| Variable | Exemple | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | URL de connexion Redis |
| `REDIS_PASSWORD` | `changeme` | Mot de passe Redis (authentification) |
| `REDIS_PREFIX` | `afribot:` | Préfixe appliqué à toutes les clés Redis |
| `SESSION_TTL` | `1800` | Durée de vie des sessions (secondes, soit 30 minutes) |

## Section 5 — Paiements Mobile Money

### CinetPay

> ⚠️ **Intégration CinetPay** : le SDK npm officiel CinetPay n'est pas disponible sur le registre npm (404 confirmé le 2026-09-07). L'intégration utilise des **appels HTTP directs** à l'API CinetPay v2 (`https://api-checkout.cinetpay.com/v2`) via axios. Aucune dépendance externe supplémentaire nécessaire.

| Variable | Exemple | Description |
|---|---|---|
| `CINETPAY_SITE_ID` | `123456` | Identifiant du site CinetPay |
| `CINETPAY_API_KEY` | `cle-api-cinetpay` | Clé API CinetPay |
| `CINETPAY_NOTIFY_URL` | `https://tonbot.com/webhook/payment` | URL de callback appelée après paiement |
| `CINETPAY_CURRENCY` | `XOF` | Devise des paiements (XOF pour le FCFA) |

#### Exemple d'appel HTTP — création d'un paiement

**Endpoint** : `POST https://api-checkout.cinetpay.com/v2/payment`

**Headers** : `Content-Type: application/json`

**Body** :

```json
{
  "apikey": "CINETPAY_API_KEY",
  "site_id": "CINETPAY_SITE_ID",
  "transaction_id": "uuid-unique",
  "amount": 5000,
  "currency": "XOF",
  "description": "Commande #123 — AfriBot",
  "notify_url": "https://tondomaine.com/webhook/payment/cinetpay",
  "return_url": "https://tondomaine.com/commande/succes",
  "customer_name": "Nom Client",
  "customer_surname": "Prénom",
  "customer_phone_number": "+22600000000",
  "customer_email": "client@email.com",
  "customer_address": "Ouagadougou, Burkina Faso",
  "customer_city": "Ouagadougou",
  "customer_country": "BF",
  "customer_state": "BF",
  "customer_zip_code": "00000",
  "channels": "ALL",
  "lang": "fr"
}
```

### FedaPay (alternative)

| Variable | Exemple | Description |
|---|---|---|
| `FEDAPAY_SECRET_KEY` | `sk_live_xxx` | Clé secrète FedaPay |
| `FEDAPAY_PUBLIC_KEY` | `pk_live_xxx` | Clé publique FedaPay |
| `FEDAPAY_ENVIRONMENT` | `live` | Environnement d'appel (`sandbox` ou `live`) |

## Section 6 — Chatwoot (Support Humain)

| Variable | Exemple | Description |
|---|---|---|
| `CHATWOOT_URL` | `http://localhost:3000` | URL de l'instance Chatwoot |
| `CHATWOOT_API_KEY` | `chatwoot-api-key` | Clé API Chatwoot (créée dans le profil admin) |
| `CHATWOOT_INBOX_ID` | `1` | ID de la boîte de réception WhatsApp connectée |
| `CHATWOOT_ACCOUNT_ID` | `1` | ID du compte Chatwoot |

## Section 7 — Application AfriBot

| Variable | Exemple | Description |
|---|---|---|
| `NODE_ENV` | `production` | Environnement d'exécution (`development` ou `production`) |
| `PORT` | `3001` | Port d'écoute de l'application AfriBot |
| `APP_URL` | `https://tonbot.com` | URL publique de l'application |
| `LOG_LEVEL` | `info` | Niveau de log (`debug`, `info`, `warn`, `error`) |
| `ESCALATION_MAX_ATTEMPTS` | `3` | Nombre de tentatives du bot avant escalade vers un humain |
| `SESSION_TTL` | `1800` | Durée de vie des sessions conversationnelles (secondes) |
| `IMAGE_MAX_SIZE_KB` | `100` | Taille maximale des images catalogue en Ko (optimisation 2G/3G) |

## Section 8 — n8n (Automatisations)

| Variable | Exemple | Description |
|---|---|---|
| `N8N_URL` | `http://localhost:5678` | URL de l'instance n8n |
| `N8N_API_KEY` | `n8n-api-key` | Clé API n8n (créée dans les paramètres n8n) |

## Environnements

Le projet utilise trois fichiers d'environnement distincts. Un seul fichier est chargé à la fois, selon la valeur de `NODE_ENV` ou la commande utilisée.

| Fichier | Usage | Particularités |
|---|---|---|
| `.env.development` | Développement local | Valeurs de test, CinetPay en `sandbox`, logs en `debug`, connexion à la Cloud API Meta en mode test |
| `.env.production` | Serveur de production | Secrets réels et uniques, `NODE_ENV=production`, logs en `info`, URLs publiques HTTPS |
| `.env.test` | Exécution des tests automatisés | Base de données et Redis isolés, aucun appel réseau réel vers Meta ou les opérateurs de paiement |

Bonnes pratiques d'utilisation :

1. Ne jamais partager de valeurs entre `.env.development` et `.env.production` : chaque environnement possède ses propres clés et secrets.
2. Sélectionner le fichier via la variable `NODE_ENV` (ou via l'option de chargement de la librairie de configuration, ex. `--env-file`).
3. Mettre à jour `.env.example` à chaque ajout d'une nouvelle variable, avec un exemple réaliste et une description.
4. Ne jamais commiter les fichiers `.env*` réels : seul `.env.example` est versionné dans Git.

## Sécurité

Checklist à valider avant toute mise en production :

- [ ] `.env` est présent dans `.gitignore`
- [ ] Tokens Meta régénérés spécifiquement pour la production (jamais de token de développement)
- [ ] Mot de passe PostgreSQL fort (> 20 caractères)
- [ ] `EVOLUTION_API_KEY` différente en production et en développement
- [ ] Webhook verify token aléatoire et secret (`META_WEBHOOK_VERIFY_TOKEN`)
- [ ] Toutes les URLs de webhook en HTTPS avec certificat SSL valide
- [ ] Clés CinetPay/FedaPay en mode `live` uniquement après validation des tests `sandbox`
- [ ] Accès Redis et PostgreSQL restreint au réseau interne Docker (aucun port exposé publiquement)

> ⚠️ **AVERTISSEMENT CRITIQUE**
>
> Une fuite de `.env` expose les paiements, la base clients et le numéro WhatsApp Business du commerçant. En cas de doute sur une compromission : révoquer immédiatement le token Meta, régénérer toutes les clés API et rotater les mots de passe de base de données.



