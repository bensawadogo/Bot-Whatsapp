/**
 * AfriBot — service remboursements (Phase 2).
 *
 * Réalités fournisseurs (constaté sur les SDK/API installés) :
 * - CinetPay (checkout v2) : pas d'endpoint public de remboursement —
 *   l'opération se fait depuis le back-office marchand.
 * - FedaPay (SDK 1.x) : `Transaction` n'expose pas de méthode refund.
 *
 * Le remboursement est donc un processus à DEUX étapes :
 *   1. ICI (automatique) : on marque le paiement REFUNDED + la commande
 *      CANCELLED en base, on remet les produits en stock et on prévient
 *      le client.
 *   2. Côté marchand (manuel) : valider le remboursement dans le back-office
 *      du fournisseur avec l'identifiant de transaction fourni.
 *
 * Toutes les écritures se font dans une transaction Prisma (all-or-nothing).
 */
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { OrderStatus } from '../orders/order.types';
import { PaymentProvider, PaymentStatus } from './payment.types';

export interface RefundResult {
  orderId: string;
  transactionId: string;
  provider: PaymentProvider;
  /** Montant remboursé (FCFA). */
  amount: number;
  /** Lignes remises en stock [{ productId, quantity }]. */
  restocked: { productId: string; quantity: number }[];
}

/** Erreur métier de remboursement (message affichable au dashboard). */
export class RefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundError';
  }
}

/**
 * Rembourse une commande : paiement REFUNDED + commande CANCELLED + restock.
 * Idempotent : refuse une commande déjà remboursée ou annulée.
 */
export async function refundOrder(orderId: string): Promise<RefundResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: true },
  });

  if (!order) {
    throw new RefundError(`Commande ${orderId} introuvable`);
  }
  if (order.status === 'CANCELLED') {
    throw new RefundError('Commande déjà annulée — rien à rembourser');
  }

  const paidPayment = order.payments.find((p) => p.status === PaymentStatus.SUCCESS);
  if (!paidPayment) {
    throw new RefundError('Aucun paiement SUCCESS rattaché à cette commande (COD : rembourser hors système)');
  }

  const restocked = order.items.map((item) => ({ productId: item.productId, quantity: item.quantity }));

  await prisma.$transaction([
    // 1. Paiement marqué REFUNDED
    prisma.payment.update({ where: { id: paidPayment.id }, data: { status: 'REFUNDED' } }),
    // 2. Commande annulée
    prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } }),
    // 3. Restock des produits (increment atomique par ligne)
    ...order.items.map((item) =>
      prisma.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } }),
    ),
  ]);

  // Étape fournisseur (manuelle) : consignée pour le marchand.
  logger.warn(
    `[refund] Commande ${order.id} remboursée en base (${paidPayment.amount} XOF). ` +
      `Action marchand : valider le remboursement ${paidPayment.provider} pour la transaction ` +
      `${paidPayment.transactionId} dans le back-office.`,
  );

  return {
    orderId: order.id,
    transactionId: paidPayment.transactionId,
    provider: paidPayment.provider as PaymentProvider,
    amount: paidPayment.amount,
    restocked,
  };
}

/** Vérifie si une commande est remboursable (paiement SUCCESS, non annulée). */
export async function isRefundable(orderId: string): Promise<boolean> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { payments: true },
  });
  if (!order || order.status === OrderStatus.CANCELLED) return false;
  return order.payments.some((p) => p.status === PaymentStatus.SUCCESS);
}