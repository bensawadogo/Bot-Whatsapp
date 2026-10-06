/**
 * AfriBot — conformité Meta WhatsApp Business (MODULE 5.1).
 *
 * Règles implémentées (Meta Business Messaging Policy, 2026) :
 *
 * 1. FENÊTRE DE SERVICE 24 h — après un message CLIENT, on dispose de 24 h
 *    pour lui répondre librement (gratuit). Hors fenêtre : seuls les templates
 *    pré-approuvés sont autorisés (payants). Voir `checkWindowCompliance()`.
 * 2. OPT-IN — on ne peut jamais envoyer le PREMIER message à un numéro qui ne
 *    nous a jamais écrit (hors template approuvé). Voir `enforceOptIn()`.
 * 3. CONTENU — les messages de service ne doivent pas être promotionnels
 *    (catégorie MARKETING = coût + risque de ban) ; corps limité à 1028
 *    caractères, pas de raccourcisseurs d'URL, pas de contenu sensible.
 *    Voir `checkMessageCompliance()`.
 *
 * Source de vérité : table `conversation_logs` (PostgreSQL, durable) —
 * l'historique Redis (TTL 30 min) ne suffit pas à prouver l'opt-in.
 * Un cache dérivé dans Redis (clé compliance:window:{phone}, TTL 24 h)
 * mémorise le dernier message CLIENT pour éviter une requête DB par envoi.
 */
import { logger } from '../config/logger';
import { config } from '../config/env';
import { prisma } from '../config/database';
import { redis } from '../config/redis';

// ---------------------------------------------------------------------------
// Constantes Meta
// ---------------------------------------------------------------------------

/** Longueur maximale du corps d'un message texte Cloud API (Meta, 2026). */
export const MAX_BODY_LENGTH = 1028;

/** Durée de la fenêtre de service Meta : 24 h en millisecondes. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Termes promotionnels interdits dans un message de SERVICE (non-template).
 * Une offre commerciale doit passer par un template MARKETING approuvé.
 */
export const PROMOTIONAL_TERMS: readonly string[] = [
  'offre spéciale',
  'offre speciale',
  'promotion',
  'promo',
  'réduction',
  'reduction',
  '-50%',
  'remise exceptionnelle',
  'solde',
  'gratuit pour tous',
  'profitez vite',
  'dernière chance',
  'derniere chance',
  'abonnez-vous',
  'achetez maintenant',
  'nouveauté exclusive',
];

/** Thèmes sensibles qui déclenchent une revue/ban Meta. */
export const SENSITIVE_TERMS: readonly string[] = [
  'sexe',
  'pornograph',
  'érotique',
  'erotique',
  'préservatif',
  'preservatif',
  'élection',
  'election',
  'candidat',
  'votez',
  'parti politique',
  'église',
  'eglise',
  'mosquée',
  'mosquee',
  'conversion religieuse',
];

/** Domaines de raccourcisseurs d'URL bloqués par Meta. */
const URL_SHORTENERS: readonly string[] = [
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'is.gd',
  'cutt.ly',
  'rebrand.ly',
  'shorturl.at',
  'ow.ly',
  'rb.gy',
];
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Résultat de `checkMessageCompliance()`. */
export interface ComplianceResult {
  valid: boolean;
  /** Motif du refus (affiché dans les logs + renvoyé à l'API). */
  reason?: string;
  /** Reformulation proposée pour rendre le message conforme. */
  suggestion?: string;
}

/** Statut de la fenêtre de service 24 h de Meta. */
export type WindowStatusValue = 'IN_WINDOW' | 'OUT_WINDOW';

/** Résultat de `checkWindowCompliance()`. */
export interface WindowStatus {
  status: WindowStatusValue;
  /** Millisecondes restantes avant fermeture (0 si déjà fermée). */
  remainingMs: number;
  /** Dernier message entrant connu du client (null si jamais écrit). */
  lastInboundAt: Date | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Numéro WhatsApp normalisé (sans « + », ni suffixe @s.whatsapp.net). */
export function normalize(phone: string): string {
  return phone
    .trim()
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/[^\d]/g, '');
}

/** Le numéro est-il le commerçant (destinataire interne, dispensé d'opt-in) ? */
export function isInternalRecipient(phone: string): boolean {
  const normalized = normalize(phone);
  return Boolean(config.merchant.phone) && normalize(config.merchant.phone ?? '') === normalized;
}

/**
 * Clé Redis du cache de la fenêtre 24 h (timestamp du dernier message CLIENT).
 * Cache dérivé de `conversation_logs` : lis d'abord Redis, ne requête la
 * base que sur un miss.
 */
function redisWindowKey(phone: string): string {
  return `${config.redis.prefix}compliance:window:${phone}`;
}

/** TTL du cache fenêtre (24 h) — aligné sur la fenêtre Meta. */
const WINDOW_CACHE_TTL_SECONDS = Math.floor(SERVICE_WINDOW_MS / 1000);

/**
 * Lit le timestamp (ms) du dernier entrant depuis le cache. null = miss
 * (à re-vérifier en base). Lève une erreur si Redis est indisponible.
 */
async function readCachedInbound(phone: string): Promise<number | null> {
  const raw = await redis.get(redisWindowKey(phone));
  if (raw === null) return null;
  const timestamp = Number(raw);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return timestamp;
}

/** Écrit le timestamp en cache (best-effort : ne doit jamais casser l'envoi). */
async function writeCachedInbound(phone: string, timestampMs: number): Promise<void> {
  try {
    await redis.set(redisWindowKey(phone), String(timestampMs), 'EX', WINDOW_CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn(`Cache fenêtre non écrit (${phone}) : ${String(err)}`);
  }
}

/** Construit le WindowStatus depuis le dernier entrant (ms). */
function windowStatusFromInbound(timestampMs: number, now: Date): WindowStatus {
  const elapsed = now.getTime() - timestampMs;
  const remainingMs = SERVICE_WINDOW_MS - elapsed;
  return {
    status: remainingMs > 0 ? 'IN_WINDOW' : 'OUT_WINDOW',
    remainingMs: Math.max(0, remainingMs),
    lastInboundAt: new Date(timestampMs),
  };
}

// ---------------------------------------------------------------------------
// 1. checkMessageCompliance — validation du contenu
// ---------------------------------------------------------------------------

/**
 * Vérifie qu'un message respecte les règles de contenu Meta.
 *
 * @param message Texte du message (corps).
 * @param type    'template' = message pré-approuvé (promotion autorisée),
 *                tout le reste = message de service (promotion interdite).
 */
export function checkMessageCompliance(message: string, type: string): ComplianceResult {
  const isTemplate = type === 'template';
  const lower = message.toLowerCase();

  // 1) Message vide (Meta refuse un corps vide)
  if (message.trim().length === 0) {
    return { valid: false, reason: 'Message vide' };
  }

  // 2) Longueur maximale du corps
  if (message.length > MAX_BODY_LENGTH) {
    return {
      valid: false,
      reason: `Message trop long (${message.length} caractères, maximum ${MAX_BODY_LENGTH})`,
      suggestion: `${message.slice(0, MAX_BODY_LENGTH - 3)}...`,
    };
  }

  // 3) Raccourcisseurs d'URL (phishing / spam — bloqués par Meta)
  const shortener = URL_SHORTENERS.find((domain) => lower.includes(domain));
  if (shortener) {
    return {
      valid: false,
      reason: `URL raccourcie détectée (${shortener}) — Meta bloque les raccourcisseurs`,
      suggestion: 'Utilisez le lien complet (https://...) dans le message.',
    };
  }

  // 4) Contenu sensible (sexuel, politique, religieux) — jamais autorisé
  const sensitive = SENSITIVE_TERMS.find((term) => lower.includes(term));
  if (sensitive) {
    return {
      valid: false,
      reason: `Contenu sensible détecté (« ${sensitive} ») — interdit par la politique Meta`,
      suggestion: 'Reformulez le message sans référence sexuelle, politique ou religieuse.',
    };
  }

  // 5) Promotion dans un message de service (hors template approuvé)
  if (!isTemplate) {
    const promo = PROMOTIONAL_TERMS.find((term) => lower.includes(term));
    if (promo) {
      return {
        valid: false,
        reason: `Terme promotionnel « ${promo} » dans un message de service — utilisez un template MARKETING`,
        suggestion: 'Retirez le terme promotionnel ou passez par un template approuvé par Meta.',
      };
    }
  }

  return { valid: true };
}
// ---------------------------------------------------------------------------
// 2. enforceOptIn — le client nous a-t-il écrit en premier ?
// ---------------------------------------------------------------------------

/**
 * Vérifie dans `conversation_logs` que le client a déjà initié la
 * conversation. Sans opt-in, l'envoi doit être bloqué (sauf template
 * pré-approuvé).
 *
 * @returns true si le client nous a déjà écrit au moins une fois.
 */
export async function enforceOptIn(customerPhone: string): Promise<boolean> {
  const phone = normalize(customerPhone);
  try {
    const cached = await readCachedInbound(phone);
    if (cached !== null) return true;

    const firstInbound = await prisma.conversationLog.findFirst({
      where: { phone, fromMe: false },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!firstInbound) {
      logger.warn(`Conformité Meta : envoi bloqué — aucun opt-in de ${phone}`);
      return false;
    }
    // Opt-in prouvé : on alimente le cache si le message est dans la fenêtre
    if (Date.now() - firstInbound.createdAt.getTime() < SERVICE_WINDOW_MS) {
      void writeCachedInbound(phone, firstInbound.createdAt.getTime());
    }
    return true;
  } catch (err) {
    // Base/Redis indisponible : on refuse par défaut (fail-safe anti-ban)
    logger.error(`enforceOptIn(${phone}) : ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 3. checkWindowCompliance — fenêtre de service 24 h
// ---------------------------------------------------------------------------

/**
 * Calcule le statut de la fenêtre de 24 h depuis le DERNIER message CLIENT
 * (nos propres réponses ne rouvrent pas la fenêtre — règle Meta).
 *
 * @param now Injectable pour les tests.
 */
export async function checkWindowCompliance(
  customerPhone: string,
  now: Date = new Date(),
): Promise<WindowStatus> {
  const phone = normalize(customerPhone);
  try {
    const cached = await readCachedInbound(phone);
    if (cached !== null) {
      return windowStatusFromInbound(cached, now);
    }

    const lastInbound = await prisma.conversationLog.findFirst({
      where: { phone, fromMe: false },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (!lastInbound) {
      // Jamais écrit → hors fenêtre (et pas d'opt-in non plus)
      return { status: 'OUT_WINDOW', remainingMs: 0, lastInboundAt: null };
    }
    if (now.getTime() - lastInbound.createdAt.getTime() < SERVICE_WINDOW_MS) {
      void writeCachedInbound(phone, lastInbound.createdAt.getTime());
    }
    return windowStatusFromInbound(lastInbound.createdAt.getTime(), now);
  } catch (err) {
    logger.error(`checkWindowCompliance(${phone}) : ${String(err)}`);
    // Base/Redis indisponible : on considère la fenêtre FERMÉE (fail-safe anti-ban)
    return { status: 'OUT_WINDOW', remainingMs: 0, lastInboundAt: null };
  }
}

// ---------------------------------------------------------------------------
// 4. logConversation — journal durable (audit + alimente les règles 2 & 3)
// ---------------------------------------------------------------------------

/** Entrée du journal de conversation (un message entrant ou sortant). */
export interface ConversationLogInput {
  phone: string;
  /** true = message du bot/commerçant, false = message du client. */
  fromMe: boolean;
  text: string;
  type: string;
  /** true lorsque le message a été bloqué par un garde-fou. */
  blocked?: boolean | undefined;
  blockReason?: string | undefined;
}

/**
 * Enregistre un message dans `conversation_logs` — c'est CE journal qui
 * ouvre la fenêtre de 24 h (messages entrants) et prouve l'opt-in.
 *
 * Volontairement « fire-and-forget » côté appelant : un échec de journal
 * ne doit jamais casser un envoi WhatsApp ni une réponse webhook.
 * Le texte est tronqué (2000 caractères) pour rester léger sur 2G/3G.
 */
export async function logConversation(input: ConversationLogInput): Promise<void> {
  const phone = normalize(input.phone);
  if (!phone) return;
  try {
    await prisma.conversationLog.create({
      data: {
        phone,
        fromMe: input.fromMe,
        text: (input.text ?? "").slice(0, 2000),
        type: input.type,
        blocked: input.blocked ?? false,
        blockReason: input.blockReason ?? null,
      },
    });
    // Message CLIENT : ouvre la fenêtre de 24 h → on alimente le cache
    if (input.fromMe === false) {
      void writeCachedInbound(phone, Date.now());
    }
  } catch (err) {
    logger.warn(`Journal de conversation non enregistré (${phone}) : ${String(err)}`);
  }
}

/**
 * Dernier message ENTRANT connu d'un client (conversation_logs).
 * Utilisé par le webhook et par les tests de conformité.
 */
export async function getLastInboundAt(customerPhone: string): Promise<Date | null> {
  const phone = normalize(customerPhone);
  try {
    const cached = await readCachedInbound(phone);
    if (cached !== null) return new Date(cached);

    const row = await prisma.conversationLog.findFirst({
      where: { phone, fromMe: false },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (row && Date.now() - row.createdAt.getTime() < SERVICE_WINDOW_MS) {
      void writeCachedInbound(phone, row.createdAt.getTime());
    }
    return row?.createdAt ?? null;
  } catch (err) {
    logger.warn(`getLastInboundAt(${phone}) : ${String(err)}`);
    return null;
  }
}
// ---------------------------------------------------------------------------
// Fin du module — la journalisation durable `logConversation` est définie
// ci-dessus (section 4) afin d'être utilisée par enforceOptIn/checkWindow.
// ---------------------------------------------------------------------------