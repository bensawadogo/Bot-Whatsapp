/**
 * AfriBot — service commandes (persistance PostgreSQL via Prisma).
 *
 * La création de commande est transactionnelle : contrôle de stock,
 * création de la commande + lignes, décrément du stock — tout réussit ou
 * tout est annulé (rollback Prisma automatique en cas de throw).
 */
import { prisma } from '../../config/database';
import type { OrderStatus as PrismaOrderStatus, PaymentMethod as PrismaPaymentMethod } from '@prisma/client';

import { logger } from '../../config/logger';
import type { CreateOrderDto, Order, OrderItem, OrderStatus } from './order.types';
import { PaymentMethod } from './order.types';

/**
 * Mappe l'enum métier vers l'enum Prisma (mêmes valeurs, types distincts).
 */
function toPrismaPaymentMethod(method: PaymentMethod): PrismaPaymentMethod {
  return (method === PaymentMethod.COD ? 'COD' : 'MOBILE_MONEY') as PrismaPaymentMethod;
}

function toTsOrderStatus(status: string): OrderStatus {
  return status as OrderStatus;
}

/** Mappe une commande Prisma (avec lignes) vers le type métier Order. */
function toOrder(row: {
  id: string;
  phoneNumber: string;
  total: number;
  status: string;
  paymentMethod: string;
  address: string;
  createdAt: Date;
  items: { productId: string; quantity: number; unitPrice: number }[];
}): Order {
  const items: OrderItem[] = row.items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
  }));
  return {
    id: row.id,
    phoneNumber: row.phoneNumber,
    items,
    total: row.total,
    status: toTsOrderStatus(row.status),
    paymentMethod: row.paymentMethod as PaymentMethod,
    address: row.address,
    createdAt: row.createdAt,
  };
}

/** Erreur métier : stock insuffisant pour un produit. */
export class InsufficientStockError extends Error {
  constructor(productName: string, requested: number, available: number) {
    super(`Stock insuffisant pour "${productName}" : ${requested} demandé(s), ${available} disponible(s)`);
    this.name = 'InsufficientStockError';
  }
}

/** Erreur métier : commande introuvable. */
export class OrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Commande introuvable : ${orderId}`);
    this.name = 'OrderNotFoundError';
  }
}

/**
 * Crée une commande (statut initial PENDING) et la persiste.
 * Transaction : vérification de stock + création + décrément du stock.
 */
export async function createOrder(data: CreateOrderDto): Promise<Order> {
  return prisma.$transaction(async (tx) => {
    // 1. Contrôle de stock pour tous les produits en une requête
    const productIds = data.items.map((item) => item.productId);
    const products = await tx.product.findMany({ where: { id: { in: productIds } } });
    const byId = new Map(products.map((product) => [product.id, product]));

    for (const item of data.items) {
      if (!byId.has(item.productId)) {
        throw new Error(`Produit introuvable : ${item.productId}`);
      }
    }

    // 2. Création de la commande + lignes + décrément du stock (atomique)
    const total = data.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const created = await tx.order.create({
      data: {
        phoneNumber: data.phoneNumber,
        total,
        status: 'PENDING',
        paymentMethod: toPrismaPaymentMethod(data.paymentMethod),
        address: data.address,
        items: {
          create: data.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
      include: { items: true },
    });

    for (const item of data.items) {
      const product = byId.get(item.productId);
      const result = await tx.product.updateMany({
        where: { id: item.productId, stock: { gte: item.quantity } },
        data: { stock: { decrement: item.quantity } },
      });
      if (result.count === 0) {
        const refreshed = await tx.product.findUnique({ where: { id: item.productId }, select: { stock: true } });
        throw new InsufficientStockError(product?.name ?? item.productId, item.quantity, refreshed?.stock ?? 0);
      }
    }

    logger.info(`Commande ${created.id} créée (${total} FCFA, ${data.paymentMethod}) pour ${data.phoneNumber}`);
    return toOrder(created);
  });
}

/** Retourne une commande par son identifiant, ou null si introuvée. */
export async function getOrderById(id: string): Promise<Order | null> {
  const row = await prisma.order.findUnique({ where: { id }, include: { items: true } });
  return row ? toOrder(row) : null;
}

/** Met à jour le statut d'une commande (CONFIRMED → PAID → DELIVERED...). */
export async function updateOrderStatus(id: string, status: OrderStatus): Promise<void> {
  const existing = await prisma.order.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new OrderNotFoundError(id);
  await prisma.order.update({
    where: { id },
    data: { status: status as PrismaOrderStatus },
  });
  logger.info(`Commande ${id} → ${status}`);
}

/** Résultat paginé pour l'API REST du dashboard. */
export interface PaginatedOrders {
  orders: Order[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Liste paginée des commandes (dashboard), filtres optionnels statut + numéro.
 * Tri décroissant par date de création (les plus récentes d'abord).
 */
export async function listOrders(options: {
  status?: OrderStatus | undefined;
  phoneNumber?: string | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}): Promise<PaginatedOrders> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));

  const where = {
    ...(options.status && { status: options.status as PrismaOrderStatus }),
    ...(options.phoneNumber && { phoneNumber: options.phoneNumber }),
  };

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { items: true },
    }),
    prisma.order.count({ where }),
  ]);

  return {
    orders: rows.map(toOrder),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Résolve une commande par référence COURTE (8 premiers caractères de l'id).
 * Utilisée quand un humain tape « VALIDER 1a2b3c4d » ou « LIVRÉ 1a2b3c4d »
 * (une référence complète de 25 caractères est impraticable sur WhatsApp).
 *
 * Garde-fou anti-collision : un préfixe trop court ou ambigu (plusieurs
 * commandes commencent par le même préfixe) renvoie null — on ne devine pas.
 */
export async function findOrderByIdPrefix(prefix: string): Promise<Order | null> {
  const ref = prefix.trim().toLowerCase();
  if (ref.length < 8) return null;

  const matches = await prisma.order.findMany({
    where: { id: { startsWith: ref } },
    orderBy: { createdAt: 'desc' },
    include: { items: true },
    take: 2, // enough to detect ambiguity without loading the whole table
  });

  if (matches.length === 0) return null;
  if (matches.length > 1) return null; // ambiguous prefix → refuse to guess
  return toOrder(matches[0]);
}
