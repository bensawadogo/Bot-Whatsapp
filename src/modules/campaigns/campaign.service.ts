/**
 * AfriBot — service campagnes : pub ciblées CTWA + Broadcast (MODULE CAMPAGNES).
 *
 * RÈGLE META 1 : N'envoyer QU'à des contacts qui ont écrit en premier
 *   (direction = 'IN' → fromMe = false dans ConversationLog).
 * RÈGLE META 2 : Utiliser uniquement des templates approuvés hors de la
 *   fenêtre de 24 h après le dernier message client.
 * RÈGLE META 3 : Respecter le rate limiting du tier actuel
 *   (Tier 0: 250/j | Tier 1: 1000/j | Tier 2: 10k/j).
 * RÈGLE META 4 : Surveiller le blockRate — si > 2 % → pause automatique.
 * RÈGLE META 5 : Ne JAMAIS acheter ou scraper des listes. Seuls les contacts
 *   organiques opt-in sont autorisés.
 */
import axios from 'axios';
import type { Prisma } from '@prisma/client';

import { prisma } from '../../config/database';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { SINGLE_TENANT_MERCHANT_ID } from '../../shared/tenant';
import { TEMPLATES, renderTemplate, type TemplateKey } from '../../shared/templates';
import { messageSender } from '../../shared/sender';
import type {
  Campaign,
  CampaignListItem,
  CTWAWebhook,
  CreateCampaignDto,
  MessageStatusWebhook,
  QualityCheck,
  QualityRating,
  SendResult,
  MessagingTier,
} from './campaign.types';

/** Pause entre deux envois (ms) — évite les « spikes » de débit (2 s). */
const SEND_PAUSE_MS = 2_000;

/** Limite d'envois par tier Meta (RÈGLE META 3). */
const TIER_LIMITS: Record<MessagingTier, { daily: number; hourly: number }> = {
  TIER_0: { daily: 250, hourly: 10 },
  TIER_1: { daily: 1000, hourly: 40 },
  TIER_2: { daily: 10000, hourly: 400 },
};

/** Taux de blocage (%) au-delà duquel la campagne est pausée automatiquement. */
function maxBlockRate(): number {
  return config.campaigns.maxBlockRate;
}

/** Score qualité → tier de messagerie (approximation conservative). */
export function tierFromRating(rating: QualityRating): MessagingTier {
  return rating === 'RED' ? 'TIER_0' : 'TIER_1';
}

/** Numéro normalisé (chiffres uniquement — convention du projet). */
function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, '');
}

/** Reconvertisseur row Prisma → vue applicative Campaign. */
function toCampaign(row: Prisma.CampaignGetPayload<Record<string, never>>): Campaign {
  return {
    id: row.id,
    merchantId: row.merchantId,
    name: row.name,
    type: row.type as Campaign['type'],
    status: row.status as Campaign['status'],
    templateKey: row.templateKey,
    templateParams: row.templateParams,
    targetSegment: row.targetSegment as Campaign['targetSegment'],
    scheduledAt: row.scheduledAt,
    sentAt: row.sentAt,
    totalTargeted: row.totalTargeted,
    totalSent: row.totalSent,
    totalDelivered: row.totalDelivered,
    totalRead: row.totalRead,
    totalReplied: row.totalReplied,
    totalOrders: row.totalOrders,
    revenueGenerated: row.revenueGenerated,
    qualityScore: row.qualityScore as Campaign['qualityScore'],
    blockRate: row.blockRate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Ciblage — getEligibleContacts (RÈGLE META 1 : opt-in strict)
// ---------------------------------------------------------------------------

/**
 * Numéros ÉLIGIBLES à une campagne selon le segment.
 * RÈGLE META 1 : un contact n'est éligible QUE s'il nous a écrit au moins une
 * fois (ConversationLog.fromMe = false). Segments :
 *  - ACTIVE_30 : ont écrit dans les 30 derniers jours ;
 *  - ACTIVE_90 : dans les 90 derniers jours ;
 *  - DORMANT   : plus de 90 jours sans contact (relance) ;
 *  - NEW       : opt-in n'ayant JAMAIS commandé ;
 *  - ALL       : tous les contacts opt-in.
 */
export async function getEligibleContacts(merchantId: string, segment: string): Promise<string[]> {
  void merchantId;
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const optInWhere: Prisma.ConversationLogWhereInput = { fromMe: false };
  switch (segment) {
    case 'ACTIVE_30':
      optInWhere.createdAt = { gte: thirtyDaysAgo };
      break;
    case 'ACTIVE_90':
      optInWhere.createdAt = { gte: ninetyDaysAgo };
      break;
    case 'DORMANT':
      optInWhere.createdAt = { lt: ninetyDaysAgo };
      break;
    default:
      break;
  }

  const grouped = await prisma.conversationLog.groupBy({
    by: ['phone'],
    where: optInWhere,
    _max: { createdAt: true },
  });

  let phones = grouped
    .filter((g) => g._max.createdAt !== null)
    .map((g) => normalizePhone(g.phone))
    .filter((phone) => phone.length >= 8);

  if (segment === 'NEW') {
    const ordered = await prisma.order.findMany({
      select: { phoneNumber: true },
      distinct: ['phoneNumber'],
    });
    const orderedSet = new Set(ordered.map((o) => normalizePhone(o.phoneNumber)));
    phones = phones.filter((phone) => !orderedSet.has(phone));
  }

  logger.debug(`getEligibleContacts(${segment}) → ${phones.length} contacts opt-in`);
  return phones;
}

// ---------------------------------------------------------------------------
// Qualité — checkQualityBeforeSend (RÈGLES META 3 & 4)
// ---------------------------------------------------------------------------

/**
 * Vérifie le score qualité Meta du numéro avant tout envoi :
 * GET graph.facebook.com/v20.0/{phoneNumberId}?fields=quality_rating
 * Sans identifiants Meta (déploiement Evolution API seul) → GREEN conservateur ;
 * tout blocage observé pendant l'envoi (RÈGLE META 4) mettra la campagne en pause.
 */
export async function checkQualityBeforeSend(merchantId: string): Promise<QualityCheck> {
  void merchantId;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  let rating: QualityRating = 'GREEN';

  if (phoneNumberId && accessToken) {
    try {
      const response = await axios.get<{ quality_rating?: QualityRating }>(
        `${config.evolution.waBusinessUrl}/${config.evolution.waBusinessVersion}/${phoneNumberId}`,
        { params: { fields: 'quality_rating', access_token: accessToken }, timeout: 10_000 },
      );
      if (response.data.quality_rating === 'RED' || response.data.quality_rating === 'YELLOW') {
        rating = response.data.quality_rating;
      }
    } catch (err) {
      logger.warn(`Score qualité Meta indisponible (prudence : traité comme JAUNE) : ${String(err)}`);
      rating = 'YELLOW';
    }
  }

  const tier = tierFromRating(rating);
  const limits = TIER_LIMITS[tier];
  const configuredHourly = config.campaigns.rateLimitPerHour || limits.hourly;
  const hourlyLimit = Math.min(limits.hourly, configuredHourly);

  if (rating === 'RED') {
    return {
      rating,
      allowed: false,
      reason:
        'Score qualité ROUGE : campagnes bloquées. Améliorez la qualité de vos messages (lecture/réponse) avant de réessayer.',
      tier,
      dailyLimit: limits.daily,
      hourlyLimit: 0,
    };
  }

  if (rating === 'YELLOW' && config.campaigns.pauseOnYellow) {
    return {
      rating,
      allowed: false,
      reason: 'Score JAUNE et CAMPAIGN_PAUSE_ON_YELLOW=true : envoi refusé. Ciblez vos clients actifs.',
      tier,
      dailyLimit: limits.daily,
      hourlyLimit,
    };
  }

  return {
    rating,
    allowed: true,
    reason: rating === 'YELLOW' ? 'Score JAUNE : envoi limité à 100 contacts cette heure.' : null,
    tier,
    dailyLimit: limits.daily,
    hourlyLimit: rating === 'YELLOW' ? Math.min(hourlyLimit, 100) : hourlyLimit,
  };
}

// ---------------------------------------------------------------------------
// Cycle de vie — création, pause, historique
// ---------------------------------------------------------------------------

/** Liste toutes les campagnes (dashboard) avec taux et ROI. */
export async function listCampaigns(merchantId: string): Promise<CampaignListItem[]> {
  const rows = await prisma.campaign.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => {
    const c = toCampaign(row);
    return {
      ...c,
      readRate: c.totalSent > 0 ? Math.round((c.totalRead / c.totalSent) * 100) : 0,
      replyRate: c.totalSent > 0 ? Math.round((c.totalReplied / c.totalSent) * 100) : 0,
      roiPerSent: c.totalSent > 0 ? Math.round(c.revenueGenerated / c.totalSent) : 0,
    };
  });
}

/** Crée une campagne DRAFT (template validé + volume cible calculé). */
export async function createCampaign(merchantId: string, dto: CreateCampaignDto): Promise<Campaign | null> {
  if (!(dto.templateKey in TEMPLATES)) return null;

  const contacts = await getEligibleContacts(merchantId, dto.targetSegment);
  const row = await prisma.campaign.create({
    data: {
      merchantId,
      name: dto.name,
      type: dto.type,
      status: 'DRAFT',
      templateKey: dto.templateKey,
      templateParams: dto.templateParams ?? '{}',
      targetSegment: dto.targetSegment,
      scheduledAt: dto.scheduledAt ?? null,
      totalTargeted: contacts.length,
    },
  });
  logger.info(`Campagne « ${row.name} » créée (${contacts.length} contacts ciblés)`);
  return toCampaign(row);
}

/** Met en pause une campagne active (manuellement ou par garde-fou anti-ban). */
export async function pauseCampaign(id: string, reason: string): Promise<Campaign | null> {
  const existing = await prisma.campaign.findUnique({ where: { id } });
  if (!existing) return null;
  const row = await prisma.campaign.update({ where: { id }, data: { status: 'PAUSED' } });
  logger.warn(`Campagne « ${row.name} » en pause : ${reason}`);
  return toCampaign(row);
}

/** Marque une campagne terminée (tous les envois traités). */
async function completeCampaign(id: string): Promise<void> {
  await prisma.campaign.update({ where: { id }, data: { status: 'COMPLETED' } });
}

// ---------------------------------------------------------------------------
// Envoi — sendCampaign (RÈGLES META 2, 3 & 4)
// ---------------------------------------------------------------------------

/** Lit les variables du template depuis le JSON stocké. */
function parseTemplateParams(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Lance l'envoi d'une campagne :
 * 1. contacts éligibles (opt-in STRICT — RÈGLE 1) ;
 * 2. score qualité Meta (RÈGLE 3) ;
 * 3. rate limiting par tier + pause 2 s entre chaque message ;
 * 4. blockRate > seuil (2 %) → PAUSE automatique (RÈGLE 4) ;
 * 5. chaque envoi journalisé dans CampaignContact (traçabilité).
 */
export async function sendCampaign(campaignId: string): Promise<SendResult | null> {
  const row = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!row) return null;
  const campaign = toCampaign(row);

  if (campaign.status === 'PAUSED' || campaign.status === 'COMPLETED') {
    return { sent: 0, blocked: 0, paused: false, reason: `Campagne déjà ${campaign.status}` };
  }

  const quality = await checkQualityBeforeSend(campaign.merchantId);
  if (!quality.allowed) {
    await pauseCampaign(campaignId, quality.reason ?? 'score qualité insuffisant');
    return { sent: 0, blocked: 0, paused: true, reason: quality.reason };
  }

  const contacts = await getEligibleContacts(campaign.merchantId, campaign.targetSegment);
  if (contacts.length === 0) {
    return { sent: 0, blocked: 0, paused: false, reason: 'Aucun contact éligible pour ce segment' };
  }

  // Lignes de tracking (PENDING) — idempotent par (campagne, numéro).
  await prisma.campaignContact.createMany({
    data: contacts.map((phone) => ({ campaignId, phoneNumber: phone })),
    skipDuplicates: true,
  });

  const body = renderTemplate(campaign.templateKey as TemplateKey, parseTemplateParams(campaign.templateParams));
  if (!body) {
    return { sent: 0, blocked: 0, paused: false, reason: 'Template introuvable ou vide' };
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'ACTIVE', sentAt: new Date(), qualityScore: quality.rating },
  });

  // RÈGLE META 3 : fenêtre horaire selon le tier (10 / 40 / 400 par heure).
  const targets = contacts.slice(0, quality.hourlyLimit);
  let sent = 0;
  let blocked = 0;

  for (const phone of targets) {
    // RÈGLE META 4 : blockRate > seuil → pause immédiate + alerte.
    const attempts = sent + blocked;
    if (attempts > 0 && attempts % 10 === 0) {
      const rate = (blocked / attempts) * 100;
      if (rate > maxBlockRate()) {
        await pauseCampaign(
          campaignId,
          `${rate.toFixed(1)} % de blocage (seuil ${maxBlockRate()} %) — pause automatique`,
        );
        return { sent, blocked, paused: true, reason: `BlockRate ${rate.toFixed(1)} %` };
      }
    }

    try {
      await messageSender.sendTextTemplate(phone, body);
      await prisma.campaignContact.update({
        where: { campaignId_phoneNumber: { campaignId, phoneNumber: phone } },
        data: { status: 'SENT', sentAt: new Date() },
      });
      sent += 1;
      await prisma.campaign.update({ where: { id: campaignId }, data: { totalSent: { increment: 1 } } });
    } catch (err) {
      blocked += 1;
      logger.warn(`Envoi campagne impossible vers ${phone} : ${String(err)}`);
      await prisma.campaignContact.update({
        where: { campaignId_phoneNumber: { campaignId, phoneNumber: phone } },
        data: { status: 'BLOCKED' },
      });
    }

    // Pause 2 s entre chaque message — pas de spike de débit.
    await new Promise((resolve) => setTimeout(resolve, SEND_PAUSE_MS));
  }

  const blockRate = sent + blocked > 0 ? (blocked / (sent + blocked)) * 100 : 0;
  await prisma.campaign.update({ where: { id: campaignId }, data: { blockRate } });
  if (sent + blocked >= contacts.length) await completeCampaign(campaignId);

  logger.info(`Campagne « ${campaign.name} » : ${sent} envoyés, ${blocked} bloqués`);
  return { sent, blocked, paused: false, reason: quality.reason };
}

// ---------------------------------------------------------------------------
// Webhook CTWA — arrivée d'un client depuis une pub Meta
// ---------------------------------------------------------------------------

/**
 * Traite l'arrivée d'un client via une pub Facebook/Instagram (CTWA) :
 * marque le contact de la campagne la plus récente (ctwaClid, isFromCtwa)
 * puis envoie le flow d'accueil CTWA personnalisé. La fenêtre de service 24 h
 * est ouverte par Meta (le client a initié la conversation via la pub).
 */
export async function handleCTWAWebhook(payload: CTWAWebhook): Promise<void> {
  const phone = normalizePhone(payload.phoneNumber);
  if (!phone) return;

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const contact = await prisma.campaignContact.findFirst({
    where: { phoneNumber: phone, sentAt: { gte: since } },
    orderBy: { sentAt: 'desc' },
  });

  if (contact) {
    await prisma.campaignContact.update({
      where: { id: contact.id },
      data: {
        isFromCtwa: true,
        ...(payload.ctwaClid !== undefined && { ctwaClid: payload.ctwaClid }),
        status: 'REPLIED',
        repliedAt: new Date(),
      },
    });
    await prisma.campaign.update({
      where: { id: contact.campaignId },
      data: { totalReplied: { increment: 1 } },
    });
  }

  const welcome = [
    '👋 Bonjour ! J’ai vu que vous avez cliqué sur notre pub.',
    'Je suis là pour vous aider ! 😊',
    '',
    'Tapez *1* pour voir nos produits',
    'Tapez *2* pour poser une question',
  ].join('\n');

  try {
    await messageSender.sendText(phone, welcome);
  } catch (err) {
    logger.warn(`Message d'accueil CTWA non envoyé à ${phone} : ${String(err)}`);
  }
}

/** Webhook Meta de statut : met à jour les compteurs livraison/lecture. */
export async function handleStatusWebhook(payload: MessageStatusWebhook): Promise<void> {
  const phone = normalizePhone(payload.phoneNumber);
  const where = { campaignId_phoneNumber: { campaignId: payload.campaignId, phoneNumber: phone } };

  switch (payload.status) {
    case 'DELIVERED':
      await prisma.campaignContact.update({ where, data: { status: 'DELIVERED', deliveredAt: new Date() } });
      await prisma.campaign.update({ where: { id: payload.campaignId }, data: { totalDelivered: { increment: 1 } } });
      break;
    case 'READ':
      await prisma.campaignContact.update({ where, data: { status: 'READ', readAt: new Date() } });
      await prisma.campaign.update({ where: { id: payload.campaignId }, data: { totalRead: { increment: 1 } } });
      break;
    case 'BLOCKED':
      await prisma.campaignContact.update({ where, data: { status: 'BLOCKED' } });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Attribution de conversion (ROI)
// ---------------------------------------------------------------------------

/**
 * Attribue une commande à la campagne d'origine du client (calcul du ROI).
 * Appelé par le flux commande : si le client vient d'une campagne
 * (isFromCtwa, ou contact actif dans les 7 derniers jours), incrémente
 * totalOrders et revenueGenerated.
 */
export async function trackCampaignConversion(phoneNumber: string, orderId: string): Promise<void> {
  const phone = normalizePhone(phoneNumber);
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const contact = await prisma.campaignContact.findFirst({
    where: {
      phoneNumber: phone,
      campaign: { status: { in: ['ACTIVE', 'COMPLETED'] } },
      OR: [{ isFromCtwa: true }, { sentAt: { gte: since } }],
    },
    orderBy: { sentAt: 'desc' },
  });
  if (!contact) return;

  await prisma.campaign.update({
    where: { id: contact.campaignId },
    data: { totalOrders: { increment: 1 }, revenueGenerated: { increment: order.total } },
  });
  logger.info(
    `Conversion campagne ${contact.campaignId} : commande ${orderId} (${order.total} FCFA) → ${phone}`,
  );
}

// ---------------------------------------------------------------------------
// Accès dashboard
// ---------------------------------------------------------------------------

/** Score qualité actuel + tier + limites (GET /api/campaigns/quality). */
export async function getQualitySnapshot(merchantId: string): Promise<QualityCheck> {
  return checkQualityBeforeSend(merchantId);
}

/** Campagne par id. */
export async function getCampaignById(id: string): Promise<Campaign | null> {
  const row = await prisma.campaign.findUnique({ where: { id } });
  return row ? toCampaign(row) : null;
}

/** Stats détaillées d'une campagne (GET /api/campaigns/:id/stats). */
export async function getCampaignStats(id: string): Promise<{
  campaign: Campaign;
  contacts: { status: string; count: number }[];
} | null> {
  const campaign = await getCampaignById(id);
  if (!campaign) return null;
  const grouped = await prisma.campaignContact.groupBy({
    by: ['status'],
    where: { campaignId: id },
    _count: { _all: true },
  });
  return {
    campaign,
    contacts: grouped.map((g) => ({ status: g.status, count: g._count._all })),
  };
}

/** Merchant id par défaut (mono-commerçant) — utilisée par les routes. */
export function defaultMerchantId(): string {
  return SINGLE_TENANT_MERCHANT_ID;
}



