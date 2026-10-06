/**
 * AfriBot — service livraison (persistance PostgreSQL via Prisma) — MODULE 1.
 *
 * Toutes les fonctions sont sans effet de bord conversationnel : elles ne
 * parlent PAS à WhatsApp. La logique de conversation (envoi de messages,
 * transitions) vit dans `delivery.module.ts`.
 */
import type { DeliveryStatus as PrismaDeliveryStatus } from '@prisma/client';

import { prisma } from '../../config/database';
import { redis } from '../../config/redis';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import {
  DeliveryStatus,
  type AssignDeliveryOptions,
  type CreateLivreurDto,
  type Delivery,
  type DeliveryListItem,
  type Livreur,
} from './delivery.types';

/** Durée de vie du cache Redis « ce numéro est-il un livreur ? » (5 min). */
const LIVREUR_CACHE_TTL_SECONDS = 300;

/** Statuts pour lesquels une livraison est considérée « en cours ». */
const ACTIVE_DELIVERY_STATUSES: PrismaDeliveryStatus[] = [
  DeliveryStatus.ASSIGNED as PrismaDeliveryStatus,
  DeliveryStatus.PICKED_UP as PrismaDeliveryStatus,
  DeliveryStatus.EN_ROUTE as PrismaDeliveryStatus,
];

// ---------------------------------------------------------------------------
// Cache Redis « ce numéro est-il un livreur ? » (utilisé par ConversationRouter)
// ---------------------------------------------------------------------------

/**
 * Clé Redis de détection livreur. Préfixe fourni par `REDIS_PREFIX`
 * (aligné sur le reste de l'app : `{prefix}...`).
 */
function livreurCacheKey(phone: string): string {
  return `${config.redis.prefix}livreur:${normalizePhone(phone)}`;
}

/**
 * Vrai si le numéro appartient à un livreur ACTIF. Cache Redis 5 min
 * (clé `{prefix}livreur:{phone}`) pour ne pas interroger PostgreSQL à chaque
 * message. `force=true` court-circuite le cache (après ajout/suppression).
 */
export async function isRegisteredLivreur(phone: string, force = false): Promise<boolean> {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;

  const key = livreurCacheKey(normalized);
  try {
    if (!force) {
      const cached = await redis.get(key);
      if (cached !== null) return cached === '1';
    }
    const row = await prisma.livreur.findUnique({
      where: { phone: normalized },
      select: { isActive: true },
    });
    const isLivreur = row?.isActive === true;
    // '0' est mis en cache aussi : évite le martèlement PostgreSQL par les
    // messages répétés d'un client qui n'est pas livreur.
    await redis.set(key, isLivreur ? '1' : '0', 'EX', LIVREUR_CACHE_TTL_SECONDS);
    return isLivreur;
  } catch (err) {
    // Redis/PostgreSQL indisponible → on ne bloque pas le flux client
    logger.warn(`Détection livreur ${normalized} échouée : ${String(err)}`);
    return false;
  }
}

/** Invalide le cache de détection pour un numéro (ajout/désactivation livreur). */
export async function invalidateLivreurCache(phone: string): Promise<void> {
  try {
    await redis.del(livreurCacheKey(phone));
  } catch (err) {
    logger.debug(`Invalidation cache livreur ${phone} échouée : ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Normalisation des numéros
// ---------------------------------------------------------------------------

/**
 * Normalise un numéro WhatsApp : retire « + », espaces, tirets et le suffixe
 * `@s.whatsapp.net`. C'est la forme stockée dans `Livreur.phone` (UNIQUE).
 */
export function normalizePhone(phone: string): string {
  return phone
    .trim()
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/[^\d]/g, '');
}

/** Extrait la référence de commande d'une réponse « LIVRÉ <orderId> » (8 car.). */
export function extractOrderIdReference(text: string): string | null {
  const match = text.trim().match(/[0-9a-f]{8}/i);
  return match ? match[0].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Mappers Prisma → types métier
// ---------------------------------------------------------------------------

interface DeliveryRow {
  id: string;
  orderId: string;
  livreurId: string | null;
  status: string;
  livreurPhone: string | null;
  customerPhone: string;
  deliveryAddress: string;
  estimatedTime: number | null;
  proofPhoto: string | null;
  failureReason: string | null;
  codAmount: number | null;
  codCollected: boolean;
  notes: string | null;
  assignedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    orderId: row.orderId,
    livreurId: row.livreurId,
    status: row.status as DeliveryStatus,
    livreurPhone: row.livreurPhone,
    customerPhone: row.customerPhone,
    deliveryAddress: row.deliveryAddress,
    estimatedTime: row.estimatedTime,
    proofPhoto: row.proofPhoto,
    failureReason: row.failureReason,
    codAmount: row.codAmount,
    codCollected: row.codCollected,
    notes: row.notes,
    assignedAt: row.assignedAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface LivreurRow {
  id: string;
  merchantId: string;
  name: string;
  phone: string;
  zone: string | null;
  isActive: boolean;
  isAvailable: boolean;
  totalDeliveries: number;
  createdAt: Date;
}

function toLivreur(row: LivreurRow): Livreur {
  return {
    id: row.id,
    merchantId: row.merchantId,
    name: row.name,
    phone: row.phone,
    zone: row.zone,
    isActive: row.isActive,
    isAvailable: row.isAvailable,
    totalDeliveries: row.totalDeliveries,
    createdAt: row.createdAt,
  };
}
// ---------------------------------------------------------------------------
// Livreurs
// ---------------------------------------------------------------------------

/** Retourne le livreur actif correspondant à un numéro WhatsApp, ou null. */
export async function findLivreurByPhone(phone: string): Promise<Livreur | null> {
  const row = await prisma.livreur.findUnique({ where: { phone: normalizePhone(phone) } });
  if (!row || !row.isActive) return null;
  return toLivreur(row);
}

/** Tous les livreurs d'un commerçant (actifs en premier, puis par nom). */
export async function listLivreurs(merchantId: string): Promise<Livreur[]> {
  const rows = await prisma.livreur.findMany({
    where: { merchantId },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
  return rows.map(toLivreur);
}

/** Crée un livreur. Le numéro est normalisé et unique par déploiement. */
export async function createLivreur(dto: CreateLivreurDto): Promise<Livreur> {
  const row = await prisma.livreur.create({
    data: {
      merchantId: dto.merchantId,
      name: dto.name.trim(),
      phone: normalizePhone(dto.phone),
      zone: dto.zone?.trim() ?? null,
    },
  });
  logger.info(`Livreur créé : ${row.name} (${row.phone})`);
  await invalidateLivreurCache(row.phone);
  return toLivreur(row);
}

/** Soft delete : désactive le livreur (l'historique des livraisons est conservé). */
export async function deactivateLivreur(id: string): Promise<Livreur | null> {
  const existing = await prisma.livreur.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return null;
  const row = await prisma.livreur.update({
    where: { id },
    data: { isActive: false, isAvailable: false },
  });
  logger.info(`Livreur désactivé : ${row.name} (${row.phone})`);
  await invalidateLivreurCache(row.phone);
  return toLivreur(row);
}

/** Bascule la disponibilité d'un livreur (« DISPO » / « INDISPO » WhatsApp). */
export async function setLivreurAvailability(phone: string, isAvailable: boolean): Promise<Livreur | null> {
  const found = await prisma.livreur.findUnique({ where: { phone: normalizePhone(phone) } });
  if (!found) return null;
  const row = await prisma.livreur.update({ where: { id: found.id }, data: { isAvailable } });
  return toLivreur(row);
}

/** Livreurs disponibles maintenant (dashboard : dropdown « Assigner livreur »). */
export async function listAvailableLivreurs(merchantId: string): Promise<Livreur[]> {
  const rows = await prisma.livreur.findMany({
    where: { merchantId, isActive: true, isAvailable: true },
    orderBy: { name: 'asc' },
  });
  return rows.map(toLivreur);
}
// ---------------------------------------------------------------------------
// Livraisons
// ---------------------------------------------------------------------------

/** Livraison d'une commande (clé métier = orderId, unique). */
export async function getDeliveryByOrderId(orderId: string): Promise<Delivery | null> {
  const row = await prisma.delivery.findUnique({ where: { orderId } });
  return row ? toDelivery(row) : null;
}

/** Livraison par identifiant interne. */
export async function getDeliveryById(id: string): Promise<Delivery | null> {
  const row = await prisma.delivery.findUnique({ where: { id } });
  return row ? toDelivery(row) : null;
}

/**
 * Crée (ou remet à jour) la livraison d'une commande puis l'assigne à un
 * livreur. Idempotent : ré-appeler avec la même commande remplace le livreur
 * au lieu de créer un doublon (contrainte `orderId` UNIQUE).
 */
export async function upsertAssignedDelivery(input: {
  orderId: string;
  customerPhone: string;
  deliveryAddress: string;
  livreurId: string | null;
  livreurPhone: string;
  codAmount: number | null;
  options?: AssignDeliveryOptions;
}): Promise<Delivery> {
  const shared = {
    livreurId: input.livreurId,
    livreurPhone: input.livreurPhone,
    customerPhone: input.customerPhone,
    deliveryAddress: input.deliveryAddress,
    status: DeliveryStatus.ASSIGNED as PrismaDeliveryStatus,
    codAmount: input.codAmount,
    estimatedTime: input.options?.estimatedTime ?? null,
    notes: input.options?.notes ?? null,
    assignedAt: new Date(),
    failureReason: null,
  };

  const row = await prisma.delivery.upsert({
    where: { orderId: input.orderId },
    create: { orderId: input.orderId, ...shared },
    update: shared,
  });
  logger.info(`Livraison ${row.id} → ASSIGNED (commande ${input.orderId}, livreur ${input.livreurPhone})`);
  return toDelivery(row);
}

/** Change le statut d'une livraison (+ champs optionnels associés). */
export async function updateDeliveryStatus(
  id: string,
  status: DeliveryStatus,
  extra?: {
    failureReason?: string | undefined;
    proofPhoto?: string | undefined;
    codCollected?: boolean | undefined;
    deliveredAt?: Date | undefined;
  },
): Promise<Delivery | null> {
  const existing = await prisma.delivery.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return null;

  const row = await prisma.delivery.update({
    where: { id },
    data: {
      status: status as PrismaDeliveryStatus,
      ...(extra?.failureReason !== undefined && { failureReason: extra.failureReason }),
      ...(extra?.proofPhoto !== undefined && { proofPhoto: extra.proofPhoto }),
      ...(extra?.codCollected !== undefined && { codCollected: extra.codCollected }),
      ...(extra?.deliveredAt !== undefined && { deliveredAt: extra.deliveredAt }),
    },
  });
  logger.info(`Livraison ${row.id} → ${status}`);
  return toDelivery(row);
}

/**
 * Livraison de la commande `orderId` appartenant à ce livreur — garde-fou :
 * un livreur ne peut confirmer qu'une commande qui lui a été assignée.
 */
export async function findDeliveryForLivreur(livreurPhone: string, orderId: string): Promise<Delivery | null> {
  const row = await prisma.delivery.findUnique({ where: { orderId } });
  if (!row) return null;
  const livreur = normalizePhone(livreurPhone);
  const owned = row.livreurPhone !== null && normalizePhone(row.livreurPhone) === livreur;
  return owned ? toDelivery(row) : null;
}

/** Livraisons en cours (ASSIGNED / PICKED_UP / EN_ROUTE) — dashboard. */
export async function listActiveDeliveries(): Promise<DeliveryListItem[]> {
  const rows = await prisma.delivery.findMany({
    where: { status: { in: ACTIVE_DELIVERY_STATUSES } },
    orderBy: { assignedAt: 'desc' },
    include: {
      livreur: { select: { name: true } },
      order: {
        select: {
          total: true,
          status: true,
          items: { select: { quantity: true, product: { select: { name: true } } } },
        },
      },
    },
  });

  return rows.map((row) => ({
    ...toDelivery(row),
    livreurName: row.livreur?.name ?? null,
    orderTotal: row.order.total,
    orderStatus: row.order.status,
    customerItems: row.order.items.map((item) => ({
      productName: item.product.name,
      quantity: item.quantity,
    })),
  }));
}

/** Incrémente le compteur de livraisons réussies d'un livreur. */
export async function incrementLivreurDeliveries(livreurId: string): Promise<void> {
  await prisma.livreur.update({
    where: { id: livreurId },
    data: { totalDeliveries: { increment: 1 } },
  });
}

/**
 * Livraison active la plus récente de ce livreur — cible des réponses
 * « OUI » / « NON » / « EN ROUTE » (le livreur n'a pas à retaper un numéro).
 */
export async function findActiveDeliveryForLivreur(livreurPhone: string): Promise<Delivery | null> {
  const row = await prisma.delivery.findFirst({
    where: {
      livreurPhone: normalizePhone(livreurPhone),
      status: { in: ACTIVE_DELIVERY_STATUSES },
    },
    orderBy: { assignedAt: 'desc' },
  });
  return row ? toDelivery(row) : null;
}